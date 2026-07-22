/** Build the ZX80/ZX81 half of the ZXDB-backed software browser. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ZX81_ENHANCED_GRAPHICS_TAG,
  zx81HiResModeForTags,
  zx8xHardwareOverride,
} from '../src/library/zx8x-hardware.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_FILE = resolve(HERE, 'zxdb.sqlite');
const OUT = resolve(HERE, 'out');

interface MetaRow {
  id: number; title: string; machine: string; year: number | null;
  genre: string | null; publisher: string | null;
}
interface FileRow { id: number; link: string; ft: number; rel: number | null; lang: string | null; }
interface GraphicsRow { id: number; tagId: number; name: string; }
interface RawGame {
  i: number; t: string; m: 80 | 81; y?: number; g?: number; p?: number;
  f: string; s?: string; r?: number; h?: 's' | 'u' | 'w'; x?: number[];
}

const PROGRAM = /\.(o|80|p|81|p81)(\.zip)?$/i;
const SCREEN = /\.(gif|png|jpe?g)$/i;

function main(): void {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  const machineWhere = `(m.text LIKE 'ZX80%' OR m.text LIKE 'ZX81%')`;
  const meta = db.prepare(
    `SELECT e.id, e.title, m.text AS machine, r.release_year AS year,
            g.text AS genre, l.name AS publisher
       FROM entries e
       JOIN machinetypes m ON m.id=e.machinetype_id AND ${machineWhere}
  LEFT JOIN releases r ON r.entry_id=e.id AND r.release_seq=0
  LEFT JOIN publishers p ON p.entry_id=e.id AND p.release_seq=0 AND p.publisher_seq=1
  LEFT JOIN labels l ON l.id=p.label_id
  LEFT JOIN genretypes g ON g.id=e.genretype_id
      WHERE e.availabletype_id='A' AND e.is_xrated=0`,
  ).all() as unknown as MetaRow[];
  const files = db.prepare(
    `SELECT d.entry_id AS id, d.file_link AS link, d.filetype_id AS ft,
            d.release_seq AS rel, d.language_id AS lang
       FROM downloads d
       JOIN entries e ON e.id=d.entry_id
       JOIN machinetypes m ON m.id=e.machinetype_id AND ${machineWhere}
      WHERE e.availabletype_id='A'`,
  ).all() as unknown as FileRow[];
  const enhancedGraphics = db.prepare(
    `SELECT members.entry_id AS id, tags.id AS tagId, tags.name
       FROM members
       JOIN tags ON tags.id=members.tag_id AND tags.tagtype_id='Z'
       JOIN entries e ON e.id=members.entry_id
       JOIN machinetypes m ON m.id=e.machinetype_id AND ${machineWhere}
      ORDER BY members.entry_id, tags.id`,
  ).all() as unknown as GraphicsRow[];
  db.close();

  const byEntry = new Map<number, FileRow[]>();
  for (const file of files) {
    if (!PROGRAM.test(file.link) && !(file.ft === 1 || file.ft === 2) && !SCREEN.test(file.link)) continue;
    const list = byEntry.get(file.id) ?? [];
    list.push(file);
    byEntry.set(file.id, list);
  }

  const genres: string[] = [];
  const publishers: string[] = [];
  const genreIndex = new Map<string, number>();
  const publisherIndex = new Map<string, number>();
  const graphics: string[] = [];
  const graphicsIndex = new Map<string, number>();
  const intern = (value: string | null, values: string[], index: Map<string, number>): number | undefined => {
    if (!value) return undefined;
    const known = index.get(value);
    if (known !== undefined) return known;
    const next = values.length;
    values.push(value);
    index.set(value, next);
    return next;
  };
  const graphicsByEntry = new Map<number, GraphicsRow[]>();
  for (const feature of enhancedGraphics) {
    const list = graphicsByEntry.get(feature.id) ?? [];
    list.push(feature);
    graphicsByEntry.set(feature.id, list);
  }

  const games: RawGame[] = [];
  for (const row of meta) {
    const candidates = byEntry.get(row.id) ?? [];
    const programs = candidates.filter(file => PROGRAM.test(file.link)).sort((a, b) => {
      const en = Number(b.lang === 'en') - Number(a.lang === 'en');
      if (en) return en;
      return (a.rel ?? 999) - (b.rel ?? 999);
    });
    if (!programs.length) continue;
    const screenshots = candidates.filter(file => (file.ft === 1 || file.ft === 2) && SCREEN.test(file.link));
    screenshots.sort((a, b) => a.ft - b.ft);
    const game: RawGame = { i: row.id, t: row.title, m: row.machine.startsWith('ZX80') ? 80 : 81, f: programs[0].link };
    const ram = /ZX(?:80|81) (\d+)K/.exec(row.machine);
    if (ram) game.r = Number(ram[1]);
    const features = graphicsByEntry.get(row.id) ?? [];
    if (features.length) {
      game.x = features.map(feature => intern(feature.name, graphics, graphicsIndex) as number);
      const mode = zx81HiResModeForTags(features.map(feature => feature.tagId));
      if (mode) game.h = mode === 'software' ? 's' : mode === 'udg' ? 'u' : 'w';
      if (features.some(feature => feature.tagId === ZX81_ENHANCED_GRAPHICS_TAG.wrx1k)) game.r = 1;
    }
    const hardware = zx8xHardwareOverride(row.id);
    if (hardware?.ramKb !== undefined) game.r = hardware.ramKb;
    if (hardware?.hiRes) game.h = hardware.hiRes === 'software' ? 's' : hardware.hiRes === 'udg' ? 'u' : 'w';
    if (row.year) game.y = row.year;
    const genre = intern(row.genre, genres, genreIndex);
    const publisher = intern(row.publisher, publishers, publisherIndex);
    if (genre !== undefined) game.g = genre;
    if (publisher !== undefined) game.p = publisher;
    if (screenshots[0]) game.s = screenshots[0].link;
    games.push(game);
  }
  games.sort((a, b) => a.t.localeCompare(b.t));

  const json = JSON.stringify({ genres, publishers, graphics, games });
  const version = createHash('sha256').update(json).digest('hex').slice(0, 12);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'zx8x-catalog.json'), json);
  writeFileSync(resolve(OUT, 'zx8x-catalog.json.gz'), gzipSync(Buffer.from(json), { level: 9 }));
  writeFileSync(resolve(OUT, 'zx8x-catalog-version.json'), JSON.stringify({ version }));
  console.log(`ZX80/ZX81 games: ${games.length}; version: ${version}`);
}

main();
