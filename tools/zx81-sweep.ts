/**
 * Headless sweep of a ZX81 software collection (TOSEC-style folders of zips)
 * through the real ZX81 ROM, to find titles that misbehave.
 *
 *   node node_modules/tsx/dist/cli.mjs tools/zx81-sweep.ts <root> <out.json> [--filter=text] [--frames=N]
 *       [--ram=16|1] [--board=wrx|udg|udg128|memotech|quicksilva] [--model=zx81|ts1000]
 *
 * Each zip's first program image is mounted the way the app does (fast ROM
 * loading on), run for a number of frames, and sampled. Needs zx81-v2.rom in
 * ZX8X_ROM_DIR or mcp/.cache. Not a pass/fail test: it classifies, and a person
 * (or the follow-up scripts) looks at what comes out.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import type { Zx8xModel } from '@/machines/zx8x/models.ts';
import { unzip } from '@/media/zip.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const [root, outPath] = args.filter(a => !a.startsWith('--'));
if (!root || !outPath) { console.error('usage: zx81-sweep <root> <out.json> [--filter= --frames= --ram= --board= --model=]'); process.exit(2); }

const DIR = process.env.ZX8X_ROM_DIR ?? resolve(process.cwd(), 'mcp/.cache');
const rom = new Uint8Array(readFileSync(join(DIR, 'zx81-v2.rom')));
const frames = Number(flag('frames') ?? 400);
const ram16 = (flag('ram') ?? '16') === '16';
const board = flag('board');
const model = (flag('model') ?? 'zx81') as Zx8xModel;
const filter = flag('filter')?.toLowerCase();
// --typerun: a title that ends at the BASIC prompt ("0/0") gets RUN typed and runs on.
const typeRun = args.includes('--typerun');
// --from=prev.json --status=blank,error: re-run only the titles a previous sweep put in those states.
const from = flag('from');
const statuses = (flag('status') ?? '').split(',').filter(Boolean);
const only = from ? new Set((JSON.parse(readFileSync(from, 'utf8')) as SweepRow[]).filter(r => statuses.length === 0 || statuses.includes(r.status)).map(r => `${r.folder}/${r.zip}`)) : null;

export interface SweepRow {
  folder: string;
  zip: string;
  file: string;
  size: number;
  files: string[];
  status: 'ok' | 'refused' | 'reboot' | 'blank' | 'error' | 'crash';
  note: string;
  errNr: number;
  pc: number;
  reboots: number;
  distinctRows: number;
  screen: string;
  screenEarly: string;
  hires: boolean;
  /** Lowest SP seen at 50-frame samples after frame 100, relative to the SP then (a leak shows as a large drop). */
  spDrop: number;
}

function settings(): { get: <T>(k: string, f: T) => T } {
  const s: Record<string, boolean> = {};
  if (ram16) s['zx8x-16k-ram'] = true;
  if (board === 'wrx') s['zx81-wrx-hires'] = true;
  if (board === 'udg') s['zx81-udg-ram'] = true;
  if (board === 'udg128') s['zx81-udg128-ram'] = true;
  if (board === 'memotech') s['zx81-memotech-hrg'] = true;
  if (board === 'quicksilva') s['zx81-quicksilva-hrg'] = true;
  return { get: <T>(key: string, fallback: T): T => (key in s ? s[key] as T : fallback) };
}

function ocr(m: Zx8xMachine): string {
  const mem = new Uint8Array(0x10000);
  for (let a = 0; a < 0x10000; a++) mem[a] = m.memory.readByte(a);
  return m.screenText.ocr(mem, m.model);
}

const REPORT = /^[0-9A-Z]\/\d+\s*$/m;

