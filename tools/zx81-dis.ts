import { readFileSync } from 'node:fs';
import { unzip } from '@/media/zip.ts';
import { disasmOne } from '@/debug/z80/disasm.ts';
const [zip, from, to, file] = process.argv.slice(2);
const entries = await unzip(new Uint8Array(readFileSync(zip)), ['.p']);
const e = file ? entries.find(x => x.name === file)! : entries[0];
// .p image starts at 0x4009; RAM address a -> data[a-0x4009]
const mem = new Uint8Array(0x10000);
mem.set(e.data, 0x4009);
let a = parseInt(from, 16); const end = parseInt(to, 16);
// the ROM at 0..0x1fff
const rom = readFileSync('mcp/.cache/zx81-v2.rom');
mem.set(rom, 0);
while (a < end) { const d = disasmOne(mem, a); console.log(a.toString(16).padStart(4,'0'), d.text.replace(/[\x01-\x03]/g,'')); a += d.length; }
