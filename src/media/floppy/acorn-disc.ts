/**
 * Acorn floppy discs for the BBC Micro and the Electron's Plus 3: every file a
 * user may drop on those drives, routed to the right decoder, and the way a
 * mounted disc is written back out.
 *
 *   .ssd / .dsd                 DFS sector dumps (single density, FM)
 *   .adf / .ads / .adm / .adl   ADFS sector dumps (double density, MFM)
 *   .hfe / .scp                 bitstream and flux images, decoded track by
 *                               track (FM or MFM) with their oddities kept
 *   .img / .dsk                 sector dumps of either kind, told apart by
 *                               content (ADFS's "Hugo" root, a DFS catalogue)
 *
 * Containers are recognised by signature first, whatever the file is called,
 * so a disc saved back under its original name still mounts.
 */

import type { DskImage } from './disk-image.ts';
import { detectAcornRawFormat, hasRegularLayout, sniffDiskContainer } from './disk-detect.ts';
import { ADFS_SECTOR_SIZE, ADFS_SECTORS_PER_TRACK, parseAdfs, serializeAdfs } from './adfs.ts';
import { encodeHFE, parseHFE, serializeHFE } from './hfe.ts';
import { parseSCP } from './scp.ts';
import { parseSsd, serializeSsd, SSD_SECTOR_SIZE, SSD_SECTORS_PER_TRACK, SSD_TRACK_BYTES } from './ssd.ts';

export type AcornFilingSystem = 'dfs' | 'adfs';

export interface AcornDisc {
  readonly image: DskImage;
  /** The filing system the disc is laid out for, or null when it is neither
   *  plain DFS nor plain ADFS (a protected or foreign disc). */
  readonly fs: AcornFilingSystem | null;
}

/** File extensions the Acorn disc path accepts. */
export const ACORN_DISC_EXTS = ['.ssd', '.dsd', '.adf', '.ads', '.adm', '.adl', '.img', '.dsk', '.hfe', '.scp'] as const;

const DFS_LAYOUT = { sectors: SSD_SECTORS_PER_TRACK, firstId: 0, size: SSD_SECTOR_SIZE, encoding: 'fm' } as const;
const ADFS_LAYOUT = { sectors: ADFS_SECTORS_PER_TRACK, firstId: 0, size: ADFS_SECTOR_SIZE, encoding: 'mfm' } as const;

/**
 * The filing system a decoded disc is laid out for, judged by its first track:
 * ten 256-byte sectors in single density is DFS, sixteen in double density is
 * ADFS. Any other first track (a protection track, a foreign format) is null.
 */
export function acornFilingSystem(image: DskImage): AcornFilingSystem | null {
  const t0 = image.tracks[0]?.[0];
  if (!t0 || t0.sectors.length === 0) return null;
  const all256 = t0.sectors.every(s => s.data.length === 256);
  if (!all256) return null;
  if (t0.encoding !== 'mfm' && t0.sectors.length === SSD_SECTORS_PER_TRACK) return 'dfs';
  if (t0.encoding !== 'fm' && t0.sectors.length === ADFS_SECTORS_PER_TRACK) return 'adfs';
  return null;
}

function ext(filename: string): string {
  const m = /\.[^.\\/]+$/.exec(filename);
  return m ? m[0].toLowerCase() : '';
}

function parseDfs(data: Uint8Array, doubleSided: boolean): AcornDisc {
  return { image: parseSsd(data, doubleSided), fs: 'dfs' };
}

function parseAdfsDisc(data: Uint8Array, doubleSided: boolean): AcornDisc {
  return { image: parseAdfs(data, doubleSided), fs: 'adfs' };
}

/**
 * Decode an Acorn disc file. `prefer` settles a headerless dump whose content
 * says neither DFS nor ADFS (a blank or foreign disc) — the filing system the
 * machine is set up for. Throws with a readable message when nothing fits.
 */
export function parseAcornDisc(data: Uint8Array, filename: string, prefer: AcornFilingSystem = 'dfs'): AcornDisc {
  if (data.length === 0) throw new Error('the disc image is empty');
  switch (sniffDiskContainer(data)) {
    case 'hfe': { const image = parseHFE(data); return { image, fs: acornFilingSystem(image) }; }
    case 'scp': { const image = parseSCP(data); return { image, fs: acornFilingSystem(image) }; }
    case 'td0':
    case 'cpc-dsk':
      throw new Error('that is not an Acorn disc image');
    default: break;
  }
  switch (ext(filename)) {
    case '.ssd': return parseDfs(data, false);
    case '.dsd': return parseDfs(data, true);
    case '.adl': return parseAdfsDisc(data, true);
    case '.adf': case '.ads': case '.adm': return parseAdfsDisc(data, false);
    default: break;
  }
  // .img / .dsk, or a container saved back under another name: by content,
  // else the filing system the machine is set up for.
  if ((detectAcornRawFormat(data) ?? prefer) === 'adfs') return parseAdfsDisc(data, false);
  // A DFS dump over one side of 80 tracks is the double-sided, interleaved kind.
  return parseDfs(data, data.length > SSD_TRACK_BYTES * 80);
}

/**
 * Write a mounted disc back out: as `.hfe` when it came from one (only the
 * sectors written are re-encoded, so protection survives), as a plain `.ssd` /
 * `.dsd` / ADFS dump when its layout is exactly that, and otherwise as a fresh
 * `.hfe` encoded from its sectors, which keeps deleted-data marks, bad CRCs and
 * odd sector IDs and sizes that a sector dump would silently lose.
 */
export function serializeAcornDisc(image: DskImage): { data: Uint8Array; ext: string } {
  if (image.bitstream) return { data: serializeHFE(image), ext: '.hfe' };
  const doubleSided = image.numSides === 2;
  if (hasRegularLayout(image, DFS_LAYOUT)) {
    return { data: serializeSsd(image, doubleSided), ext: doubleSided ? '.dsd' : '.ssd' };
  }
  if (hasRegularLayout(image, ADFS_LAYOUT) && image.numTracks <= 80) {
    const adfsExt = doubleSided ? '.adl' : image.numTracks > 40 ? '.adm' : '.ads';
    return { data: serializeAdfs(image), ext: adfsExt };
  }
  return { data: encodeHFE(image), ext: '.hfe' };
}
