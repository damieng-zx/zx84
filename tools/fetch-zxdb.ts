/**
 * fetch-zxdb.ts — download the latest ZXDB MySQL dump from GitHub, inflate it,
 * convert it to SQLite, and load just the tables the catalog needs into a local
 * `tools/zxdb.sqlite`.
 *
 *   npm run catalog:db
 *   tsx tools/fetch-zxdb.ts [--branch master] [--url <zip>] [--keep-zip]
 *
 * Pure Node — no Python, no sqlite3 CLI, no DB server. Uses `fetch`,
 * `node:zlib` (inflate the zip), `node:readline` (stream the SQL), and the
 * built-in `node:sqlite` (Node ≥ 22.5). The companion `npm run catalog:json`
 * (tools/build-catalog.ts) reads the SQLite this writes.
 *
 * ZXDB ships a MySQL dump; we convert it on the fly (port of the transforms in
 * ZXDB's scripts/ZXDB_to_SQLite.py) and keep only these tables:
 */
const WANTED = new Set([
  'entries', 'machinetypes', 'releases', 'publishers', 'labels', 'genretypes', 'downloads',
  // `members` + `tags` carry ZXDB's tag memberships, which build-zx8x-catalog
  // reads for the ZX81 Enhanced Graphics flags. Without them that build dies
  // with "SQL logic error" on a freshly fetched database.
  'members', 'tags',
]);

