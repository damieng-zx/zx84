/**
 * A `.d71` with files on it, built by hand the way the 1571's DOS lays them
 * out (a chain of sectors per file; the BAM and directory kept up to date,
 * including the second side's counts in 18/0 and its bit maps in 53/0), so a
 * test has something to LOAD that the drive's own firmware did not write.
 */

import { blankD71, sectorsOnTrack } from '@/media/floppy/c64-disk.ts';
import type { D64File } from './d64-helper.ts';

/** The first sector of `track` (1-70) in the file. */
function trackStart(track: number): number {
  const side = track > 35 ? 1 : 0;
  let n = side * 683;
  for (let t = 1; t < track - side * 35; t++) n += sectorsOnTrack(t);
  return n;
}

/** `side1` puts the files on the second side (tracks 36-70), `side0` on the first. */
export function d71WithFiles(files: readonly D64File[], side: 0 | 1 = 0, diskName = 'DEVDISK', id = '99'): Uint8Array {
  const d = blankD71(diskName, id);
  const bam = trackStart(18) * 256;
  const bam2 = trackStart(53) * 256;
  const used = new Set<string>();
  const alloc = (): [number, number] => {
    for (let t = side ? 36 : 1; t <= (side ? 70 : 35); t++) {
      if (t === 18 || t === 53) continue;
      for (let s = 0; s < sectorsOnTrack(t - (t > 35 ? 35 : 0)); s++) {
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
      if (t <= 35) {
        const e = bam + 4 * t;
        d[e]--;
        d[e + 1 + (s >> 3)] &= ~(1 << (s & 7));
      } else {
        d[bam + 0xDD + (t - 36)]--;
        d[bam2 + 3 * (t - 36) + (s >> 3)] &= ~(1 << (s & 7));
      }
    });
    const dir = (trackStart(18) + 1) * 256 + entry * 32;
    d[dir + 2] = 0x82;                                    // PRG, closed
    d[dir + 3] = chain[0][0]; d[dir + 4] = chain[0][1];
    for (let k = 0; k < 16; k++) d[dir + 5 + k] = k < file.name.length ? file.name.charCodeAt(k) : 0xA0;
    d[dir + 0x1E] = blocks & 0xFF; d[dir + 0x1F] = blocks >> 8;
  });
  return d;
}
