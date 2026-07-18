/**
 * MSX `.cas` cassette-image format: the 8-byte sync ID and the logical block
 * parser the tape pane lists blocks with. Pure format code (media layer) — the
 * BIOS-trap loader that *serves* these bytes lives with the MSX machine
 * (`machines/msx/msx-tape.ts`).
 *
 * `.cas` files are a logical byte stream (not pulse-level audio): each block is
 * preceded by the 8-byte header ID `1F A6 DE BA CC 13 7D 74` on an 8-byte
 * boundary, standing in for the long sync tone.
 */

/** The 8-byte `.cas` block header ID (stands in for the sync tone). */
export const CAS_HEADER = [0x1F, 0xA6, 0xDE, 0xBA, 0xCC, 0x13, 0x7D, 0x74];

/** A block of a `.cas` image, for the tape-pane listing. */
export interface CasBlock {
  /** True for a 16-byte file-header block, false for a data block. */
  header: boolean;
  /** Main line, e.g. `Header "GAME"` or `Data`. */
  title: string;
  /** Secondary line, e.g. `BASIC file` or `2048 bytes`. */
  detail: string;
  /** File name (header blocks only). */
  name?: string;
  /** File type — BASIC / Binary / ASCII (header blocks only). */
  type?: string;
  /** Size of this block's payload in bytes. */
  size: number;
}

/** MSX file-header type markers (10 identical bytes lead a header block). */
const CAS_FILE_TYPE: Record<number, string> = { 0xD3: 'BASIC', 0xD0: 'Binary', 0xEA: 'ASCII' };

/**
 * Parse a `.cas` image into its logical blocks (header + data), the way the
 * tape pane lists TAP/TZX blocks. Each 8-byte sync ID (on an 8-byte boundary)
 * starts a block that runs to the next ID or end of file. A 16-byte block led by
 * ten identical D3/D0/EA bytes is a file header (its last 6 bytes are the name);
 * everything else is data.
 */
export function parseCasBlocks(data: Uint8Array): CasBlock[] {
  const isIdAt = (p: number): boolean => {
    if (p + 8 > data.length) return false;
    for (let i = 0; i < 8; i++) if (data[p + i] !== CAS_HEADER[i]) return false;
    return true;
  };
  const syncs: number[] = [];
  for (let p = 0; p + 8 <= data.length; p += 8) if (isIdAt(p)) syncs.push(p);

  const out: CasBlock[] = [];
  for (let i = 0; i < syncs.length; i++) {
    const start = syncs[i] + 8;
    const end = i + 1 < syncs.length ? syncs[i + 1] : data.length;
    const chunk = data.subarray(start, end);
    const marker = chunk.length >= 16 ? CAS_FILE_TYPE[chunk[0]] : undefined;
    let isHeader = false;
    if (marker) {
      isHeader = true;
      for (let k = 1; k < 10; k++) if (chunk[k] !== chunk[0]) { isHeader = false; break; }
    }
    if (isHeader) {
      let name = '';
      for (let k = 10; k < 16; k++) name += String.fromCharCode(chunk[k]);
      name = name.trimEnd();
      out.push({ header: true, title: `Header "${name}"`, detail: `${marker} file`, name, type: marker, size: chunk.length });
    } else {
      out.push({ header: false, title: 'Data', detail: `${chunk.length} bytes`, size: chunk.length });
    }
  }
  return out;
}
