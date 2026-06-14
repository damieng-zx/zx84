import { describe, it, expect, beforeEach } from 'vitest';
import { UPD765A } from '@/cores/upd765a.ts';
import type { DskImage, DskTrack, DskSector } from '@/plus3/dsk.ts';

// ── MSR bit constants (mirrors the comments in upd765a.ts) ───────────────
const RQM = 0x80;
const DIO = 0x40;
const EXM = 0x20;
const CB  = 0x10;

const ST0_INVALID   = 0x80;
const ST0_ABNORMAL  = 0x40;
const ST0_SEEK_END  = 0x20;
const ST0_NOT_READY = 0x08;

// ── Helpers ───────────────────────────────────────────────────────────────

function makeSector(c: number, h: number, r: number, n: number, fill: number, st1 = 0, st2 = 0): DskSector {
  const size = 128 << n;
  const data = new Uint8Array(size);
  data.fill(fill);
  return { c, h, r, n, st1, st2, data };
}

function makeTrack(sectors: DskSector[], gap3 = 0x4E, filler = 0xE5): DskTrack {
  const sectorMap = new Map<number, number>();
  sectors.forEach((s, i) => sectorMap.set(s.r, i));
  return { sectors, sectorMap, gap3, filler };
}

function makeImage(opts: {
  numTracks?: number;
  numSides?: number;
  tracks?: (DskTrack | null)[][];
} = {}): DskImage {
  const numTracks = opts.numTracks ?? 1;
  const numSides = opts.numSides ?? 1;
  const tracks = opts.tracks ?? Array.from({ length: numTracks }, () =>
    Array.from({ length: numSides }, () => null as DskTrack | null)
  );
  return { format: 'extended', numTracks, numSides, tracks, diskFormat: '+3DOS', protection: 'None' };
}

/** Build a standard 9-sector double-density track of 512-byte sectors. */
function makePlus3Track(cyl: number, head: number, fillBase = 0x10): DskTrack {
  const sectors: DskSector[] = [];
  for (let i = 0; i < 9; i++) {
    sectors.push(makeSector(cyl, head, 0xC1 + i, 2, (fillBase + i) & 0xFF));
  }
  return makeTrack(sectors, 0x4E, 0xE5);
}

function makeStdImage(): DskImage {
  const img = makeImage({ numTracks: 2, numSides: 1 });
  img.tracks[0][0] = makePlus3Track(0, 0);
  img.tracks[1][0] = makePlus3Track(1, 0);
  return img;
}

class Driver {
  fdc: UPD765A;
  constructor() {
    this.fdc = new UPD765A();
    this.fdc.logFn = null; // silence
  }

  /** Send a full command (cmd byte + params) and block-drain the result phase. */
  command(...bytes: number[]): number[] {
    for (const b of bytes) this.fdc.writeData(b);
    return this.drainResult();
  }

  /** Read all result bytes until idle. */
  drainResult(): number[] {
    const out: number[] = [];
    let guard = 0;
    while ((this.fdc.readStatus() & (CB | DIO | EXM)) === (CB | DIO) && ++guard < 64) {
      out.push(this.fdc.readData());
    }
    return out;
  }

  /** Drain entire execution-phase read into bytes, then drain the result phase. */
  drainReadExecution(): { data: number[]; result: number[] } {
    const data: number[] = [];
    let guard = 0;
    // In execution-read: MSR = RQM | DIO | EXM | CB = 0xF0
    while ((this.fdc.readStatus() & EXM) !== 0 && ++guard < 100000) {
      data.push(this.fdc.readData());
    }
    return { data, result: this.drainResult() };
  }

  /** Feed bytes during a write execution phase, then drain the result. */
  drainWriteExecution(bytes: ArrayLike<number>): number[] {
    for (let i = 0; i < bytes.length; i++) this.fdc.writeData(bytes[i]);
    return this.drainResult();
  }

