/**
 * Run one ZX81 title headlessly and write PNG screenshots.
 *
 *   node node_modules/tsx/dist/cli.mjs tools/zx81-shot.ts <zip-or-p> <outPrefix>
 *       [--file=NAME.P] [--at=100,300,800] [--keys=Enter@200,Space@400] [--ram=16|1]
 *       [--board=wrx|udg|udg128|memotech|quicksilva] [--model=zx81|ts1000]
 *
 * A shot is written at each `--at` frame as `<outPrefix>-<frame>.png`; the OCR
 * text and the CPU position are printed alongside. `--keys` taps a key (KeyboardEvent
 * code) at a frame: `Enter@200` holds it for 6 frames.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import type { Zx8xModel } from '@/machines/zx8x/models.ts';
import { unzip } from '@/media/zip.ts';
import { encodePNG } from '../mcp/png.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [input, prefix] = args.filter(a => !a.startsWith('--'));
if (!input || !prefix) { console.error('usage: zx81-shot <zip|p> <outPrefix> [--file= --at= --keys= --ram= --board= --model=]'); process.exit(2); }

const DIR = process.env.ZX8X_ROM_DIR ?? resolve(process.cwd(), 'mcp/.cache');
const model = (flag('model') ?? 'zx81') as Zx8xModel;
const board = flag('board');
const s: Record<string, boolean> = {};
if ((flag('ram') ?? '16') === '16') s['zx8x-16k-ram'] = true;
if (board === 'wrx') s['zx81-wrx-hires'] = true;
if (board === 'udg') s['zx81-udg-ram'] = true;
if (board === 'udg128') s['zx81-udg128-ram'] = true;
if (board === 'memotech') s['zx81-memotech-hrg'] = true;
if (board === 'quicksilva') s['zx81-quicksilva-hrg'] = true;

const m = new Zx8xMachine(model);
m.prepare({ get: <T>(k: string, f: T): T => (k in s ? s[k] as T : f) });
m.loadROM(new Uint8Array(readFileSync(join(DIR, 'zx81-v2.rom'))));
m.reset();

let name = basename(input);
let data = new Uint8Array(readFileSync(input));
let archive: { name: string; data: Uint8Array }[] = [];
if (/\.zip$/i.test(input)) {
  const entries = await unzip(data, ['.p', '.81', '.p81']);
  if (!flag('file')) archive = entries;
  const want = flag('file');
  const e = want ? entries.find(x => x.name.toLowerCase() === want.toLowerCase()) : entries[0];
  if (!e) { console.error('no such entry; have', entries.map(x => x.name).join(', ')); process.exit(1); }
  name = e.name; data = e.data;
}
const res = (archive.length > 1 ? await m.services.media!.mountArchive?.(archive, basename(input)) : null) ?? await m.services.media!.mount(data, name);
console.log('mount:', res.ok, res.message);

const at = (flag('at') ?? '100,400').split(',').map(Number);
const keys = (flag('keys') ?? '').split(',').filter(Boolean).map(k => { const [code, f] = k.split('@'); return { code, frame: Number(f) }; });
const last = Math.max(...at);
for (let f = 0; f <= last; f++) {
  for (const k of keys) {
    if (f === k.frame) m.keyboard.handleKeyEvent(k.code, true);
    if (f === k.frame + 6) m.keyboard.handleKeyEvent(k.code, false);
  }
  m.tick();
  if (at.includes(f)) {
    const mem = new Uint8Array(0x10000);
    for (let a = 0; a < 0x10000; a++) mem[a] = m.memory.readByte(a);
    const text = m.screenText.ocr(mem, m.model).split('\n').filter(l => l.trim()).join('\n');
    const file = `${prefix}-${f}.png`;
    writeFileSync(file, encodePNG(m.pixels, m.frameWidth, m.frameHeight));
    const w = (a: number): string => (m.memory.readByte(a) | (m.memory.readByte(a + 1) << 8)).toString(16);
    console.log(`--- frame ${f}: pc=${m.cpu.pc.toString(16)} sp=${m.cpu.sp.toString(16)} err=${m.memory.readByte(0x4000)} ramtop=${w(0x4004)} dfile=${w(0x400c)} dfcc=${w(0x400e)} eline=${w(0x4014)} stkbot=${w(0x401a)} stkend=${w(0x401c)} -> ${file}\n${text}`);
  }
}

if (flag('stack')) {
  const sp = m.cpu.sp;
  const words: string[] = [];
  for (let a = sp; a < 0x8000 && words.length < Number(flag('stack')); a += 2) words.push((m.memory.readByte(a) | (m.memory.readByte(a + 1) << 8)).toString(16).padStart(4, '0'));
  console.log(`stack from ${sp.toString(16)}: ${words.join(' ')}`);
}
