/**
 * The Disk ][ controller's data path at the bit level, driven by a simulated
 * CPU clock: how long a finished byte stays in the data register, the MC3470's
 * noise on long runs without flux transitions, writing with DOS's 32- and
 * 40-cycle timing, write protect, quarter tracks, and a written sector reaching
 * the saved image.
 *
 * Expectations come from the hardware's documented behaviour (Beneath Apple
 * DOS, Understanding the Apple II, the WOZ reference's notes on the MC3470), not
 * from the model: a bit cell is 4 CPU cycles; a disk byte is complete when its
 * first 1 reaches bit 7; DOS writes self-sync bytes 40 cycles apart and data
 * bytes 32 apart; the read amplifier invents bits only after more than three
 * cells with no transition.
 */

import { describe, expect, it } from 'vitest';
import { Disk2 } from '@/machines/apple2/peripherals/disk2.ts';
import {
  DOS_SKEW, decodeNibbleSectors, encodeSector6and2, gcr6, parseApple2Disk, serializeApple2Disk,
} from '@/media/floppy/apple2.ts';
import { Apple2BitWriter, standardTmap, type Apple2BitTrack } from '@/media/floppy/apple2-bitstream.ts';
import { nibblizeApple2Disk, parseApple2Media, serializeApple2Media } from '@/media/floppy/apple2-media.ts';
import { serializeWoz } from '@/media/floppy/apple2-woz.ts';

/** A one-track WOZ disk whose quarter tracks `qts` all hold `track`. */
function wozDisk(tracks: Apple2BitTrack[], tmapEntries: Record<number, number>): Uint8Array {
  const tmap = new Uint8Array(160).fill(0xFF);
  for (const [qt, slot] of Object.entries(tmapEntries)) tmap[Number(qt)] = slot;
  return serializeWoz({ tmap, tracks, bitTiming: 32, writeProtected: false });
}

function trackOf(bytes: number[], repeat = 1): Apple2BitTrack {
  const w = new Apple2BitWriter();
  for (let i = 0; i < repeat; i++) for (const b of bytes) w.byte(b);
  return w.finish();
}

function spinUp(image: Parameters<Disk2['insertDisk']>[0]): { d: Disk2; clock: { t: number } } {
  const clock = { t: 0 };
  const d = new Disk2(() => clock.t);
  d.insertDisk(image, 0);
  d.read(0x09);
  d.read(0x0A);
  return { d, clock };
}

/** Poll every cycle and return runs of [value, cycles visible] for bytes with bit 7 set. */
function heldRuns(d: Disk2, clock: { t: number }, cycles: number): [number, number][] {
  const runs: [number, number][] = [];
  let value = -1, len = 0;
  for (let i = 0; i < cycles; i++) {
    clock.t++;
    const v = d.read(0x0C);
    if (v === value) { len++; continue; }
    if (value & 0x80 && value >= 0) runs.push([value, len]);
    value = v; len = 1;
  }
  return runs;
}

describe('Disk ][ read latch', () => {
  it('holds a finished byte for two cells when the next byte follows at once', () => {
    const { d, clock } = spinUp(parseApple2Media(wozDisk([trackOf([0xD5, 0xAA, 0x96, 0xAD], 50)], { 0: 0 }), 'x.woz'));
    const runs = heldRuns(d, clock, 4000).slice(2);
    expect(runs.length).toBeGreaterThan(50);
    for (const [, len] of runs) expect(len).toBe(8);
    // And in order: each byte once.
    const seq = runs.map(r => r[0]);
    const at = seq.indexOf(0xD5);
    expect(seq.slice(at, at + 8)).toEqual([0xD5, 0xAA, 0x96, 0xAD, 0xD5, 0xAA, 0x96, 0xAD]);
  });

  it('holds a self-sync $FF through its two trailing zero cells', () => {
    const w = new Apple2BitWriter();
    w.sync(400);
    const { d, clock } = spinUp(parseApple2Media(wozDisk([w.finish()], { 0: 0 }), 'x.woz'));
    const runs = heldRuns(d, clock, 4000).slice(2);
    for (const [value, len] of runs) {
      expect(value).toBe(0xFF);
      expect(len).toBe(16);                  // 8 + 2 zero cells + the restart cell, 4 cycles each
    }
  });

  it('a 7-cycle LDA/BPL loop with a NOP after each byte sees every byte exactly once', () => {
    const bytes = [0x96, 0x97, 0x9A, 0x9B, 0x9D, 0x9E, 0x9F, 0xA6, 0xA7, 0xAB, 0xAC, 0xAD];
    const { d, clock } = spinUp(parseApple2Media(wozDisk([trackOf(bytes, 100)], { 0: 0 }), 'x.woz'));
    const got: number[] = [];
    while (got.length < 120) {
      clock.t += 4;                          // LDA $C08C,X reads on its 4th cycle
      const v = d.read(0x0C);
      if (v & 0x80) { got.push(v); clock.t += 2 + 2 + 2; }   // BPL not taken, STA-ish work, NOP
      else clock.t += 3;                     // BPL taken
    }
    const at = got.indexOf(0x96);
    for (let i = at; i < at + 96; i++) expect(got[i], `byte ${i}`).toBe(bytes[(i - at) % bytes.length]);
  });
});

