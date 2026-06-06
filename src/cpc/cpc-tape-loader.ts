/**
 * CAS READ instant-load trap for the Amstrad CPC.
 *
 * The CPC firmware loads cassette data through the cassette-manager routine
 * reached via the &BCA1 jumpblock (CAS READ — "read one block"). Like the
 * Spectrum's LD-BYTES trap, we intercept that routine and deliver the next
 * CDT block's bytes straight into RAM, skipping the real edge-sampling loop.
 *
 * Entry contract (CAS READ): HL = destination, DE = byte count, A = sync char
 * (&2C header / &16 data). Exit: carry = success, A = error code on failure.
 *
 * SAFETY: the trap is CRC-gated. It only commits when the bytes it extracts
 * pass the on-tape CRC check, so it can never deliver corrupt data. On ANY
 * mismatch (sync byte wrong, block too short, CRC fail, unrecognised layout)
 * it returns false WITHOUT touching CPU or tape state, and the caller lets the
 * real firmware routine run — which loads the same block at pulse level (the
 * always-correct path). Custom loaders never call CAS READ, so they too fall
 * through to pulse playback untouched.
 *
 * NOTE: the exact on-tape record layout (256-byte records vs a single trailing
 * CRC) and the CRC convention are handled adaptively and validated by CRC, but
 * have not yet been confirmed against a real CDT + real firmware. If a tape's
 * layout isn't recognised the trap simply declines and pulse loading takes over.
 */

import { Z80 } from '@/cores/z80.ts';
import type { CpcMachine } from '@/cpc/cpc-machine.ts';

const HEADER_SYNC = 0x2C;
const DATA_SYNC = 0x16;
const RECORD = 256;

/** CRC-16/CCITT (poly 0x1021, init 0xFFFF) over data[start..start+len). */
function crc16(data: Uint8Array, start: number, len: number): number {
  let crc = 0xFFFF;
  for (let i = 0; i < len; i++) {
    crc ^= data[start + i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

/** The CPC stores the complement of the CRC; accept the plain value too so a
 *  differently-authored CDT still validates rather than silently declining. */
function crcOk(stored: number, calc: number): boolean {
  return stored === ((~calc) & 0xFFFF) || stored === calc;
}

/** Read a big-endian 16-bit CRC at `p`, or -1 if out of range. */
function crcAt(b: Uint8Array, p: number): number {
  return p + 1 < b.length ? (b[p] << 8) | b[p + 1] : -1;
}

/**
 * Extract `len` data bytes from the on-tape block `b` (b[0] = sync byte),
 * validating the embedded CRC(s). Returns the data, or null if the layout
 * doesn't validate. Two layouts are tried, both CRC-gated:
 *   A) 256-byte records, each followed by a 2-byte CRC (last record may be
 *      stored full-256/padded or exactly the remaining bytes).
 *   B) a single 2-byte CRC over the whole `len`-byte payload.
 */
function extractBlock(b: Uint8Array, sync: number, len: number): Uint8Array | null {
  if (b.length < 1 || b[0] !== sync) return null;

  // ── Layout A: per-record CRC ─────────────────────────────────────────
  const recs = (() => {
    const out = new Uint8Array(len);
    let src = 1, dst = 0, need = len;
    while (need > 0) {
      const want = Math.min(RECORD, need);
      // Try a full-256 padded record first, then an exact `want`-byte record.
      let dataLen = -1;
      for (const seg of (want < RECORD ? [RECORD, want] : [RECORD])) {
        const crc = crcAt(b, src + seg);
        if (crc >= 0 && crcOk(crc, crc16(b, src, seg))) { dataLen = seg; break; }
      }
      if (dataLen < 0) return null;
      out.set(b.subarray(src, src + want), dst);
      src += dataLen + 2;
      dst += want;
      need -= want;
    }
    return out;
  })();
  if (recs) return recs;

  // ── Layout B: single trailing CRC ────────────────────────────────────
  if (1 + len + 2 <= b.length) {
    const crc = crcAt(b, 1 + len);
    if (crc >= 0 && crcOk(crc, crc16(b, 1, len))) return b.slice(1, 1 + len);
  }

  return null;
}

/**
 * Attempt an instant CAS READ. Returns true if it committed (bytes copied,
 * tape advanced, CPU returned with carry set), false to fall through to the
 * real firmware routine.
 */
export function trapCpcCasRead(m: CpcMachine): boolean {
  const cpu = m.cpu;
  const dest = cpu.hl;
  const len = cpu.de;
  const sync = cpu.a & 0xFF;
  if (len <= 0) return false;
  if (sync !== HEADER_SYNC && sync !== DATA_SYNC) return false;

  const block = m.tape.peekDataBlock();
  if (!block || !block.rawBytes) return false;     // not a faithful CDT block

  const out = extractBlock(block.rawBytes, sync, len);
  if (!out) return false;                          // unrecognised/failed CRC → pulse fallback

  // Commit: copy to RAM, consume the block, RET with carry = success.
  for (let i = 0; i < len; i++) m.memory.writeByte((dest + i) & 0xFFFF, out[i]);
  m.tape.nextDataBlock();
  m.tape.skipBlock();

  cpu.pc = cpu.pop16();
  cpu.a = 0;
  cpu.setFlag(Z80.FLAG_C, true);   // success
  cpu.setFlag(Z80.FLAG_Z, false);  // not ESC-aborted
  return true;
}
