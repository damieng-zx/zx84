/**
 * The image formats the Spectrum's two disk add-ons read, in one place so the
 * mount path (the machine's media service) and the reload path (the shell's
 * drive restore) decide the same way. +D: .mgt/.img/.dsk sector dumps, .hfe
 * and .scp flux, Teledisk .td0. Beta Disk: .trd/.scl, .hfe and .scp flux,
 * Teledisk .td0.
 */

import type { DskImage } from './disk-image.ts';
import { parseHFE, isHFE } from './hfe.ts';
import { parseSCP, isScp } from './scp.ts';
import { parseTd0, isTd0 } from './td0.ts';
import { parseMgt, mgtExtFromName } from './mgt-image.ts';
import { parseTrd } from './trd-image.ts';
import { parseScl, isScl } from './scl-image.ts';

/** Parse a +D image. A raw .dsk is MGT track order, as SimCoupe and SAM write it. */
export function parsePlusDMedia(data: Uint8Array, filename: string): DskImage | null {
  if (isHFE(data)) return parseHFE(data);
  if (isScp(data)) return parseSCP(data);
  if (isTd0(data)) return parseTd0(data);
  return parseMgt(data, mgtExtFromName(filename));
}

/** Parse a Beta Disk image. */
export function parseBetaMedia(data: Uint8Array): DskImage | null {
  if (isHFE(data)) return parseHFE(data);
  if (isScp(data)) return parseSCP(data);
  if (isTd0(data)) return parseTd0(data);
  if (isScl(data)) return parseScl(data);
  return parseTrd(data);
}