import { DatabaseSync } from 'node:sqlite';
import { createReadStream, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { createInflateRaw } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const HERE = dirname(fileURLToPath(import.meta.url));
const BRANCH = arg('branch', 'master');
const ZIP_URL = arg('url', `https://raw.githubusercontent.com/zxdb/ZXDB/${BRANCH}/ZXDB_mysql.sql.zip`);
const ZIP_PATH = resolve(HERE, 'ZXDB_mysql.sql.zip');
const DB_PATH = resolve(HERE, 'zxdb.sqlite');

// ── 1. Download ───────────────────────────────────────────────────────────

async function download(): Promise<void> {
  console.log(`↓ ${ZIP_URL}`);
  const resp = await fetch(ZIP_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${ZIP_URL}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  // A Git-LFS-tracked file served via raw.githubusercontent returns a tiny text
  // pointer rather than the zip — catch that so the failure is legible.
  if (buf.length < 1000 && buf.toString('latin1', 0, 64).includes('git-lfs')) {
    throw new Error('Got a Git LFS pointer instead of the zip — download ZXDB_mysql.sql.zip manually and pass --url file://…');
  }
  writeFileSync(ZIP_PATH, buf);
  console.log(`  ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

// ── 2. Locate the .sql entry inside the zip (central directory) ────────────

interface ZipEntry { name: string; method: number; compressedSize: number; dataStart: number; }

function locateSqlEntry(): ZipEntry {
  const buf = readFileSync(ZIP_PATH);
  // End of Central Directory: scan back for signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip (no EOCD record)');
  const total = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;       // central dir header
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('latin1', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (!name.toLowerCase().endsWith('.sql')) continue;
    // Resolve the local header to find where the entry's data actually starts.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    return { name, method, compressedSize, dataStart };
  }
  throw new Error('No .sql entry found in the zip');
}

// ── 3. MySQL → SQLite line transforms (port of ZXDB_to_SQLite.py) ──────────

// Schema lines: strip MySQL-isms SQLite can't parse.
function transformSchema(s: string): string {
  return s
    .replace(/CHARACTER SET utf8/g, '')
    .replace(/utf8_bin/g, 'rtrim')               // map to SQLite's built-in RTRIM collation
    .replace(/utf8_unicode_ci/g, 'rtrim')
    .replace(/AUTO_INCREMENT/g, '')
    // `int(N) unsigned` → INTEGER. Intentionally un-anchored: it also catches the
    // `int(N) unsigned` *inside* smallint/tinyint/bigint, consuming the trailing
    // `unsigned` that SQLite would otherwise reject (e.g. smallint(5) unsigned).
    .replace(/int\s*\(\d+\)\s+unsigned/gi, 'INTEGER');
}

// Value rows: MySQL escapes → SQLite escapes (quote doubling; collapse `\\`).
function unescapeValues(s: string): string {
  return s.replace(/\\'/g, "''").replace(/\\\\/g, '\\');
}

// Drop index/constraint lines inside CREATE — we only need columns for SELECTs.
const CONSTRAINT_RE = /^(PRIMARY\s+KEY|UNIQUE|KEY|CONSTRAINT|INDEX|FULLTEXT|FOREIGN|SPATIAL)\b/i;
const CREATE_RE = /^CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(/i;
const INSERT_RE = /^INSERT INTO\s+(\w+)\s/i;
const endsStmt = (line: string) => /;\s*$/.test(line);
const isCreateEnd = (line: string) => /^\)/.test(line.trimStart());

// ── 4. Convert + load ──────────────────────────────────────────────────────

async function convertAndLoad(entry: ZipEntry): Promise<void> {
  for (const ext of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(DB_PATH + ext)) rmSync(DB_PATH + ext);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
  db.exec('BEGIN');

  const range = createReadStream(ZIP_PATH, { start: entry.dataStart, end: entry.dataStart + entry.compressedSize - 1 });
  const input = entry.method === 0 ? range : range.pipe(createInflateRaw());
  const rl = createInterface({ input, crlfDelay: Infinity });

  type Mode = 'idle' | 'skipCreate' | 'keepCreate' | 'skipInsert' | 'keepInsert';
  let mode: Mode = 'idle';
  let header = true;
  let createName = '';
  let createCols: string[] = [];
  let stmt: string[] = [];
  let kept = 0;

  for await (const line of rl) {
    if (header) { if (line.startsWith('USE')) header = false; continue; }

    switch (mode) {
      case 'idle': {
        const noBt = line.replace(/`/g, '');
        const mc = CREATE_RE.exec(noBt);
        if (mc) { createName = mc[1]; createCols = []; mode = WANTED.has(createName) ? 'keepCreate' : 'skipCreate'; break; }
        const mi = INSERT_RE.exec(noBt);
        if (mi) {
          if (WANTED.has(mi[1])) { stmt = [noBt]; mode = 'keepInsert'; }   // first line: INSERT INTO t (cols) VALUES
          else mode = endsStmt(line) ? 'idle' : 'skipInsert';
        }
        break;   // comments / blank / SET / ALTER-KEYS lines: drop
      }
      case 'skipCreate': if (isCreateEnd(line)) mode = 'idle'; break;
      case 'keepCreate': {
        if (isCreateEnd(line)) {
          db.exec(`CREATE TABLE ${createName} (\n  ${createCols.join(',\n  ')}\n);`);
          mode = 'idle';
          break;
        }
        let col = transformSchema(line.replace(/`/g, '')).trim();
        if (col.endsWith(',')) col = col.slice(0, -1).trimEnd();
        if (col && !CONSTRAINT_RE.test(col)) createCols.push(col);
        break;
      }
      case 'skipInsert': if (endsStmt(line)) mode = 'idle'; break;
      case 'keepInsert': {
        // Value rows: only unescape — do NOT strip backticks (a data value may
        // legitimately contain one).
        stmt.push(unescapeValues(line));
        if (endsStmt(line)) { db.exec(stmt.join('\n')); stmt = []; kept++; mode = 'idle'; }
        break;
      }
    }
  }

  db.exec('COMMIT');

  // Sanity summary.
  for (const t of ['entries', 'downloads', 'releases', 'publishers', 'labels', 'genretypes', 'machinetypes']) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
    console.log(`  ${t.padEnd(13)} ${row.n}`);
  }
  db.close();
  console.log(`  (${kept} INSERT statements)`);
  console.log(`✓ ${DB_PATH}  (${(statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB)`);
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await download();
  const entry = locateSqlEntry();
  console.log(`unzip + convert ${entry.name} → SQLite (${[...WANTED].join(', ')})`);
  await convertAndLoad(entry);
  if (!hasFlag('keep-zip')) rmSync(ZIP_PATH, { force: true });
}

main().catch((err) => { console.error(String(err?.stack ?? err)); process.exit(1); });
