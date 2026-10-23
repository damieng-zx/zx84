import type { DskImage } from '@/media/floppy/disk-image.ts';
import { serializeHFE } from '@/media/floppy/hfe.ts';

/** A disk image ready to download. */
export interface SavedDisk { data: Uint8Array; name: string }

/** The mounted file name without its extension, or `fallback` when it has none. */
export function baseName(name: string, fallback = 'disk'): string {
  return name.replace(/\.[^.]+$/, '') || fallback;
}

/**
 * Serialise a floppy for download: an image that came from an HFE bitstream
 * saves back as HFE, so its protection tracks survive, and anything else in the
 * machine's own format (`serialize`, saved as `base` + `ext`).
 */
export function saveHfeOr(
  image: DskImage,
  base: string,
  ext: string,
  serialize: (image: DskImage) => Uint8Array,
): SavedDisk {
  return image.bitstream
    ? { data: serializeHFE(image), name: `${base}.hfe` }
    : { data: serialize(image), name: `${base}${ext}` };
}
