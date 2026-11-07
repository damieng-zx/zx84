/**
 * A `.d64` with files on it, built by hand the way the 1541's DOS lays them
 * out (a chain of sectors per file, the BAM and directory kept up to date), so
 * a test has something to LOAD that the drive's own firmware did not write.
 */

import { blankD64, sectorsOnTrack } from '@/media/floppy/c64-disk.ts';

function trackStart(track: number): number {
  let n = 0;
  for (let t = 1; t < track; t++) n += sectorsOnTrack(t);
  return n;
}

export interface D64File {
  readonly name: string;
  /** The file as stored: a load address then the program. */
  readonly data: Uint8Array;
}

export function d64WithFiles(files: readonly D64File[], diskName = 'DEVDISK', id = '99'): Uint8Array {
  const d = blankD64(diskName, id);
  const bam = trackStart(18) * 256;
  const used = new Set<string>();
  const alloc = (): [number, number] => {
    for (let t = 1; t <= 35; t++) {
      if (t === 18) continue;
      for (let s = 0; s < sectorsOnTrack(t); s++) {
        if (!used.has(`${t}:${s}`)) { used.add(`${t}:${s}`); return [t, s]; }
      }
    }
    throw new Error('disk full');
  };
  files.forEach((file, entry) => {
    const blocks = Math.max(1, Math.ceil(file.data.length / 254));
    const chain: [number, number][] = [];
    for (let i = 0; i < blocks; i++) chain.push(alloc());
    chain.forEach(([t, s], i) => {
      const at = (trackStart(t) + s) * 256;
      const chunk = file.data.subarray(i * 254, (i + 1) * 254);
      if (i + 1 < chain.length) { d[at] = chain[i + 1][0]; d[at + 1] = chain[i + 1][1]; }
      else { d[at] = 0; d[at + 1] = chunk.length + 1; }
      d.set(chunk, at + 2);
      const e = bam + 4 * t;
      d[e]--;
      d[e + 1 + (s >> 3)] &= ~(1 << (s & 7));
    });
    const dir = (trackStart(18) + 1) * 256 + entry * 32;
    d[dir + 2] = 0x82;                                    // PRG, closed
    d[dir + 3] = chain[0][0]; d[dir + 4] = chain[0][1];
    for (let k = 0; k < 16; k++) d[dir + 5 + k] = k < file.name.length ? file.name.charCodeAt(k) : 0xA0;
    d[dir + 0x1E] = blocks & 0xFF; d[dir + 0x1F] = blocks >> 8;
  });
  return d;
}

/** `10 PRINT "B"` as a program file (load address $0801). */
export const PRINT_B_PRG = Uint8Array.from([
  0x01, 0x08, 0x0A, 0x08, 0x0A, 0x00, 0x99, 0x22, 0x42, 0x22, 0x00, 0x00, 0x00,
]);
