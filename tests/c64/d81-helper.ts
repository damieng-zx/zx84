/**
 * A `.d81` with files on it, built by hand the way the 1581's DOS lays them
 * out (a chain of 256-byte sectors per file, the BAM and directory kept up to
 * date), so a test has something to LOAD that the drive's own firmware did not
 * write.
 */

import { blankD81Bytes } from '@/media/floppy/c64-d81.ts';
import type { D64File } from './d64-helper.ts';

const sectorAt = (track: number, s: number): number => ((track - 1) * 40 + s) * 256;

export function d81WithFiles(files: readonly D64File[], diskName = 'DEVDISK', id = '99'): Uint8Array {
  const d = blankD81Bytes(diskName, id);
  const used = new Set<string>();
  // Directory sectors 40/3.. are in use; so are the header and the two BAM sectors.
  for (let s = 0; s < 4; s++) used.add(`40:${s}`);
  const alloc = (): [number, number] => {
    for (let t = 1; t <= 80; t++) {
      if (t === 40) continue;
      for (let s = 0; s < 40; s++) {
        if (!used.has(`${t}:${s}`)) { used.add(`${t}:${s}`); return [t, s]; }
      }
    }
    throw new Error('disk full');
  };
  const bamOf = (t: number): number => (t <= 40 ? sectorAt(40, 1) : sectorAt(40, 2)) + 0x10 + ((t - 1) % 40) * 6;

  files.forEach((file, entry) => {
    const blocks = Math.max(1, Math.ceil(file.data.length / 254));
    const chain: [number, number][] = [];
    for (let i = 0; i < blocks; i++) chain.push(alloc());
    chain.forEach(([t, s], i) => {
      const at = sectorAt(t, s);
      const chunk = file.data.subarray(i * 254, (i + 1) * 254);
      if (i + 1 < chain.length) { d[at] = chain[i + 1][0]; d[at + 1] = chain[i + 1][1]; }
      else { d[at] = 0; d[at + 1] = chunk.length + 1; }
      d.set(chunk, at + 2);
      const e = bamOf(t);
      d[e]--;
      d[e + 1 + (s >> 3)] &= ~(1 << (s & 7));
    });
    const dir = sectorAt(40, 3) + entry * 32;
    d[dir + 2] = 0x82;                                    // PRG, closed
    d[dir + 3] = chain[0][0]; d[dir + 4] = chain[0][1];
    for (let k = 0; k < 16; k++) d[dir + 5 + k] = k < file.name.length ? file.name.charCodeAt(k) : 0xA0;
    d[dir + 0x1E] = blocks & 0xFF; d[dir + 0x1F] = blocks >> 8;
  });
  return d;
}
