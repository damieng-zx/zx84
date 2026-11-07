/**
 * MSX `.cas` cassette-image format: the 8-byte sync ID and the logical block
 * parser the tape pane lists blocks with. Pure format code (media layer) — the
 * BIOS-trap loader that *serves* these bytes lives with the MSX machine
 * (`machines/msx/msx-tape.ts`).
 *
 * `.cas` files are a logical byte stream (not pulse-level audio): each block is
 * preceded by the 8-byte header ID `1F A6 DE BA CC 13 7D 74` on an 8-byte
 * boundary, standing in for the long sync tone. {@link casToPulseBlocks}
 * turns one back into the FSK signal a real recorder would play.
 */

import { TAPE_REF_HZ, type TapeBlock } from '@/media/tape/tap.ts';

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

// ── .cas → cassette signal ───────────────────────────────────────────────

/**
 * The MSX cassette signal, as the BIOS writes it at its default 1200 baud
 * (measured from the HX-10 BIOS's TAPOON/TAPOUT driving PPI port C bit 5; the
 * MSX standard's FSK):
 *
 *   bit 0   one cycle of 1200 Hz
 *   bit 1   two cycles of 2400 Hz
 *   byte    a 0 start bit, 8 data bits LSb first, two 1 stop bits
 *   header  a run of 2400 Hz before each block: long (15360 cycles, about
 *           6.4 s) before a file header, short (3840 cycles, 1.6 s) before
 *           anything else — TAPOON's A = non-zero / zero
 *
 * Each `.cas` block becomes one pulse run, preceded by silence (the gap the
 * motor start leaves on a real tape), so the deck's blocks line up one-to-one
 * with {@link parseCasBlocks}.
 */
const CAS_BAUD = 1200;
const CAS_LONG_HEADER_CYCLES = 15360;
const CAS_SHORT_HEADER_CYCLES = 3840;
/** Silence before a block with a long / short header, in seconds. */
const CAS_LONG_GAP_S = 1;
const CAS_SHORT_GAP_S = 0.5;

/**
 * Synthesise the cassette signal of a `.cas` image as pulse-run (`csw`)
 * blocks, timed in the 3.5 MHz T-states the tape deck counts in. Run lengths
 * are rounded with the error carried forward, so long runs keep exact time.
 */
export function casToPulseBlocks(data: Uint8Array): TapeBlock[] {
  const ref = TAPE_REF_HZ;
  const halfHi = ref / (CAS_BAUD * 4);    // half a 2400 Hz cycle
  const halfLo = ref / (CAS_BAUD * 2);    // half a 1200 Hz cycle
  const info = parseCasBlocks(data);
  const syncs: number[] = [];
  for (let p = 0; p + 8 <= data.length; p += 8) {
    let id = true;
    for (let i = 0; i < 8; i++) if (data[p + i] !== CAS_HEADER[i]) { id = false; break; }
    if (id) syncs.push(p);
  }
  const out: TapeBlock[] = [];
  for (let b = 0; b < syncs.length; b++) {
    const start = syncs[b] + 8;
    const end = b + 1 < syncs.length ? syncs[b + 1] : data.length;
    const long = info[b].header;
    const cycles = long ? CAS_LONG_HEADER_CYCLES : CAS_SHORT_HEADER_CYCLES;
    const count = 1 + cycles * 2 + (end - start) * (1 * 2 + 8 * 4 + 2 * 4);
    const runs = new Uint32Array(count);
    let n = 0;
    let exact = 0;
    let emitted = 0;
    const run = (len: number): void => {
      exact += len;
      const t = Math.round(exact) - emitted;
      emitted += t;
      if (n < runs.length) runs[n++] = t > 0 ? t : 1;
    };
    const bit = (v: number): void => {
      if (v) { run(halfHi); run(halfHi); run(halfHi); run(halfHi); }
      else { run(halfLo); run(halfLo); }
    };
    run(ref * (long ? CAS_LONG_GAP_S : CAS_SHORT_GAP_S));
    for (let i = 0; i < cycles * 2; i++) run(halfHi);
    for (let p = start; p < end; p++) {
      const v = data[p];
      bit(0);
      for (let k = 0; k < 8; k++) bit((v >> k) & 1);
      bit(1); bit(1);
    }
    const block = info[b];
    out.push({
      kind: 'csw',
      pulses: runs.subarray(0, n),
      role: 'data',
      label: block.title,
      detail: block.header ? `${block.detail} · long header` : block.detail,
    });
  }
  return out;
}
