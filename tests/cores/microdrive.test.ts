import { describe, it, expect } from 'vitest';
import { Microdrive, microdriveChecksum, BLOCK_LEN, HEAD_LEN, MAX_SECTORS } from '@/machines/spectrum/peripherals/microdrive.ts';

/** Independent (non-production) checksum used to verify FORMAT/round-trip. */
function refChecksum(bytes: number[]): number {
  return bytes.reduce((a, b) => a + b, 0) % 255;
}

// ── ZX Microdrive checksum ───────────────────────────────────────────────
// The IF1 microdrive checksum is the 8-bit sum of the covered bytes taken
// modulo 255 (NOT 256). It therefore yields 0..254 and never 255 — the value
// the Interface 1 returns for a blank/corrupt block. Verified against
// libspectrum's `microdrive.c` DO_CHECK macro, which is a byte-wise
// end-around-carry implementation of exactly `sum % 255`.
describe('microdriveChecksum', () => {
  it('sums small byte runs directly when below 255', () => {
    expect(microdriveChecksum(Uint8Array.of(1, 2, 3))).toBe(6);
  });

  it('a single 0xFF wraps to 0 (255 mod 255)', () => {
    expect(microdriveChecksum(Uint8Array.of(255))).toBe(0);
  });

  it('254 stays 254 — the largest legal checksum', () => {
    expect(microdriveChecksum(Uint8Array.of(254))).toBe(254);
  });

  it('a sum of exactly 255 wraps to 0, never 255', () => {
    expect(microdriveChecksum(Uint8Array.of(200, 55))).toBe(0);
  });

  it('wraps around 255 for sums above 255', () => {
    // 200 + 200 = 400; 400 mod 255 = 145.
    expect(microdriveChecksum(Uint8Array.of(200, 200))).toBe(145);
  });

  it('empty input is 0', () => {
    expect(microdriveChecksum(new Uint8Array(0))).toBe(0);
  });
});

// ── Cartridge data layer: FORMAT, load/save round-trip, write protect ────
describe('Microdrive cartridge', () => {
  it('starts empty (no cartridge inserted)', () => {
    const md = new Microdrive();
    expect(md.inserted).toBe(false);
    expect(md.numSectors).toBe(0);
  });

  it('format() lays down a full 254-sector cartridge of the right length', () => {
    const md = new Microdrive();
    md.format('test');
    expect(md.inserted).toBe(true);
    expect(md.numSectors).toBe(MAX_SECTORS);
    // 254 sectors × 543 + 1 write-protect byte.
    expect(md.toMDR().length).toBe(MAX_SECTORS * BLOCK_LEN + 1);
  });

  it('format() writes valid header blocks with unique sector numbers and correct HDCHK', () => {
    const md = new Microdrive();
    md.format('abc');
    const mdr = md.toMDR();
    const numbers = new Set<number>();
    for (let s = 0; s < MAX_SECTORS; s++) {
      const off = s * BLOCK_LEN;
      expect(mdr[off]).toBe(1);            // HDFLAG = header marker
      numbers.add(mdr[off + 1]);           // HDNUMB
      // HDNAME = 'abc' padded to 10 with spaces.
      const name = String.fromCharCode(...mdr.subarray(off + 4, off + 14));
      expect(name).toBe('abc' + ' '.repeat(7));
      // HDCHK covers bytes 0..13.
      const expected = refChecksum([...mdr.subarray(off, off + HEAD_LEN - 1)]);
      expect(mdr[off + HEAD_LEN - 1]).toBe(expected);
    }
    // Every sector number 1..254 present exactly once.
    expect(numbers.size).toBe(MAX_SECTORS);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(MAX_SECTORS);
  });

  it('format() writes record descriptors flagged empty with correct DESCHK', () => {
    const md = new Microdrive();
    md.format('x');
    const mdr = md.toMDR();
    for (let s = 0; s < MAX_SECTORS; s++) {
      const rec = s * BLOCK_LEN + HEAD_LEN; // record block start
      // RECLEN (bytes rec+2, rec+3) = 0 — an empty record.
      expect(mdr[rec + 2] | (mdr[rec + 3] << 8)).toBe(0);
      // DESCHK covers the 14 descriptor bytes rec..rec+13.
      const expected = refChecksum([...mdr.subarray(rec, rec + HEAD_LEN - 1)]);
      expect(mdr[rec + HEAD_LEN - 1]).toBe(expected);
    }
  });

  it('round-trips arbitrary cartridge bytes through load/save', () => {
    const sectors = 12;
    const raw = new Uint8Array(sectors * BLOCK_LEN + 1);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + 3) & 0xff;
    raw[raw.length - 1] = 0; // not write protected
    const md = new Microdrive();
    md.loadMDR(raw);
    expect(md.numSectors).toBe(sectors);
    expect(md.writeProtected).toBe(false);
    expect([...md.toMDR()]).toEqual([...raw]);
  });

  it('reads the write-protect flag from the trailing byte', () => {
    const raw = new Uint8Array(3 * BLOCK_LEN + 1);
    raw[raw.length - 1] = 1; // write protected
    const md = new Microdrive();
    md.loadMDR(raw);
    expect(md.writeProtected).toBe(true);
  });
});