describe('MC3470 read amplifier', () => {
  /** The distinct bytes a reader collects over a few revolutions. */
  function bytesRead(pattern: number[]): Set<number> {
    const { d, clock } = spinUp(parseApple2Media(wozDisk([trackOf(pattern, 64)], { 0: 0 }), 'x.woz'));
    const seen = new Set<number>();
    let armed = true;
    for (let i = 0; i < 40_000; i++) {
      clock.t += 1;
      const v = d.read(0x0C);
      if (v & 0x80) { if (armed && i > 200) seen.add(v); armed = false; } else armed = true;
    }
    return seen;
  }

  it('reads three cells without a transition faithfully', () => {
    expect([...bytesRead([0x88])]).toEqual([0x88]);             // 1000 1000
  });

  it('invents bits once more than three cells pass without a transition', () => {
    const seen = bytesRead([0x84]);                            // 1000 0100: four zeros
    expect(seen.size).toBeGreaterThan(1);
  });

  it('reads an unformatted track as noise that differs from one revolution to the next', () => {
    const blank: Apple2BitTrack = { data: new Uint8Array(6400), bitCount: 51200 };
    const { d, clock } = spinUp(parseApple2Media(wozDisk([blank], { 0: 0 }), 'x.woz'));
    const revolution = (): number[] => {
      const got: number[] = [];
      let armed = true;
      for (let i = 0; i < 400; i++) {
        clock.t += 4;
        const v = d.read(0x0C);
        if (v & 0x80) { if (armed) got.push(v); armed = false; } else armed = true;
      }
      clock.t += 51200 * 4 - 1600;
      return got;
    };
    const a = revolution(), b = revolution();
    expect(a.length).toBeGreaterThan(5);
    expect(a).not.toEqual(b);
  });

  it('reads a quarter track with no track mapped as noise too', () => {
    const { d, clock } = spinUp(parseApple2Media(wozDisk([trackOf([0xFF], 10)], { 0: 0 }), 'x.woz'));
    d.read(0x01); d.read(0x03); d.read(0x00);  // to the half track: blank
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) { clock.t += 4; seen.add(d.read(0x0C)); }
    expect(seen.size).toBeGreaterThan(10);
  });
});

describe('quarter tracks', () => {
  it('reads the track the TMAP gives the quarter track between two magnets', () => {
    // Track data A at quarter track 0, B at quarter track 1 only.
    const disk = parseApple2Media(wozDisk([trackOf([0xD5, 0xAA, 0x96, 0xEB], 100), trackOf([0xB5, 0xB6, 0xB7, 0xBA], 100)], { 0: 0, 1: 1 }), 'q.woz');
    const { d, clock } = spinUp(disk);
    const sample = (): Set<number> => {
      const s = new Set<number>();
      for (let i = 0; i < 400; i++) { clock.t += 4; const v = d.read(0x0C); if (v & 0x80) s.add(v); }
      return s;
    };
    expect(sample().has(0xD5)).toBe(true);
    d.read(0x01); d.read(0x03);               // phases 0 and 1: quarter track 1
    expect(d.getUnitQuarterTrack(0)).toBe(1);
    const there = sample();
    expect(there.has(0xB5) && !there.has(0xD5)).toBe(true);
  });
});

