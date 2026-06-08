/**
 * CPC CAS READ instant-load trap.
 *
 * The trap satisfies a firmware CAS READ (HL=dest, DE=len, A=sync) from the next
 * CDT block, de-segmenting the on-tape records and validating their CRCs before
 * committing. It is CRC-gated: on any mismatch it declines (returns false)
 * WITHOUT touching CPU or RAM, so the real firmware routine then loads the block
 * at pulse level. These tests build blocks in the on-tape layout with an
 * independent CRC implementation, never the code under test.
 *
 * On success the trap does NOT RET straight to the caller — it hands control to
 * the firmware routine's own teardown tail (entry + 0x0D, the motor-off / PPI
 * restore), leaving SP untouched (the routine balances its own pushes before
 * that point) and setting the post-read register state (IX = buffer, carry =
 * success). The teardown must run or the cassette hardware is left mis-set.
 */
const ENTRY = 0x2900;            // pretend block-read routine entry
const TEARDOWN = ENTRY + 0x0D;   // where the trap resumes

import { describe, it, expect } from 'vitest';
import { CpcMachine } from '@/cpc/cpc-machine.ts';
import { trapCpcCasRead } from '@/cpc/cpc-tape-loader.ts';
import { Z80 } from '@/cores/z80.ts';
import type { DataBlock } from '@/tape/tap.ts';

/** CRC-16/CCITT (poly 0x1021, init 0xFFFF) — independent of the loader's copy. */
function crc16(bytes: Uint8Array): number {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

/** Append a record's data + its (complemented, MSB-first) CRC to `parts`. */
function pushRecord(parts: number[], data: Uint8Array): void {
  const crc = (~crc16(data)) & 0xFFFF;
  parts.push(...data, crc >> 8, crc & 0xFF);
}

/** Build the on-tape byte stream: sync byte then 256-byte records (+CRC each). */
function buildRaw(sync: number, payload: Uint8Array): Uint8Array {
  const parts: number[] = [sync];
  for (let off = 0; off < payload.length; off += 256) {
    pushRecord(parts, payload.subarray(off, off + 256));
  }
  return new Uint8Array(parts);
}

function tapeBlock(rawBytes: Uint8Array): DataBlock {
  return {
    kind: 'data', flag: rawBytes[0], data: rawBytes.subarray(1), pause: 0,
    pilotPulse: 2168, syncPulse1: 667, syncPulse2: 735,
    bit0Pulse: 855, bit1Pulse: 1710, pilotCount: 3223, usedBits: 8,
    source: 'turbo', rawBytes,
  };
}

function payload(len: number): Uint8Array {
  const p = new Uint8Array(len);
  for (let i = 0; i < len; i++) p[i] = (i * 7 + 1) & 0xFF;
  return p;
}

/** Arm the machine for a trap: tape mounted, registers set, return addr on stack. */
function arm(m: CpcMachine, block: DataBlock, dest: number, len: number, sync: number, ret: number) {
  m.tape.blocks = [block];
  m.tape.position = 0;
  m.cpu.hl = dest;
  m.cpu.de = len;
  m.cpu.a = sync;
  m.cpu.sp = 0x8000;
  m.memory.writeByte(0x8000, ret & 0xFF);
  m.memory.writeByte(0x8001, (ret >> 8) & 0xFF);
}

describe('CPC CAS READ trap — successful load', () => {
  it('delivers a single-record data block and resumes in the teardown tail', () => {
    const m = new CpcMachine('cpc6128', null);
    const data = payload(64);
    arm(m, tapeBlock(buildRaw(0x16, data)), 0x4000, 64, 0x16, 0x1234);

    expect(trapCpcCasRead(m, ENTRY)).toBe(true);
    for (let i = 0; i < 64; i++) expect(m.memory.readByte(0x4000 + i)).toBe(data[i]);
    expect(m.cpu.pc).toBe(TEARDOWN);        // resumes in the firmware teardown
    expect(m.cpu.sp).toBe(0x8000);          // SP untouched (routine RETs to caller)
    expect(m.cpu.ix).toBe(0x4000);          // IX = buffer, as POP IX would leave it
    expect(m.cpu.getFlag(Z80.FLAG_C)).toBe(true);
    expect(m.tape.position).toBe(1);        // block consumed
  });

  it('delivers a header block (sync 0x2C)', () => {
    const m = new CpcMachine('cpc6128', null);
    const data = payload(40);
    arm(m, tapeBlock(buildRaw(0x2C, data)), 0x5000, 40, 0x2C, 0xC000);
    expect(trapCpcCasRead(m, ENTRY)).toBe(true);
    for (let i = 0; i < 40; i++) expect(m.memory.readByte(0x5000 + i)).toBe(data[i]);
  });

  it('de-segments a multi-record block (300 bytes → 256 + 44)', () => {
    const m = new CpcMachine('cpc6128', null);
    const data = payload(300);
    arm(m, tapeBlock(buildRaw(0x16, data)), 0x4000, 300, 0x16, 0x1234);
    expect(trapCpcCasRead(m, ENTRY)).toBe(true);
    for (let i = 0; i < 300; i++) expect(m.memory.readByte(0x4000 + i)).toBe(data[i]);
  });
});

describe('CPC CAS READ trap — declines safely (pulse-level fallback)', () => {
  it('declines and touches nothing on a CRC error', () => {
    const m = new CpcMachine('cpc6128', null);
    const raw = buildRaw(0x16, payload(64));
    raw[raw.length - 1] ^= 0xFF;            // corrupt the stored CRC
    arm(m, tapeBlock(raw), 0x4000, 64, 0x16, 0x1234);
    m.cpu.pc = 0x9999;                       // sentinel
    m.memory.writeByte(0x4000, 0xEE);

    expect(trapCpcCasRead(m, ENTRY)).toBe(false);
    expect(m.cpu.pc).toBe(0x9999);          // PC unchanged
    expect(m.memory.readByte(0x4000)).toBe(0xEE); // RAM untouched
    expect(m.tape.position).toBe(0);        // block not consumed
  });

  it('declines on a sync-byte mismatch', () => {
    const m = new CpcMachine('cpc6128', null);
    arm(m, tapeBlock(buildRaw(0x16, payload(64))), 0x4000, 64, 0x2C, 0x1234);
    m.cpu.pc = 0x9999;
    expect(trapCpcCasRead(m, ENTRY)).toBe(false);
    expect(m.cpu.pc).toBe(0x9999);
  });

  it('declines when the block has no faithful rawBytes', () => {
    const m = new CpcMachine('cpc6128', null);
    const block = tapeBlock(buildRaw(0x16, payload(64)));
    delete block.rawBytes;                   // e.g. a Spectrum-parsed block
    arm(m, block, 0x4000, 64, 0x16, 0x1234);
    expect(trapCpcCasRead(m, ENTRY)).toBe(false);
  });
});
