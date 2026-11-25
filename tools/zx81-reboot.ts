/**
 * Find where a ZX81 title throws itself back to the ROM's cold start.
 *
 *   node node_modules/tsx/dist/cli.mjs tools/zx81-reboot.ts <zip-or-p> [--file=NAME.P] [--frames=N] [--trail=N]
 *       [--ram=16|1] [--board=...] [--keys=Enter@200]
 *
 * Runs until the CPU first reaches 0x0000 (after the first 20 frames) and prints
 * the last instructions executed, with registers, so the cause can be read off.
 */

import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import type { Zx8xModel } from '@/machines/zx8x/models.ts';
import { unzip } from '@/media/zip.ts';
import { disasmOne } from '@/debug/z80/disasm.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [input] = args.filter(a => !a.startsWith('--'));
if (!input) { console.error('usage: zx81-reboot <zip|p> [--file= --frames= --trail= --ram= --board= --keys=]'); process.exit(2); }

const DIR = process.env.ZX8X_ROM_DIR ?? resolve(process.cwd(), 'mcp/.cache');
const board = flag('board');
const s: Record<string, boolean> = {};
if ((flag('ram') ?? '16') === '16') s['zx8x-16k-ram'] = true;
if (board === 'wrx') s['zx81-wrx-hires'] = true;
if (board === 'udg') s['zx81-udg-ram'] = true;
if (board === 'udg128') s['zx81-udg128-ram'] = true;
if (board === 'memotech') s['zx81-memotech-hrg'] = true;
if (board === 'quicksilva') s['zx81-quicksilva-hrg'] = true;

const m = new Zx8xMachine((flag('model') ?? 'zx81') as Zx8xModel);
m.prepare({ get: <T>(k: string, f: T): T => (k in s ? s[k] as T : f) });
m.loadROM(new Uint8Array(readFileSync(join(DIR, 'zx81-v2.rom'))));
m.reset();

let name = basename(input);
let data = new Uint8Array(readFileSync(input));
if (/\.zip$/i.test(input)) {
  const entries = await unzip(data, ['.p', '.81', '.p81']);
  const want = flag('file');
  const e = want ? entries.find(x => x.name.toLowerCase() === want.toLowerCase()) : entries[0];
  if (!e) { console.error('no such entry; have', entries.map(x => x.name).join(', ')); process.exit(1); }
  name = e.name; data = e.data;
}
await m.services.media!.mount(data, name);

const dump = Number(flag('dump') ?? -1);
const TRAIL = Number(flag('trail') ?? 40);
const ring: string[] = [];
const snapshotMem = (): Uint8Array => { const mem = new Uint8Array(0x10000); for (let a = 0; a < 0x10000; a++) mem[a] = m.memory.readByte(a); return mem; };
let frame = 0;
let hit = false;
const step = m.cpu.step.bind(m.cpu);
m.cpu.step = (): void => {
  const c = m.cpu;
  const pc = c.pc;
  if (((frame > 20 && pc === 0 && dump < 0) || (dump >= 0 && frame === dump)) && !hit) {
    hit = true;
    console.log(`reached 0x0000 at frame ${frame}; last ${ring.length} instructions:`);
    for (const l of ring) console.log(l);
    return;
  }
  const pre = `AF=${((c.a << 8) | c.f).toString(16).padStart(4, '0')} BC=${((c.b << 8) | c.c).toString(16).padStart(4, '0')} DE=${((c.d << 8) | c.e).toString(16).padStart(4, '0')} HL=${((c.h << 8) | c.l).toString(16).padStart(4, '0')} SP=${c.sp.toString(16).padStart(4, '0')} IX=${c.ix.toString(16)} I=${c.i.toString(16)} R=${c.r.toString(16)}`;
  if (!hit) {
    const mem = new Uint8Array(8);
    for (let i = 0; i < 8; i++) mem[i] = m.memory.readByte((pc + i) & 0xffff);
    const d = disasmOne(mem, 0);
    ring.push(`${pc.toString(16).padStart(4, '0')}  ${d.text.replace(/[\x01-\x03]/g, '').padEnd(22)} ${pre}`);
    if (ring.length > TRAIL) ring.shift();
  }
  step();
};
const keys = (flag('keys') ?? '').split(',').filter(Boolean).map(k => { const [code, f] = k.split('@'); return { code, frame: Number(f) }; });
const limit = Number(flag('frames') ?? 4000);
for (; frame < limit && !hit; frame++) {
  for (const k of keys) {
    if (frame === k.frame) m.keyboard.handleKeyEvent(k.code, true);
    if (frame === k.frame + 6) m.keyboard.handleKeyEvent(k.code, false);
  }
  m.tick();
}
if (!hit) console.log(`no jump to 0x0000 in ${limit} frames; pc=${m.cpu.pc.toString(16)}`);
void snapshotMem;
