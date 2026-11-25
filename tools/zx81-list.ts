/** Print a ZX81 program's BASIC listing (and variables) from a zip/.p.  node ... tools/zx81-list.ts <zip> [--file=] [--max=N] */
import { readFileSync } from 'node:fs';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import { parseZx8xBasicProgram } from '@/machines/zx8x/basic.ts';
import { unzip } from '@/media/zip.ts';
const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const [input] = args.filter(a => !a.startsWith('--'));
const entries = /\.zip$/i.test(input) ? await unzip(new Uint8Array(readFileSync(input)), ['.p']) : [{ name: input, data: new Uint8Array(readFileSync(input)) }];
const want = flag('file');
const e = want ? entries.find(x => x.name.toLowerCase() === want.toLowerCase())! : entries[0];
const mem = new Uint8Array(0x10000);
mem.set(e.data, 0x4009);
const max = Number(flag('max') ?? 60);
const lines = parseZx8xBasicProgram(mem, 'zx81');
for (const l of lines.slice(0, max)) console.log(JSON.stringify(l).slice(0, 200));
void Zx8xMachine;
