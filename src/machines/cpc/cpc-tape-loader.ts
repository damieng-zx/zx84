/**
 * CAS READ instant-load trap for the Amstrad CPC.
 *
 * The CPC firmware loads cassette data through CAS READ ("read one block",
 * also reached via the &BCA1 jumpblock). A normal BASIC `RUN"` calls the ROM
 * routine directly from the cassette manager, so we trap the ROM routine itself
 * (located by signature scan) and deliver the next CDT block's bytes straight
 * into RAM, skipping the bit-level edge-sampling read.
 *
 * Entry contract (CAS READ): HL = destination, DE = byte count, A = sync char
 * (&2C header / &16 data). Exit: carry = success, A = error code on failure.
 *
 * SAFETY: the trap is CRC-gated. It only commits when the bytes it extracts
 * pass the on-tape CRC check, so it can never deliver corrupt data. On ANY
 * mismatch (sync byte wrong, block too short, CRC fail, unrecognised layout)
 * it returns false WITHOUT touching CPU or tape state, and the real firmware
 * routine loads the same block at pulse level (the always-correct path).
 * Custom loaders never call CAS READ, so they fall through to pulse playback.
 *
 * VERIFIED on os464, os664 and os6128 with real CDTs (1942, 180, 10th Frame,
 * 1943, 2048, 3D Starstrike): every CAS READ returns the same result and the
 * same bytes with the trap on as with it off (pulse loading), headers and data.
 */

import { Z80 } from '@/cores/z80.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

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
 * The firmware's CAS READ routine, located by signature scan of the lower OS ROM.
 * Its shape is identical in os464 (entry 0x2836), os664 and os6128 (0x29A6):
 *
 *   readEntry:  CALL setup        ; LD (sync),A / sound + motor on / PPI setup, RET
 *               PUSH AF           ; previous motor state
 *               LD HL,storeByte   ; per-byte action: store at (IX)
 *               JR common
 *   ...
 *   common:     PUSH HL
 *               CALL syncOnLeader ; measure the leader, match the sync byte
 *               POP HL
 *               CALL C,readRecords; the bit-level record read into (IX)
 *   tail:       POP DE            ; D = previous motor state
 *               PUSH AF           ; the read's result
 *               ... PPI restore, EI, motor restore ...
 *               POP AF / RET
 *
 * `setup` is shared with CAS WRITE and CAS CHECK, and it only prepares the
 * hardware: the bit-level read happens back in the caller, after `setup` RETs.
 * So the trap must replace the `common` → `tail` span, not the setup routine.
 */
export interface CpcCasReadRoutine {
  /** CAS READ entry (A = sync, HL = dest, DE = length). */
  readEntry: number;
  /** The read/verify shared sync+record-read block. */
  common: number;
  /** The per-byte store routine the read path passes in HL (tells READ from CHECK). */
  storeByte: number;
  /** The `POP DE` that starts the PPI/motor teardown — where the trap resumes. */
  tail: number;
}

/**
 * Locate CAS READ in the lower OS ROM. Anchored on the setup routine head
 *   LD (nn),A ; DEC DE ; INC E ; PUSH HL ; PUSH DE ; CALL nn
 * then on its READ caller `CALL setup ; PUSH AF ; LD HL,nn ; JR e`, and the
 * `PUSH HL ; CALL nn ; POP HL ; CALL C,nn ; POP DE` block the JR lands on.
 * Returns null if any piece is missing (a non-standard ROM) — pulse loading only.
 */
export function scanCpcCasRead(rom: Uint8Array): CpcCasReadRoutine | null {
  let setup = -1;
  for (let i = 0; i + 8 < rom.length; i++) {
    if (rom[i] === 0x32 && rom[i + 3] === 0x1b && rom[i + 4] === 0x1c &&
        rom[i + 5] === 0xe5 && rom[i + 6] === 0xd5 && rom[i + 7] === 0xcd) { setup = i; break; }
  }
  if (setup < 0) return null;
  for (let i = 0; i + 9 < rom.length; i++) {
    if (rom[i] !== 0xcd || rom[i + 1] !== (setup & 0xFF) || rom[i + 2] !== (setup >> 8) ||
        rom[i + 3] !== 0xf5 || rom[i + 4] !== 0x21 || rom[i + 7] !== 0x18) continue;
    const common = i + 9 + ((rom[i + 8] << 24) >> 24);
    if (common < 0 || common + 9 > rom.length) continue;
    if (rom[common] !== 0xe5 || rom[common + 1] !== 0xcd || rom[common + 4] !== 0xe1 ||
        rom[common + 5] !== 0xdc || rom[common + 8] !== 0xd1) continue;
    return { readEntry: i, common, storeByte: rom[i + 5] | (rom[i + 6] << 8), tail: common + 8 };
  }
  return null;
}

/** A CAS READ request captured at the routine's entry. */
export interface CpcCasReadRequest { dest: number; len: number; sync: number; }

/**
 * Attempt an instant CAS READ. Called at the routine's `common` block (after the
 * firmware's own setup has run: sync stashed, motor on, PPI configured) with the
 * request captured at its entry. On success the bytes are in RAM, the block is
 * consumed, and PC is at `tail` with the firmware's success result (A = 0,
 * carry + zero set — what the record reader returns after a good CRC), so the
 * firmware's own teardown restores the PPI and motor and RETs to the caller.
 * Returns false WITHOUT touching CPU, RAM or tape to let the real read run.
 */
export function trapCpcCasRead(m: CpcMachine, req: CpcCasReadRequest, tail: number): boolean {
  const cpu = m.cpu;
  const { dest, len, sync } = req;
  if (len <= 0) return false;
  if (sync !== HEADER_SYNC && sync !== DATA_SYNC) return false;

  const block = m.tape.peekDataBlock();
  if (!block || !block.rawBytes) return false;     // not a faithful CDT block

  const out = extractBlock(block.rawBytes, sync, len);
  if (!out) return false;                          // unrecognised/failed CRC → pulse fallback

  for (let i = 0; i < len; i++) m.memory.writeByte((dest + i) & 0xFFFF, out[i]);
  m.tape.nextDataBlock();
  m.tape.skipBlock();

  cpu.a = 0;
  cpu.setFlag(Z80.FLAG_C, true);
  cpu.setFlag(Z80.FLAG_Z, true);
  cpu.pc = tail & 0xFFFF;
  return true;
}