describe('Disk ][ writes', () => {
  /**
   * DOS 3.3's WRITE16 timing, as cycle stamps: after the address field it
   * senses write protect (LDA $C08D,X; LDA $C08E,X), loads the first sync byte
   * into the register with STA $C08F,X and turns to shift mode with ORA
   * $C08C,X four cycles later; then four more sync bytes 40 cycles apart (ten
   * cells each), the data prologue, 343 data bytes and the epilogue 32 cycles
   * apart (eight cells each), each loaded by STA $C08D,X and shifted by
   * ORA $C08C,X; finally LDA $C08E,X / LDA $C08C,X back to read mode.
   */
  function writeDataField(d: Disk2, clock: { t: number }, sector: Uint8Array): boolean {
    clock.t += 4; d.read(0x0D);
    clock.t += 4;
    if (d.read(0x0E) & 0x80) return false;                    // write protected
    clock.t += 7; d.write(0x0F, 0xFF); clock.t += 4; d.read(0x0C);
    let last = clock.t - 4;
    const put = (value: number, spacing: number) => {
      clock.t = last + spacing; d.write(0x0D, value); last = clock.t;
      clock.t += 4; d.read(0x0C);
    };
    for (let i = 0; i < 4; i++) put(0xFF, 40);
    const six = encodeSector6and2(sector);
    const bytes = [0xD5, 0xAA, 0xAD, ...Array.from(six, gcr6), 0xDE, 0xAA, 0xEB, 0xFF];
    put(bytes[0], 40);
    for (let i = 1; i < bytes.length; i++) put(bytes[i], 32);
    clock.t = last + 32; d.read(0x0E);
    clock.t += 4; d.read(0x0C);
    return true;
  }

  /** Read until the address field of `sector` has gone by (through DE AA). */
  function findAddress(d: Disk2, clock: { t: number }, sector: number): void {
    const recent: number[] = [];
    let armed = true;
    for (let guard = 0; guard < 2_000_000; guard++) {
      clock.t += 1;
      const v = d.read(0x0C);
      if (!(v & 0x80)) { armed = true; continue; }
      if (!armed) continue;
      armed = false;
      recent.push(v);
      const n = recent.length;
      if (n >= 13 && recent[n - 13] === 0xD5 && recent[n - 12] === 0xAA && recent[n - 11] === 0x96
        && (((recent[n - 6] << 1) | 1) & recent[n - 5]) === sector && recent[n - 2] === 0xDE && recent[n - 1] === 0xAA) return;
    }
    throw new Error('address field not found');
  }

  function readRevolution(d: Disk2, clock: { t: number }): Uint8Array {
    const got: number[] = [];
    let armed = true;
    for (let i = 0; i < 2 * 51200; i++) {
      clock.t += 4;
      const v = d.read(0x0C);
      if (v & 0x80) { if (armed) got.push(v); armed = false; } else armed = true;
    }
    return Uint8Array.from(got);
  }

  const newData = Uint8Array.from({ length: 256 }, (_, i) => (i * 13 + 5) & 0xFF);

  it('writes a sector with DOS timing that reads back and lands in the saved .dsk', () => {
    const image = nibblizeApple2Disk(parseApple2Disk(new Uint8Array(35 * 4096), 'dos'));
    const { d, clock } = spinUp(image);
    findAddress(d, clock, 5);
    clock.t += 60;                                           // RWTS checks the field
    expect(writeDataField(d, clock, newData)).toBe(true);
    expect(d.isDirty(0)).toBe(true);
    // Read back from wherever the head is now: every sector still decodes.
    const sectors = decodeNibbleSectors(readRevolution(d, clock), 16, false);
    expect(sectors[5]).toEqual(newData);
    expect(sectors.filter(s => s !== null)).toHaveLength(16);
    expect(sectors[4]).toEqual(new Uint8Array(256));
    // Folded into the image and saved in DOS order: physical 5 is file sector DOS_SKEW[5].
    d.tickFrame();
    const saved = serializeApple2Media(image);
    expect(saved.ext).toBe('.dsk');
    expect(saved.data.subarray(DOS_SKEW[5] * 256, DOS_SKEW[5] * 256 + 256)).toEqual(newData);
    expect(serializeApple2Disk(image, 'dos')).toEqual(saved.data);
  });

  it('writes nothing on a write-protected disk', () => {
    const image = nibblizeApple2Disk(parseApple2Disk(new Uint8Array(35 * 4096), 'dos'));
    const before = image.apple2.bits.tracks[0].data.slice();
    const { d, clock } = spinUp(image);
    d.writeProtect[0] = true;
    findAddress(d, clock, 5);
    expect(writeDataField(d, clock, newData)).toBe(false);
    // Force write mode anyway: the drive's protect switch cuts the write current.
    d.write(0x0F, 0xFF);
    clock.t += 4000;
    d.read(0x0E);
    expect(image.apple2.bits.tracks[0].data).toEqual(before);
    expect(d.isDirty(0)).toBe(false);
  });

  it('saves a written WOZ disk as WOZ with the new bits', () => {
    const base = nibblizeApple2Disk(parseApple2Disk(new Uint8Array(35 * 4096), 'dos'));
    const woz = serializeWoz({ tmap: standardTmap(35), tracks: base.apple2.bits.tracks, bitTiming: 32, writeProtected: false });
    const disk = parseApple2Media(woz, 'w.woz');
    const { d, clock } = spinUp(disk);
    findAddress(d, clock, 9);
    clock.t += 60;
    writeDataField(d, clock, newData);
    d.flushWrites(0);
    expect(disk.tracks[0][0]!.sectors.find(s => s.r === 9)!.data).toEqual(newData);
    const again = parseApple2Media(serializeApple2Media(disk).data, 'w.woz');
    expect(again.tracks[0][0]!.sectors.find(s => s.r === 9)!.data).toEqual(newData);
  });
});