async function runOne(folder: string, zip: string, file: string, data: Uint8Array, files: string[], archive: { name: string; data: Uint8Array }[]): Promise<SweepRow> {
  const row: SweepRow = { folder, zip, file, size: data.length, files, status: 'ok', note: '', errNr: -1, pc: 0, reboots: 0, distinctRows: 0, screen: '', screenEarly: '', hires: false, spDrop: 0 };
  const m = new Zx8xMachine(model);
  m.prepare(settings());
  m.loadROM(rom);
  m.reset();
  // Fast ROM loading is the app default.
  // A zip of several programs goes on one tape, as the app mounts it.
  const media = m.services.media!;
  const res = (archive.length > 1 ? await media.mountArchive?.(archive, zip) : null) ?? await media.mount(data, file);
  if (!res.ok) { row.status = 'refused'; row.note = res.message ?? ''; return row; }
  let reboots = 0;
  let prevPc = -1;
  let sp0 = 0;
  const step = m.cpu.step.bind(m.cpu);
  m.cpu.step = (): void => { step(); if (m.cpu.pc === 0 && prevPc !== 0) reboots++; prevPc = m.cpu.pc; };
  try {
    for (let f = 0; f < frames; f++) {
      m.tick();
      if (f === 60) row.screenEarly = ocr(m);
      if (f === 100) sp0 = m.cpu.sp;
      if (f > 100 && f % 50 === 0) row.spDrop = Math.max(row.spDrop, sp0 - m.cpu.sp);
    }
  } catch (e) {
    row.status = 'crash';
    row.note = (e as Error).message;
    return row;
  }
  let typed = false;
  if (typeRun && /^\s*0\/0\s*$/.test(ocr(m))) {
    typed = true;
    for (const k of ['KeyR', 'Enter']) {
      m.keyboard.handleKeyEvent(k, true);
      for (let f = 0; f < 6; f++) m.tick();
      m.keyboard.handleKeyEvent(k, false);
      for (let f = 0; f < 6; f++) m.tick();
    }
    for (let f = 0; f < frames; f++) m.tick();
  }
  row.reboots = reboots;
  row.pc = m.cpu.pc;
  row.errNr = m.memory.readByte(0x4000);
  row.screen = ocr(m);
  const px = m.pixels;
  const w = m.frameWidth;
  let blank = true;
  const base = px[0];
  const rows = new Set<number>();
  for (let i = 0; i < px.length; i++) if (px[i] !== base) { blank = false; rows.add(Math.floor(i / w)); }
  row.distinctRows = rows.size;
  row.hires = row.screen.trim() === '' && !blank;
  if (typed) row.note = 'typed RUN';
  if (reboots > 0) { row.status = 'reboot'; row.note = `${reboots} jumps to 0x0000`; }
  else if (blank) { row.status = 'blank'; }
  else if (row.errNr !== 0xff && row.errNr !== 0x08 && row.errNr !== 0x0c && REPORT.test(row.screen)) {
    row.status = 'error';
    row.note = `report ${(row.errNr + 1).toString(16).toUpperCase()}`;
  }
  return row;
}

const rows: SweepRow[] = [];
const folders = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('Sinclair'));
for (const d of folders) {
  const zips = readdirSync(join(root, d.name)).filter(n => n.toLowerCase().endsWith('.zip')).sort();
  for (const z of zips) {
    if (filter && !z.toLowerCase().includes(filter)) continue;
    if (only && !only.has(`${d.name}/${z}`)) continue;
    let entries;
    try { entries = await unzip(new Uint8Array(readFileSync(join(root, d.name, z))), ['.p', '.81', '.p81']); }
    catch (e) { rows.push({ folder: d.name, zip: z, file: '', size: 0, files: [], status: 'crash', note: `zip: ${(e as Error).message}`, errNr: -1, pc: 0, reboots: 0, distinctRows: 0, screen: '', screenEarly: '', hires: false, spDrop: 0 }); continue; }
    if (entries.length === 0) continue;
    const r = await runOne(d.name, z, entries[0].name, entries[0].data, entries.map(e => e.name), entries);
    rows.push(r);
    if (rows.length % 50 === 0) console.error(`${rows.length} done`);
  }
}
writeFileSync(outPath, JSON.stringify(rows, null, 1));
const counts: Record<string, number> = {};
for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log(`${rows.length} titles`, counts);
if (!existsSync(outPath)) process.exit(1);
