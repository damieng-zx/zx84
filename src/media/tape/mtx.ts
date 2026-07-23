/**
 * Memotech MTX logical cassette image.
 *
 * The de-facto `.mtx` format used by MTX emulators is the byte stream requested
 * by the ROM cassette routine. It has no container framing: the first ROM
 * request is the 18-byte program header and later requests consume the rest of
 * the stream sequentially.
 */

export const MTX_HEADER_SIZE = 18;

export interface MtxTapeHeader {
  /** Header marker written by the ROM (normally FF). */
  readonly marker: number;
  /** Fifteen-character, space-padded MTX filename. */
  readonly name: string;
  /** Little-endian STKLIM value stored at the end of the header. */
  readonly stackLimit: number;
}

/** Decode the fixed first header, or null when the image is too short. */
export function parseMtxTapeHeader(data: Uint8Array): MtxTapeHeader | null {
  if (data.length < MTX_HEADER_SIZE) return null;

  let name = '';
  for (let i = 1; i < 16; i++) {
    const c = data[i];
    name += c >= 0x20 && c <= 0x7E ? String.fromCharCode(c) : ' ';
  }

  return {
    marker: data[0],
    name: name.trimEnd(),
    stackLimit: data[16] | (data[17] << 8),
  };
}