  /**
   * Read a few bytes then stop and poll status, mimicking a protection loader
   * that breaks its read loop mid-sector. The uPD765A terminates the execution
   * phase with ST1.OR after OVERRUN_THRESHOLD (32) status polls without a data
   * read. Returns the result-phase bytes.
   */
  overrunRead(...cmd: number[]): number[] {
    for (const b of cmd) this.fdc.writeData(b);
    this.fdc.readData();           // read one execution byte
    this.fdc.readData();           // and another, so we're genuinely mid-sector
    for (let i = 0; i < 40; i++) this.fdc.readStatus(); // > threshold → overrun
    return this.drainResult();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('uPD765A — Main Status Register', () => {
  let d: Driver;
  beforeEach(() => { d = new Driver(); });

  it('returns RQM only when idle', () => {
    expect(d.fdc.readStatus()).toBe(RQM);
  });

  it('returns RQM + CB while awaiting command parameters', () => {
    d.fdc.writeData(0x07); // RECALIBRATE → 1 param expected
    expect(d.fdc.readStatus()).toBe(RQM | CB);
  });

  it('returns RQM + DIO + CB during result phase', () => {
    d.fdc.writeData(0x08); // SENSE_INT, no params → executes immediately
    expect(d.fdc.readStatus()).toBe(RQM | DIO | CB);
  });

  it('returns RQM + DIO + EXM + CB during read execution', () => {
    const img = makeStdImage();
    d.fdc.insertDisk(img, 0);
    // READ_DATA unit=0 head=0 C=0 H=0 R=0xC1 N=2 EOT=0xC1 GPL=0x2A DTL=0xFF
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    expect(d.fdc.readStatus()).toBe(RQM | DIO | EXM | CB);
  });

  it('returns RQM + EXM + CB during write execution (no DIO)', () => {
    const img = makeStdImage();
    d.fdc.insertDisk(img, 0);
    [0x05, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    expect(d.fdc.readStatus()).toBe(RQM | EXM | CB);
  });
});

describe('uPD765A — SPECIFY', () => {
  it('accepts two params, no result phase', () => {
    const d = new Driver();
    const res = d.command(0x03, 0xDF, 0x02); // SRT/HUT, HLT/ND
    expect(res).toEqual([]);
    expect(d.fdc.readStatus()).toBe(RQM); // idle
  });
});

describe('uPD765A — SENSE_INTERRUPT_STATUS', () => {
  let d: Driver;
  beforeEach(() => { d = new Driver(); });

  it('returns ST0_INVALID when no interrupt is pending', () => {
    const res = d.command(0x08);
    expect(res).toEqual([ST0_INVALID]);
  });

  it('returns latched ST0 + PCN after a SEEK', () => {
    d.command(0x0F, 0x00, 42); // SEEK unit=0 to cyl 42
    const res = d.command(0x08);
    expect(res).toEqual([ST0_SEEK_END | 0, 42]);
  });

  it('after SEEK on unit 1, ST0 includes US0=1', () => {
    d.command(0x0F, 0x01, 7);
    const res = d.command(0x08);
    expect(res).toEqual([ST0_SEEK_END | 1, 7]);
  });

  it('SENSE_INT clears the latch — a second call reports ST0_INVALID', () => {
    d.command(0x0F, 0x00, 5);
    d.command(0x08);
    const res = d.command(0x08);
    expect(res).toEqual([ST0_INVALID]);
  });
});

describe('uPD765A — RECALIBRATE / SEEK', () => {
  it('RECALIBRATE drives PCN to 0 and latches interrupt', () => {
    const d = new Driver();
    d.command(0x0F, 0x00, 10);            // SEEK to 10
    expect(d.fdc.getUnitTrack(0)).toBe(10);
    d.command(0x07, 0x00);                 // RECALIBRATE unit 0
    expect(d.fdc.getUnitTrack(0)).toBe(0);
    const r = d.command(0x08);
    expect(r).toEqual([ST0_SEEK_END | 0, 0]);
  });

  it('SEEK on unit 3 aliases to physical drive 1 (+3 hardware behaviour)', () => {
    const d = new Driver();
    d.command(0x0F, 0x03, 25);
    // unit 3 maps to physical 1 (FUSE specplus3 drive aliasing)
    expect(d.fdc.getUnitTrack(3)).toBe(25);
    expect(d.fdc.getUnitTrack(1)).toBe(25);
    expect(d.fdc.getUnitTrack(0)).toBe(0); // untouched
  });
});

describe('uPD765A — SENSE_DRIVE_STATUS (ST3)', () => {
  let d: Driver;
  beforeEach(() => { d = new Driver(); });

  it('reports two-side (bit 3) + Track 0 (bit 4) for empty drive at cyl 0', () => {
    const res = d.command(0x04, 0x00);
    expect(res.length).toBe(1);
    expect(res[0] & 0x08).toBe(0x08); // two-side
    expect(res[0] & 0x10).toBe(0x10); // Track 0
    expect(res[0] & 0x20).toBe(0x00); // not ready (no disk, no forceReady)
    expect(res[0] & 0x40).toBe(0x00); // not WP
  });

  it('clears Track 0 after a SEEK away from cyl 0', () => {
    d.command(0x0F, 0x00, 3);
    const res = d.command(0x04, 0x00);
    expect(res[0] & 0x10).toBe(0x00);
  });

  it('sets Ready (bit 5) when a disk is inserted', () => {
    d.fdc.insertDisk(makeStdImage(), 0);
    const res = d.command(0x04, 0x00);
    expect(res[0] & 0x20).toBe(0x20);
  });

  it('Ready also responds to the forceReady tab (no disk needed)', () => {
    d.fdc.forceReady[0] = true;
    const res = d.command(0x04, 0x00);
    expect(res[0] & 0x20).toBe(0x20);
  });

  it('reports Write Protect (bit 6) when writeProtect is set', () => {
    d.fdc.insertDisk(makeStdImage(), 0);
    d.fdc.writeProtect[0] = true;
    const res = d.command(0x04, 0x00);
    expect(res[0] & 0x40).toBe(0x40);
  });

  it('encodes the HDS+US bits from the parameter byte', () => {
    // HDS=1, US=1 → param byte = (1<<2)|1 = 5
    const res = d.command(0x04, 0x05);
    expect(res[0] & 0x07).toBe(0x05); // US0..1 + HDS preserved in low 3 bits
  });
});

describe('uPD765A — VERSION and invalid commands', () => {
  it('VERSION returns 0x80 (enhanced controller)', () => {
    const d = new Driver();
    expect(d.command(0x10)).toEqual([0x80]);
  });

  it('Invalid command returns ST0 = ST0_INVALID', () => {
    const d = new Driver();
    expect(d.command(0x00)).toEqual([ST0_INVALID]);
    expect(d.command(0x01)).toEqual([ST0_INVALID]);
    expect(d.command(0x1F)).toEqual([ST0_INVALID]);
  });
});

describe('uPD765A — READ_DATA', () => {
  let d: Driver;
  let img: DskImage;
  beforeEach(() => {
    d = new Driver();
    img = makeStdImage();
    d.fdc.insertDisk(img, 0);
  });

  it('returns NOT_READY with no disk', () => {
    const empty = new Driver();
    const r = empty.command(0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF);
    expect(r[0] & ST0_NOT_READY).toBe(ST0_NOT_READY);
    expect(r[0] & ST0_ABNORMAL).toBe(ST0_ABNORMAL);
    expect(r[1]).toBe(0x00); // ST1=0 because FDC never tried to read (NR before exec)
    expect(r[2]).toBe(0x00);
    expect(r.length).toBe(7);
  });

  it('returns ND (ST1 bit 2) for a missing sector', () => {
    [0x06, 0x00, 0, 0, 0x99 /* nonexistent */, 2, 0x99, 0x2A, 0xFF]
      .forEach(b => d.fdc.writeData(b));
    const r = d.drainResult();
    expect(r[0] & ST0_ABNORMAL).toBe(ST0_ABNORMAL);
    expect(r[1] & 0x04).toBe(0x04);
  });

  it('reads exactly 512 bytes for a single N=2 sector and reports EOT/EN', () => {
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    expect(data.length).toBe(512);
    expect(data.every(b => b === 0x10)).toBe(true);
    // ST0: abnormal + EOT (no error in sector itself). ST1 EN bit 7.
    expect(result[0] & ST0_ABNORMAL).toBe(ST0_ABNORMAL);
    expect(result[1] & 0x80).toBe(0x80);
    // Result CHRN reflects last sector read
    expect(result[3]).toBe(0); // C
    expect(result[4]).toBe(0); // H
    expect(result[5]).toBe(0xC1); // R
    expect(result[6]).toBe(2);    // N
  });

  it('advances through multiple sectors up to EOT', () => {
    // R=0xC1..0xC3 (3 sectors)
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC3, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    expect(data.length).toBe(512 * 3);
    expect(data.slice(0, 512).every(b => b === 0x10)).toBe(true);
    expect(data.slice(512, 1024).every(b => b === 0x11)).toBe(true);
    expect(data.slice(1024, 1536).every(b => b === 0x12)).toBe(true);
    expect(result[5]).toBe(0xC3); // final R
    expect(result[1] & 0x80).toBe(0x80); // EN
  });

  it('preserves intentional CRC errors in result (Speedlock contract)', () => {
    const tr = makeTrack([
      makeSector(0, 0, 0xC1, 2, 0xAA, 0x20 /* DE */, 0x20 /* DD */),
    ]);
    const im = makeImage();
    im.tracks[0][0] = tr;
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(im, 0);
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { result } = d.drainReadExecution();
    expect(result[1] & 0x20).toBe(0x20); // ST1 Data Error preserved
    expect(result[2] & 0x20).toBe(0x20); // ST2 Data CRC preserved
  });

  it('single-sector protection mode: sector.c mismatch stops after one sector', () => {
    // Physical cyl 0, but sector ID claims c=0x42 — Alkatraz / Speedlock style
    const tr = makeTrack([
      makeSector(0x42, 0, 0xC1, 2, 0xAB),
      makeSector(0x42, 0, 0xC2, 2, 0xCD),
    ]);
    const im = makeImage();
    im.tracks[0][0] = tr;
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(im, 0);
    [0x06, 0x00, 0x42, 0, 0xC1, 2, 0xC2, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    // Only the first sector should come back
    expect(data.length).toBe(512);
    expect(result[5]).toBe(0xC1);
    expect(result[1] & 0x80).toBe(0x80); // EN
  });

  it('reports DDAM mismatch via CM (ST2 bit 6) on READ_DATA of a deleted sector', () => {
    const tr = makeTrack([makeSector(0, 0, 0xC1, 2, 0x77, 0, 0x40 /* DDAM */)]);
    const im = makeImage();
    im.tracks[0][0] = tr;
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(im, 0);
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { result } = d.drainReadExecution();
    expect(result[2] & 0x40).toBe(0x40);
  });

  it('READ_DELETED on a deleted-mark sector clears CM (match)', () => {
    const tr = makeTrack([makeSector(0, 0, 0xC1, 2, 0x77, 0, 0x40)]);
    const im = makeImage();
    im.tracks[0][0] = tr;
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(im, 0);
    [0x0C, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { result } = d.drainReadExecution();
    expect(result[2] & 0x40).toBe(0x00);
  });

  it('READ_DELETED on a normal-DAM sector sets CM (mismatch)', () => {
    const tr = makeTrack([makeSector(0, 0, 0xC1, 2, 0x77)]); // no DDAM
    const im = makeImage();
    im.tracks[0][0] = tr;
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(im, 0);
    [0x0C, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { result } = d.drainReadExecution();
    expect(result[2] & 0x40).toBe(0x40);
  });

  it('undersized protection sector (sector.n < cmdN) suppresses spurious DE/DD bits', () => {
    // sector.n = 1 (256 bytes) but command N = 2 (512). Stored st1/st2 dirty.
    const tr = makeTrack([
      { c: 0, h: 0, r: 0xC1, n: 1, st1: 0x20, st2: 0x60, data: new Uint8Array(256).fill(0x5A) },
    ]);
    const im = makeImage();
    im.tracks[0][0] = tr;
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(im, 0);
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    // Physical transfer size = 128 << sector.n = 256, not 512
    expect(data.length).toBe(256);
    // DE/DD/CM cleared for undersized sectors (see code comment)
    expect(result[1] & 0x20).toBe(0x00);
    expect(result[2] & 0x20).toBe(0x00);
    expect(result[2] & 0x40).toBe(0x00);
  });
});

describe('uPD765A — WRITE_DATA', () => {
  let d: Driver;
  let img: DskImage;
  beforeEach(() => {
    d = new Driver();
    img = makeStdImage();
    d.fdc.insertDisk(img, 0);
  });

  it('rejects with NW (ST1 bit 1) when write-protected', () => {
    d.fdc.writeProtect[0] = true;
    [0x05, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const r = d.drainResult();
    expect(r[0] & ST0_ABNORMAL).toBe(ST0_ABNORMAL);
    expect(r[1] & 0x02).toBe(0x02);
  });

  it('returns NOT_READY when no disk is inserted', () => {
    const empty = new Driver();
    const r = empty.command(0x05, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF);
    expect(r[0] & ST0_NOT_READY).toBe(ST0_NOT_READY);
  });

  it('writes data into the sector buffer and a subsequent READ returns it', () => {
    // Enter write phase
    [0x05, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const payload = new Uint8Array(512);
    for (let i = 0; i < 512; i++) payload[i] = (i * 7) & 0xFF;
    const r = d.drainWriteExecution(payload);
    expect(r[0] & ST0_ABNORMAL).toBe(ST0_ABNORMAL); // EOT abnormal
    // Sector data updated
    const stored = img.tracks[0][0]!.sectors[0].data;
    expect(stored.length).toBe(512);
    expect(Array.from(stored)).toEqual(Array.from(payload));
    // Read it back
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const rr = d.drainReadExecution();
    expect(rr.data).toEqual(Array.from(payload));
  });

  it('write resets v5 weak-bit copies on the affected sector', () => {
    const copies = [new Uint8Array(512).fill(1), new Uint8Array(512).fill(2)];
    const sect: DskSector = {
      c: 0, h: 0, r: 0xC1, n: 2, st1: 0, st2: 0, data: copies[0], copies,
    };
    const tr = makeTrack([sect]);
    const im = makeImage();
    im.tracks[0][0] = tr;
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(im, 0);

    [0x05, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const buf = new Uint8Array(512).fill(0x99);
    d.drainWriteExecution(buf);
    expect(sect.copies).toBeUndefined();
  });
});

describe('uPD765A — READ_ID', () => {
  let d: Driver;
  beforeEach(() => {
    d = new Driver();
    d.fdc.insertDisk(makeStdImage(), 0);
  });

  it('NOT_READY when no disk', () => {
    const empty = new Driver();
    const r = empty.command(0x0A, 0x00);
    expect(r[0] & ST0_NOT_READY).toBe(ST0_NOT_READY);
  });

  it('cycles through every sector ID across successive calls', () => {
    const ids = new Set<number>();
    for (let i = 0; i < 9; i++) {
      const r = d.command(0x0A, 0x00);
      // result = [ST0, ST1, ST2, C, H, R, N]
      ids.add(r[5]);
    }
    expect(ids.size).toBe(9);
  });

  it('returns CHRN that matches the sector entry', () => {
    const r = d.command(0x0A, 0x00);
    expect(r[3]).toBe(0); // C
    expect(r[4]).toBe(0); // H
    expect(r[6]).toBe(2); // N
    expect(r[0] & ST0_ABNORMAL).toBe(0); // normal termination
  });
});

describe('uPD765A — FORMAT_TRACK', () => {
  let d: Driver;
  let img: DskImage;
  beforeEach(() => {
    d = new Driver();
    img = makeImage({ numTracks: 5, numSides: 2 });
    img.tracks[0][0] = makePlus3Track(0, 0);
    d.fdc.insertDisk(img, 0);
  });

  it('NOT_READY without a disk', () => {
    const empty = new Driver();
    const r = empty.command(0x0D, 0x00, 2, 9, 0x2A, 0xE5);
    expect(r[0] & ST0_NOT_READY).toBe(ST0_NOT_READY);
  });

  it('rejects when write-protected', () => {
    d.fdc.writeProtect[0] = true;
    const r = d.command(0x0D, 0x00, 2, 9, 0x2A, 0xE5);
    expect(r[1] & 0x02).toBe(0x02);
  });

  it('rebuilds a track from CPU-supplied CHRN tuples', () => {
    // Seek to a fresh cylinder
    d.command(0x0F, 0x00, 3);
    d.command(0x08); // clear seek interrupt latch
    // FORMAT_TRACK unit=0 head=0 N=2 SC=4 GPL=0x2A Fill=0x77
    [0x0D, 0x00, 2, 4, 0x2A, 0x77].forEach(b => d.fdc.writeData(b));
    const ids = new Uint8Array([
      3, 0, 0xC1, 2,
      3, 0, 0xC2, 2,
      3, 0, 0xC3, 2,
      3, 0, 0xC4, 2,
    ]);
    const r = d.drainWriteExecution(ids);
    expect(r[5]).toBe(0xC4); // last R
    expect(d.fdc.formattedUnit).toBe(0);

    const tr = img.tracks[3][0]!;
    expect(tr.sectors.length).toBe(4);
    expect(tr.sectors[0]).toMatchObject({ c: 3, h: 0, r: 0xC1, n: 2 });
    expect(tr.sectors[3].r).toBe(0xC4);
    expect(tr.sectors[0].data.length).toBe(512);
    expect(tr.sectors[0].data.every(b => b === 0x77)).toBe(true);
    expect(tr.gap3).toBe(0x2A);
    expect(tr.filler).toBe(0x77);
    expect(tr.sectorMap.get(0xC3)).toBe(2);
  });
});

describe('uPD765A — READ_TRACK (Read Diagnostic — sector data fields)', () => {
  it('empty drive → NOT_READY', () => {
    const d = new Driver();
    const r = d.command(0x02, 0x00, 0, 0, 1, 2, 9, 0x2A, 0xFF);
    expect(r[0] & ST0_NOT_READY).toBe(ST0_NOT_READY);
  });

  it('transfers concatenated sector DATA fields (no gap/ID bytes), physical order', () => {
    const d = new Driver();
    d.fdc.insertDisk(makeStdImage(), 0); // 9 sectors R0xC1..0xC9, fill 0x10..0x18
    // EOT=0xC9 ≫ 9 → read the whole track
    [0x02, 0x00, 0, 0, 0xC1, 2, 0xC9, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    // 9 sectors × 512 = 4608 data bytes — NOT a 6250-byte raw track
    expect(data.length).toBe(9 * 512);
    // First bytes are real sector data (0x10), not 0x4E gap filler
    expect(data[0]).toBe(0x10);
    expect(data.slice(0, 512).every(b => b === 0x10)).toBe(true);
    expect(data.slice(512, 1024).every(b => b === 0x11)).toBe(true);
    // Result reports the LAST sector's actual CHRN
    expect(result.slice(3)).toEqual([0, 0, 0xC9, 2]);
  });

  it('honours EOT as a sector count and reports the true R of an offset sector', () => {
    // Alkatraz-style offset-sector track: physical sectors start at R=177.
    const d = new Driver();
    const tr = makeTrack([
      makeSector(7, 0, 177, 2, 0xA0),
      makeSector(7, 0, 178, 2, 0xA1),
      makeSector(7, 0, 179, 2, 0xA2),
    ]);
    const im = makeImage();
    im.tracks[0][0] = tr;
    d.fdc.insertDisk(im, 0);
    // READ_TRACK with EOT=1 → exactly one sector (the first physical one)
    [0x02, 0x00, 7, 0, 1, 2, 1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    expect(data.length).toBe(512);
    expect(data.every(b => b === 0xA0)).toBe(true); // first physical sector's data
    // Loader learns the offset from the result: real R=177, not the command R=1
    expect(result.slice(3)).toEqual([7, 0, 177, 2]);
  });
});

describe('uPD765A — Overrun detection', () => {
  it('aborts execution with ST1.OR when MSR is polled without reading data', () => {
    const d = new Driver();
    d.fdc.insertDisk(makeStdImage(), 0);
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    // We're in execution-read. Poll MSR 32 times without ever reading data.
    let final = 0;
    for (let i = 0; i < 32; i++) final = d.fdc.readStatus();
    expect(final).toBe(RQM | DIO | CB); // result phase
    const r = d.drainResult();
    expect(r[1] & 0x10).toBe(0x10); // OR
  });

  it('reading data resets the overrun counter', () => {
    const d = new Driver();
    d.fdc.insertDisk(makeStdImage(), 0);
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    // Alternate: 20 polls, one read, 20 polls — should NOT trigger overrun
    for (let i = 0; i < 20; i++) d.fdc.readStatus();
    d.fdc.readData();
    for (let i = 0; i < 20; i++) d.fdc.readStatus();
    expect(d.fdc.readStatus() & EXM).toBe(EXM); // still in execution
  });
});

describe('uPD765A — Drive aliasing (+3 hardware quirk)', () => {
  it('READ_DATA on logical unit 2 actually reads physical drive 0', () => {
    const d = new Driver();
    d.fdc.insertDisk(makeStdImage(), 0);
    [0x06, 0x02, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data } = d.drainReadExecution();
    expect(data.length).toBe(512);
    expect(data.every(b => b === 0x10)).toBe(true);
  });

  it('SENSE_DRIVE on unit 2 sees the disk in physical drive 0', () => {
    const d = new Driver();
    d.fdc.insertDisk(makeStdImage(), 0);
    const r = d.command(0x04, 0x02);
    expect(r[0] & 0x20).toBe(0x20); // Ready
    // But the original logical unit must be preserved in ST3 low bits
    expect(r[0] & 0x03).toBe(0x02);
  });
});

describe('uPD765A — insertDisk / ejectDisk / reset', () => {
  it('insert exposes the image via diskImage getter (drive 0 only)', () => {
    const d = new Driver();
    expect(d.fdc.diskImage).toBeNull();
    const img = makeStdImage();
    d.fdc.insertDisk(img, 0);
    expect(d.fdc.diskImage).toBe(img);
  });

  it('getDiskImage(unit) does NOT apply drive aliasing — by design', () => {
    // Intentional documentation: getDiskImage uses logical units.
    // Physical alias (units 2/3 → 0/1) is only inside FDC operations.
    const d = new Driver();
    const img = makeStdImage();
    d.fdc.insertDisk(img, 0);
    expect(d.fdc.getDiskImage(0)).toBe(img);
    expect(d.fdc.getDiskImage(2)).toBeNull(); // alias not applied here
  });

  it('eject clears the slot', () => {
    const d = new Driver();
    d.fdc.insertDisk(makeStdImage(), 0);
    d.fdc.ejectDisk(0);
    expect(d.fdc.diskImage).toBeNull();
  });

  it('reset returns the controller to idle but preserves disk image', () => {
    const d = new Driver();
    d.fdc.insertDisk(makeStdImage(), 0);
    d.fdc.writeData(0x07); // start RECALIBRATE — awaiting param
    expect(d.fdc.readStatus()).toBe(RQM | CB);
    d.fdc.reset();
    expect(d.fdc.readStatus()).toBe(RQM);
    expect(d.fdc.diskImage).not.toBeNull(); // preserved by reset()
    expect(d.fdc.getUnitTrack(0)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Behaviour we don't yet model — tests document current (loose) behaviour
// so a future implementation will deliberately break and update them.
// ─────────────────────────────────────────────────────────────────────────

describe('uPD765A — command flag bits (MT modelled; MF/SK unmodelled)', () => {
  let d: Driver;
  beforeEach(() => {
    d = new Driver();
    d.fdc.insertDisk(makeStdImage(), 0);
  });

  it('MF (bit 6) bit is currently stripped — FM and MFM behave identically', () => {
    // Standard MFM READ_DATA = 0x46; "FM-mode" READ_DATA = 0x06.
    // A real chip would attempt FM-encoded sectors (128 bytes/sector, different
    // address marks). We strip via `cmd & 0x1F`, so both end up as READ_DATA.
    [0x46, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const a = d.drainReadExecution();
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const b = d.drainReadExecution();
    expect(a.data.length).toBe(b.data.length);
    expect(a.result[0]).toBe(b.result[0]);
    // FUTURE: if/when we model FM, FM reads on an MFM-only disk should
    // probably surface ST1.MA (Missing Address Mark) on the first sector.
  });

  it('MT (bit 7) multi-track READ_DATA continues onto head 1 after EOT', () => {
    // With MT=1, after the last sector on head 0 the FDC continues on head 1 of
    // the same cylinder, restarting the sector count, and only reports End of
    // Cylinder once head 1 also reaches EOT.
    const img = makeImage({ numTracks: 1, numSides: 2 });
    img.tracks[0][0] = makePlus3Track(0, 0, 0x10);
    img.tracks[0][1] = makePlus3Track(0, 1, 0x80);
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(img, 0);

    // 0x86 = READ_DATA | MT, HDS=0 (start on head 0), R=EOT=0xC1 (one sector/head)
    [0x86, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    // Both sides transferred: side 0 (0x10 fill) then side 1 (0x80 fill).
    expect(data.length).toBe(1024);
    expect(data[0]).toBe(0x10);
    expect(data[512]).toBe(0x80);
    // Result reflects the last sector read — head advanced to 1, EN asserted.
    expect(result[4]).toBe(1);          // H result byte advanced to side 1
    expect(result[0] & 0x04).toBe(0x04); // ST0 head bit (HD) = 1
    expect(result[1] & 0x80).toBe(0x80); // ST1.EN — End of Cylinder at side-1 EOT
  });

  it('MT multi-track spans multiple sectors per head before switching', () => {
    // Two sectors per head: head 0 reads 0xC1,0xC2 then head 1 reads 0xC1,0xC2,
    // restarting the sector count at the command R. Verifies the switch happens
    // at EOT, not after a single sector.
    const side0 = makeTrack([makeSector(0, 0, 0xC1, 2, 0x10), makeSector(0, 0, 0xC2, 2, 0x11)]);
    const side1 = makeTrack([makeSector(0, 1, 0xC1, 2, 0x80), makeSector(0, 1, 0xC2, 2, 0x81)]);
    const img = makeImage({ numTracks: 1, numSides: 2 });
    img.tracks[0][0] = side0;
    img.tracks[0][1] = side1;
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(img, 0);

    [0x86, 0x00, 0, 0, 0xC1, 2, 0xC2, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data } = d.drainReadExecution();
    expect(data.length).toBe(2048); // 4 sectors × 512
    expect([data[0], data[512], data[1024], data[1536]]).toEqual([0x10, 0x11, 0x80, 0x81]);
  });

  it('MT on a single-sided disk terminates at EOT (no side-1 track)', () => {
    // No head-1 track exists, so MT must fall back to normal End-of-Cylinder
    // termination rather than hanging or erroring.
    const img = makeImage({ numTracks: 1, numSides: 1 });
    img.tracks[0][0] = makePlus3Track(0, 0, 0x10);
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(img, 0);

    [0x86, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    expect(data.length).toBe(512);       // side 0 only
    expect(result[4]).toBe(0);           // H stays 0
    expect(result[1] & 0x80).toBe(0x80); // EN at side-0 EOT
  });

  it('SK (bit 5) is unmodelled — a DDAM sector terminates the read (SK=0 semantics)', () => {
    // SK is masked off, so READ_DATA always behaves as SK=0: on encountering a
    // Deleted Data Address Mark it reads that sector, sets CM, and TERMINATES —
    // it does not skip ahead, nor (post-fix) read on past it. With SK=1 honoured
    // real hardware would instead skip the deleted sector and read 0xC2; that's
    // still not modelled, which is what this test pins.
    const tr = makeTrack([
      makeSector(0, 0, 0xC1, 2, 0xAA, 0, 0x40), // DDAM
      makeSector(0, 0, 0xC2, 2, 0xBB, 0, 0),
    ]);
    const im = makeImage();
    im.tracks[0][0] = tr;
    d.fdc.ejectDisk(0);
    d.fdc.insertDisk(im, 0);

    // 0x26 = READ_DATA | SK, EOT=0xC2 (two sectors available)
    [0x26, 0x00, 0, 0, 0xC1, 2, 0xC2, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    // Stops at the DDAM sector — only its data is transferred, 0xC2 is not read.
    expect(data.length).toBe(512);
    expect(data[0]).toBe(0xAA);
    expect(result[2] & 0x40).toBe(0x40); // ST2.CM — deleted mark seen
    expect(result[5]).toBe(0xC1);        // stopped at the DDAM sector
    expect(result[0] & 0x40).toBe(0x00); // normal termination (CM is not abnormal)
    expect(result[1] & 0x80).toBe(0x00); // no End-of-Cylinder
    // FUTURE: with SK honoured, this would instead skip 0xC1 and read 0xC2.
  });

  // SCAN_EQUAL/LOW_EQ/HIGH_EQ are intentionally NOT implemented. Real SCAN is a
  // host-writes-comparison-bytes operation that sets ST2.SH/SN — modelling it as
  // a plain read would invert the data direction and never set those bits. No
  // known +3 software issues SCAN, so we reject it as an invalid command and
  // latch a flag the UI surfaces. These tests pin that contract.
  for (const [name, opcode] of [
    ['SCAN_EQUAL', 0x11],
    ['SCAN_LOW_EQ', 0x19],
    ['SCAN_HIGH_EQ', 0x1D],
  ] as const) {
    it(`${name} (0x${opcode.toString(16)}) is rejected as an invalid command`, () => {
      // Full 8-param command, exactly as a real SCAN would be issued.
      const res = d.command(opcode, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0x00);
      // Single result byte = ST0 with the invalid-command code, no execution phase.
      expect(res).toEqual([ST0_INVALID]);
      // The MSR returns to idle (no lingering CB/EXM execution state).
      expect(d.fdc.readStatus()).toBe(RQM);
      // And the one-off UI latch carries the masked opcode for the frame bridge.
      expect(d.fdc.unsupportedScan).toBe(opcode);
    });
  }

  it('the unsupportedScan latch starts clear', () => {
    expect(d.fdc.unsupportedScan).toBe(-1);
  });
});

describe('uPD765A — UNSUPPORTED: FM-only edge cases', () => {
  it('FM-mode READ_ID (0x0A without MF bit) is indistinguishable from MFM today', () => {
    const d = new Driver();
    d.fdc.insertDisk(makeStdImage(), 0);
    const mfm = d.command(0x4A, 0x00); // READ_ID | MF
    const fm  = d.command(0x0A, 0x00); // READ_ID, no MF
    // Different sector IDs only because idIndex cycles — but the status word
    // and CHRN-shape should look the same.
    expect(mfm.length).toBe(fm.length);
    expect(mfm[0]).toBe(fm[0]); // ST0
    // FUTURE: an FM read of an MFM-only disk should plausibly produce ST1.MA.
    expect(mfm[1]).toBe(0x00);
    expect(fm[1]).toBe(0x00);
  });

  it('Specify-driven NDM/non-DMA mode is accepted and ignored', () => {
    const d = new Driver();
    // SPECIFY with ND bit set in HLT param (low bit) — would mean non-DMA mode.
    // We don't model DMA at all; the parameter is silently discarded.
    expect(d.command(0x03, 0xDF, 0x03)).toEqual([]);
    // FUTURE: in non-DMA mode the FDC raises INT for each byte instead of DRQ.
  });
});

describe('uPD765A — CRC-error sector is an abnormal termination (Fuse parity)', () => {
  // Hexagon (unsigned) and similar protections read a sector flagged with a
  // data CRC error (ST1.DE 0x20 / ST2.DD 0x20), break the read loop early, and
  // require the result to report abnormal termination (ST0 bit 6). Fuse sets
  // ST0_INT_ABNORM whenever a data CRC error is seen during READ_DATA.

  function imageWith(st1: number, st2: number): DskImage {
    const im = makeImage();
    // Two sectors so an early-broken read does NOT hit EOT — isolating the
    // abnormal-termination contribution to the CRC error alone, not End-of-Cyl.
    im.tracks[0][0] = makeTrack([
      makeSector(0, 0, 0xC1, 2, 0xAB, st1, st2),
      makeSector(0, 0, 0xC2, 2, 0xCD, 0, 0),
    ]);
    return im;
  }

  it('overrun read of a clean sector reports normal termination (ST0=0x00)', () => {
    const d = new Driver();
    d.fdc.insertDisk(imageWith(0, 0), 0);
    // READ_DATA C=0 H=0 R=0xC1 N=2 EOT=0xC2 (won't reach EOT — we break early)
    const res = d.overrunRead(0x06, 0x00, 0, 0, 0xC1, 2, 0xC2, 0x2A, 0xFF);
    expect(res[1] & 0x10).toBe(0x10); // ST1.OR set (overrun happened)
    expect(res[0] & 0x40).toBe(0x00); // ST0 not abnormal — proves overrun alone doesn't set it
  });

  it('overrun read of a CRC-error sector reports abnormal termination (ST0 bit 6)', () => {
    const d = new Driver();
    d.fdc.insertDisk(imageWith(0x20, 0x60), 0); // DE + (CM|DD) — the Hexagon flags
    const res = d.overrunRead(0x06, 0x00, 0, 0, 0xC1, 2, 0xC2, 0x2A, 0xFF);
    expect(res[0] & 0x40).toBe(0x40); // ST0 abnormal termination — the missing behaviour
    expect(res[1] & 0x20).toBe(0x20); // ST1.DE still reported
    expect(res[2] & 0x20).toBe(0x20); // ST2.DD still reported
  });

  it('does not flag abnormal termination on a write to a CRC-error sector', () => {
    const d = new Driver();
    d.fdc.insertDisk(imageWith(0x20, 0x60), 0);
    // Partial (overrun) WRITE_DATA C=0 H=0 R=0xC1 N=2 EOT=0xC2 — breaks early so
    // no EOT, isolating whether the CRC-error rule wrongly fires on writes.
    d.fdc.writeData(0x05); // WRITE_DATA
    [0x00, 0, 0, 0xC1, 2, 0xC2, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    d.fdc.writeData(0x00); d.fdc.writeData(0x00); // feed two data bytes
    for (let i = 0; i < 40; i++) d.fdc.readStatus(); // overrun-terminate the write
    const res = d.drainResult();
    expect(res[1] & 0x10).toBe(0x10); // ST1.OR — overrun did terminate it
    expect(res[0] & 0x40).toBe(0x00); // ST0 NOT abnormal — CRC rule is read-only
  });
});

describe('uPD765A — mid-stream termination (error/control mark on a non-final sector)', () => {
  // A real uPD765A multi-sector read stops AT the sector that carries a data CRC
  // error or a control-mark (DDAM) mismatch — it does not read on to R+1. These
  // pin that the error/CHRN survive into the result and later sectors are not
  // transferred. (The single-/final-sector cases keep the existing EOT path.)
  let d: Driver;
  beforeEach(() => { d = new Driver(); });

  function imageOf(sectors: DskSector[]): DskImage {
    const im = makeImage();
    im.tracks[0][0] = makeTrack(sectors);
    return im;
  }

  it('a data-CRC error on a non-final sector terminates the read at that sector', () => {
    d.fdc.insertDisk(imageOf([
      makeSector(0, 0, 0xC1, 2, 0xAA, 0x20, 0x20), // DE + DD
      makeSector(0, 0, 0xC2, 2, 0xBB, 0, 0),
    ]), 0);
    // READ_DATA R=0xC1 EOT=0xC2 — a full multi-sector drain (no overrun).
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC2, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    expect(data.length).toBe(512);       // only sector 0xC1 transferred
    expect(data[0]).toBe(0xAA);
    expect(result[0] & 0x40).toBe(0x40); // ST0 abnormal termination
    expect(result[1] & 0x20).toBe(0x20); // ST1.DE preserved
    expect(result[2] & 0x20).toBe(0x20); // ST2.DD preserved
    expect(result[1] & 0x80).toBe(0x00); // NOT End-of-Cylinder (EOT not reached)
    expect(result[5]).toBe(0xC1);        // CHRN R = the errored sector
  });

  it('reads through clean sectors and stops only at the errored one', () => {
    d.fdc.insertDisk(imageOf([
      makeSector(0, 0, 0xC1, 2, 0x11, 0, 0),
      makeSector(0, 0, 0xC2, 2, 0x22, 0x20, 0x20), // bad CRC
      makeSector(0, 0, 0xC3, 2, 0x33, 0, 0),
    ]), 0);
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC3, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    expect(data.length).toBe(1024);      // 0xC1 + 0xC2, never reaches 0xC3
    expect([data[0], data[512]]).toEqual([0x11, 0x22]);
    expect(result[0] & 0x40).toBe(0x40); // abnormal at 0xC2
    expect(result[5]).toBe(0xC2);
  });

  it('a DDAM sector mid-stream terminates a READ_DATA with CM (normal termination)', () => {
    d.fdc.insertDisk(imageOf([
      makeSector(0, 0, 0xC1, 2, 0xAA, 0, 0x40), // DDAM
      makeSector(0, 0, 0xC2, 2, 0xBB, 0, 0),
    ]), 0);
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC2, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    expect(data.length).toBe(512);       // stops at the deleted sector
    expect(result[2] & 0x40).toBe(0x40); // ST2.CM
    expect(result[0] & 0x40).toBe(0x00); // normal termination (CM not abnormal)
    expect(result[1] & 0x80).toBe(0x00); // no End-of-Cylinder
    expect(result[5]).toBe(0xC1);
  });

  it('READ_DELETED accepts a DDAM sector and stops at a normal-mark sector', () => {
    // For READ_DELETED the mark sense is inverted: a DDAM sector is the expected
    // type (CM clear, continue); a normal-AM sector is the mismatch that stops it.
    d.fdc.insertDisk(imageOf([
      makeSector(0, 0, 0xC1, 2, 0xAA, 0, 0x40), // DDAM — expected, continue
      makeSector(0, 0, 0xC2, 2, 0xBB, 0, 0),     // normal — mismatch, stop here
      makeSector(0, 0, 0xC3, 2, 0xCC, 0, 0x40),  // never reached
    ]), 0);
    // 0x0C = READ_DELETED, R=0xC1 EOT=0xC3
    [0x0C, 0x00, 0, 0, 0xC1, 2, 0xC3, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    expect(data.length).toBe(1024);      // 0xC1 (deleted, ok) + 0xC2 (normal, stop)
    expect([data[0], data[512]]).toEqual([0xAA, 0xBB]);
    expect(result[2] & 0x40).toBe(0x40); // CM set at the mismatching normal sector
    expect(result[5]).toBe(0xC2);
  });

  it('a CRC error on the FINAL sector still reports End-of-Cylinder (unchanged)', () => {
    // The errored sector is also the last, so the existing EOT path runs:
    // abnormal + EN, exactly as before this change.
    d.fdc.insertDisk(imageOf([
      makeSector(0, 0, 0xC1, 2, 0xAA, 0x20, 0x20),
    ]), 0);
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    expect(data.length).toBe(512);
    expect(result[0] & 0x40).toBe(0x40); // abnormal
    expect(result[1] & 0x80).toBe(0x80); // EN (End of Cylinder) — last sector
    expect(result[2] & 0x20).toBe(0x20); // DD preserved
  });

  it('multi-sector READ_DELETED over all-matching DDAM reports CM clear (ST2=0x00)', () => {
    // The Speedlock 1987/1988 protection probe: READ_DELETED R=2 EOT=8 over
    // sectors that are ALL deleted-data (matching the command). The mark matches
    // on every sector, so CM must be CLEAR (0x00) in the result — consistent with
    // the single-sector DDAM checks. (An earlier build leaked the last sector's
    // raw DSK ST2=0x40 here because subsequent sectors weren't run through the
    // command-relative flag logic; verified against Platoon + Barbarian II, which
    // boot with ST2=0x00.) The read still ends with End-of-Cylinder at EOT.
    d.fdc.insertDisk(imageOf([
      makeSector(0, 0, 0xC1, 2, 0x10, 0, 0x40), // DDAM
      makeSector(0, 0, 0xC2, 2, 0x11, 0, 0x40), // DDAM
      makeSector(0, 0, 0xC3, 2, 0x12, 0, 0x40), // DDAM
    ]), 0);
    // 0x0C = READ_DELETED, R=0xC1 EOT=0xC3 (all three sectors, marks all match)
    [0x0C, 0x00, 0, 0, 0xC1, 2, 0xC3, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    const { data, result } = d.drainReadExecution();
    expect(data.length).toBe(1536);      // all three sectors read — no early stop
    expect([data[0], data[512], data[1024]]).toEqual([0x10, 0x11, 0x12]);
    expect(result[2] & 0x40).toBe(0x00); // CM clear — marks matched on every sector
    expect(result[1] & 0x80).toBe(0x80); // EN at EOT
    expect(result[5]).toBe(0xC3);        // CHRN advanced to the last sector
  });
});

describe('uPD765A — weak (DD) vs stable deleted-data (CM+DD) reads', () => {
  // A weak sector (Speedlock) is DD alone and must vary between reads. A
  // bad-CRC *deleted-data* sector (CM+DD, e.g. Hexagon) holds stable, meaningful
  // data (used as a decryption key) and must read back byte-for-byte identical.
  function readFull(d: Driver): number[] {
    [0x06, 0x00, 0, 0, 0xC1, 2, 0xC1, 0x2A, 0xFF].forEach(b => d.fdc.writeData(b));
    return d.drainReadExecution().data;
  }

  it('DD-only sector (weak) varies between reads', () => {
    const d = new Driver();
    const im = makeImage();
    im.tracks[0][0] = makeTrack([makeSector(0, 0, 0xC1, 2, 0xAB, 0x00, 0x20)]);
    d.fdc.insertDisk(im, 0);
    expect(readFull(d)).not.toEqual(readFull(d));
  });

  it('CM+DD sector (deleted data, bad CRC) reads back stable, unrandomised data', () => {
    const d = new Driver();
    const im = makeImage();
    im.tracks[0][0] = makeTrack([makeSector(0, 0, 0xC1, 2, 0xAB, 0x20, 0x60)]);
    d.fdc.insertDisk(im, 0);
    const first = readFull(d);
    expect(first).toEqual(readFull(d));         // identical across reads
    expect(first.every(b => b === 0xAB)).toBe(true); // exactly the stored bytes
  });
});
