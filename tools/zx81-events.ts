/**
 * Log display-routine and interrupt events for a ZX81 title between two frames.
 *   node node_modules/tsx/dist/cli.mjs tools/zx81-events.ts <zip> --from=85 --to=100 [--pcs=023e,02a8] [--file=] [--keys=]
 */
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import { unzip } from '@/media/zip.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const [input] = args.filter(a => !a.startsWith('--'));
const DIR = resolve(process.cwd(), 'mcp/.cache');
const m = new Zx8xMachine('zx81');
m.prepare({ get: <T>(k: string, f: T): T => (k === 'zx8x-16k-ram' ? true as T : f) });
m.loadROM(new Uint8Array(readFileSync(join(DIR, 'zx81-v2.rom'))));
m.reset();
let name = basename(input);
let data = new Uint8Array(readFileSync(input));
if (/\.zip$/i.test(input)) {
  const entries = await unzip(data, ['.p']);
  const want = flag('file');
  const e = want ? entries.find(x => x.name.toLowerCase() === want.toLowerCase()) : entries[0];
  name = e!.name; data = e!.data;
}
await m.services.media!.mount(data, name);
const from = Number(flag('from') ?? 0), to = Number(flag('to') ?? 100);
const pcs = new Set((flag('pcs') ?? '').split(',').filter(Boolean).map(s => parseInt(s, 16)));
let frame = 0;
const w = (a: number): string => (m.memory.readByte(a) | (m.memory.readByte(a + 1) << 8)).toString(16).padStart(4, '0');
const hex = (n: number): string => n.toString(16).padStart(4, '0');
const step = m.cpu.step.bind(m.cpu);
m.cpu.step = (): void => {
  const c = m.cpu;
  if (frame >= from && frame <= to && pcs.has(c.pc)) console.log(`f${frame} pc=${hex(c.pc)} sp=${hex(c.sp)} iff=${c.iff1 ? 1 : 0} top=${w(c.sp)} ${w(c.sp + 2)} ${w(c.sp + 4)} ${w(c.sp + 6)} ${w(c.sp + 8)} IX=${hex(c.ix)} cdflag=${m.memory.readByte(0x403b).toString(16)}`);
  step();
};
const prevInt = m.cpu.onInterrupt;
m.cpu.onInterrupt = (h: number, nmi: boolean): void => {
  if (frame >= from && frame <= to) console.log(`f${frame} ${nmi ? 'NMI' : 'INT'} accepted at pc=${hex(m.cpu.pc)} sp=${hex(m.cpu.sp)} iff=${m.cpu.iff1 ? 1 : 0}`);
  prevInt?.(h, nmi);
};
const keys = (flag('keys') ?? '').split(',').filter(Boolean).map(k => { const [code, f] = k.split('@'); return { code, frame: Number(f) }; });
for (; frame <= to; frame++) {
  for (const k of keys) {
    if (frame === k.frame) m.keyboard.handleKeyEvent(k.code, true);
    if (frame === k.frame + 6) m.keyboard.handleKeyEvent(k.code, false);
  }
  m.tick();
}
