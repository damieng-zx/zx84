/**
 * Loader signature recognition — identify WHICH loader is reading the
 * tape by pattern-matching bytes immediately preceding the IN A,($FE).
 *
 * When a loader's edge-detection loop polls port $FE, PC has just advanced
 * past the IN instruction. The 6 bytes ending at PC-1 are the tail of the
 * polling loop — the same bytes for every iteration. Matching that tail
 * against known patterns tells us which loader is running, with no need
 * to peek at memory beyond the CPU's own program counter.
 *
 * This is a separate concern from LoaderDetector: detection answers "is
 * something reading the tape?", signature answers "what is it?". Splitting
 * them keeps the detector free of memory dependencies (it only sees raw
 * port reads) and makes signatures trivially testable.
 *
 * Currently recognises:
 *   - 'rom' — the standard Spectrum 48K ROM LD-SAMPLE loop at $05ED..$05F2.
 *
 * Adding loaders: append to SIGNATURES with the 6-byte loop tail. Test
 * coverage is the source of truth — without a verifiable reference dump
 * (a ROM image or a clean disassembly) we don't ship a signature.
 *
 * The approach is inspired by the acceleration_detector() pattern used by
 * Fuse and ZEsarUX (both GPL), but the byte patterns are functional facts
 * derived from the publicly-disassembled Spectrum ROM, and the matching
 * code is written from scratch.
 */

export type LoaderSignature = 'rom' | 'unknown';

interface Signature {
  name: Exclude<LoaderSignature, 'unknown'>;
  /** Bytes expected at memory[pc - bytes.length .. pc - 1] */
  bytes: readonly number[];
}

const SIGNATURES: readonly Signature[] = [
  // Spectrum 48K ROM LD-SAMPLE loop (PC = $05F3 immediately after IN):
  //   $05ED: 04        INC B
  //   $05EE: C8        RET Z
  //   $05EF: 3E 7F     LD A,$7F
  //   $05F1: DB FE     IN A,($FE)
  // Publicly disassembled in Logan & O'Hara's "The Complete Spectrum ROM
  // Disassembly" (1983) and many subsequent references.
  { name: 'rom', bytes: [0x04, 0xC8, 0x3E, 0x7F, 0xDB, 0xFE] },
];

/**
 * Examine memory immediately before `pc` and return which loader's
 * polling loop tail matches, or 'unknown' if none do.
 *
 * @param read  byte-reader (typically memory.readByte). Address is masked
 *              to 16 bits before calling.
 * @param pc    current program counter (just past the IN instruction)
 */
export function detectLoaderSignature(
  read: (addr: number) => number,
  pc: number,
): LoaderSignature {
  for (const sig of SIGNATURES) {
    const n = sig.bytes.length;
    let match = true;
    for (let i = 0; i < n; i++) {
      const addr = (pc - n + i) & 0xFFFF;
      if (read(addr) !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return sig.name;
  }
  return 'unknown';
}