// ── Transfer state machine (head stepping, GAP/SYNC, read/write) ──────────
// Modelled on Fuse `if1.c`: a continuously-moving head, re-aligned to a block
// sub-boundary on each restart(), streaming bytes through dataIn()/dataOut().
const RECORD_MAX = HEAD_LEN + 512 + 1; // 528: max_bytes for the record sub-block

/** A small cartridge whose every byte equals its loop offset (mod 256). */
function rampCartridge(sectors: number): Microdrive {
  const raw = new Uint8Array(sectors * BLOCK_LEN + 1);
  for (let i = 0; i < sectors * BLOCK_LEN; i++) raw[i] = i & 0xff;
  const md = new Microdrive();
  md.loadMDR(raw);
  return md;
}

describe('Microdrive transfer FSM', () => {
  it('restart() at the loop start selects the 15-byte header sub-block', () => {
    const md = rampCartridge(4);
    md.motorOn = true;
    md.restart();
    expect(md.headPos % BLOCK_LEN).toBe(0);
    expect(md.maxBytes).toBe(HEAD_LEN);
    expect(md.transfered).toBe(0);
  });

  it('restart() mid-header advances the head to the record sub-boundary', () => {
    const md = rampCartridge(4);
    md.motorOn = true;
    md.headPos = 7;            // partway through sector 0's header
    md.restart();
    expect(md.headPos).toBe(HEAD_LEN); // offset 15 within the sector
    expect(md.maxBytes).toBe(RECORD_MAX);
  });

  it('restart() mid-record advances the head to the next sector header', () => {
    const md = rampCartridge(4);
    md.motorOn = true;
    md.headPos = 200;          // inside sector 0's record block
    md.restart();
    expect(md.headPos).toBe(BLOCK_LEN); // start of sector 1
    expect(md.maxBytes).toBe(HEAD_LEN);
  });

  it('dataIn() streams the header bytes then clamps at maxBytes', () => {
    const md = rampCartridge(4);
    md.motorOn = true;
    md.restart();              // headPos 0, maxBytes 15
    for (let i = 0; i < HEAD_LEN; i++) expect(md.dataIn()).toBe(i & 0xff);
    expect(md.headPos).toBe(HEAD_LEN);
    // Past maxBytes: returns the last byte read, head does not advance.
    expect(md.dataIn()).toBe((HEAD_LEN - 1) & 0xff);
    expect(md.headPos).toBe(HEAD_LEN);
  });

  it('a second restart() reads the record sub-block bytes', () => {
    const md = rampCartridge(4);
    md.motorOn = true;
    md.restart();
    for (let i = 0; i < HEAD_LEN; i++) md.dataIn(); // consume header → headPos 15
    md.restart();              // now at offset 15, record phase
    expect(md.maxBytes).toBe(RECORD_MAX);
    expect(md.dataIn()).toBe(HEAD_LEN & 0xff); // byte at loop offset 15
  });

  it('the head wraps around at the end of the loop', () => {
    const md = rampCartridge(2);
    md.motorOn = true;
    md.headPos = 2 * BLOCK_LEN - 1; // last byte of the loop
    md.dataIn();                    // reads it, then wraps
    expect(md.headPos).toBe(0);
  });

  it('an inactive drive contributes nothing (reads 0xFF, status 0xFF)', () => {
    const md = rampCartridge(4);
    md.motorOn = false;
    expect(md.dataIn()).toBe(0xff);
    expect(md.statusIn()).toBe(0xff);
  });

  it('a formatted block signals block-present (GAP & SYNC low) on the first status read', () => {
    const md = rampCartridge(4);
    md.motorOn = true;
    md.restart();
    // Bits 1 (SYNC) and 2 (GAP) are pulled low when a formatted block is under the head.
    expect(md.statusIn() & 0x06).toBe(0);
  });

  it('reflects write-protect in status bit 0 only when active', () => {
    const md = rampCartridge(4);
    md.writeProtected = true;
    md.motorOn = true;
    md.restart();
    expect(md.statusIn() & 0x01).toBe(0); // WP pulls bit 0 low
  });

  it('dataOut() recognises a preamble, marks the block formatted and stores data', () => {
    const md = rampCartridge(4); // start from a known cartridge
    md.modified = false;
    md.motorOn = true;
    md.restart();                // headPos 0, header phase
    // 12-byte preamble: 10 × 0x00 then 2 × 0xFF.
    for (let i = 0; i < 10; i++) md.dataOut(0x00);
    md.dataOut(0xff);
    md.dataOut(0xff);
    // Now the 15 header bytes are written to the loop starting at headPos 0.
    for (let i = 0; i < HEAD_LEN; i++) md.dataOut(0xa0 + i);
    expect(md.modified).toBe(true);
    expect(md.headPos).toBe(HEAD_LEN); // head advanced past the 15 written bytes
    const mdr = md.toMDR();
    expect(mdr[0]).toBe(0xa0);
    expect(mdr[HEAD_LEN - 1]).toBe(0xa0 + HEAD_LEN - 1);
  });
});
