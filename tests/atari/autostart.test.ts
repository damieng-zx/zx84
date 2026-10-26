/**
 * Atari auto-start: planning, key generation, the step runner and the media
 * routing, plus real-OS end-to-end cases.
 *
 * Expectations come from the documented formats, not from the code:
 *  - DOS 2.x directory: VTOC in sector 360, entries in sectors 361-368 (16
 *    bytes each: flag, sector count LE, start sector LE, 8 + 3 name). Flag
 *    bit 6 = in use, bit 7 = deleted. Each data sector ends with three
 *    bytes: file number << 2 | next-sector high bits, next-sector low byte,
 *    count of data bytes;
 *  - a boot tape's first record carries the boot header (flags 0, record
 *    count, load address, init address); a CSAVEd BASIC program starts with
 *    two zero bytes (BASIC's `SAVE` header), a LISTed one with the digits of
 *    its first line number;
 *  - holding OPTION through power-on keeps XL BASIC out (the 400/800's BASIC
 *    is a cartridge), holding START makes the OS boot the cassette;
 *  - Atari keyboard scan codes (the OS key tables): R $28, U $0B, N $23,
 *    SPACE $21, 2 $1E (SHIFT-2 is "), D $3A, ; $02 (SHIFT-; is :), . $22,
 *    A $3F, B $15, S $3E, RETURN $0C.
 * The end-to-end cases need the OS and BASIC images (see cassette.test.ts)
 * and are skipped without them.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import {
  AtariAutostart, compileAutostart, isBasicProgram, keyEventFor, keyEventsFor, opsForDisk,
  opsForTape, planForDisk, planForTape, readDirectory, readDosFile, screenIsReady,
  type AutostartHost, type AutostartStep,
} from '@/machines/atari/autostart.ts';
import { mapAtariKey } from '@/machines/atari/keyboard.ts';
import { atariInfo, type AtariModel } from '@/machines/atari/models.ts';
import { parseAtariDisk } from '@/media/floppy/atr.ts';
import {
  CAS_EOF, CAS_FULL, parseAtariCas, sioChecksum, writeAtariCas, type AtariCasRecord,
} from '@/media/tape/atari-cas.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

interface FileSpec {
  name: string;
  ext: string;
  data: Uint8Array;
  /** Sectors to use, in order; default the next free ones from sector 4. */
  chain?: number[];
}

interface DiskOptions {
  sectorSize?: 128 | 256;
  sectorCount?: number;
  /** Bytes for sector 1 (the boot record). */
  boot?: Uint8Array;
  /** Leave the directory empty. */
  noDirectory?: boolean;
}

const ascii = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));
const pad = (s: string, n: number) => s.padEnd(n, ' ');

/** Build an ATR holding a DOS 2.x style file system. */
function dosDisk(files: FileSpec[], opts: DiskOptions = {}): Uint8Array {
  const size = opts.sectorSize ?? 128;
  const count = opts.sectorCount ?? 720;
  const bodyLen = 3 * 128 + (count - 3) * size;
  const out = new Uint8Array(16 + bodyLen);
  const paragraphs = bodyLen >> 4;
  out.set([0x96, 0x02, paragraphs & 0xff, (paragraphs >> 8) & 0xff, size & 0xff, size >> 8, paragraphs >> 16]);
  const offset = (s: number) => (s <= 3 ? 16 + (s - 1) * 128 : 16 + 3 * 128 + (s - 4) * size);
  const len = (s: number) => (s <= 3 ? 128 : size);
  if (opts.boot) out.set(opts.boot, offset(1));
  out[offset(360)] = 2; // VTOC: DOS 2 code

  let nextFree = 4;
  const allocate = (): number => {
    while (nextFree >= 360 && nextFree <= 368) nextFree++;
    return nextFree++;
  };
  const perSector = len(361) / 16;
  files.forEach((f, index) => {
    const capacity = size - 3;
    const needed = Math.max(1, Math.ceil(f.data.length / capacity));
    const chain = f.chain ?? Array.from({ length: needed }, allocate);
    chain.forEach((s, i) => {
      const o = offset(s);
      const part = f.data.subarray(i * capacity, (i + 1) * capacity);
      out.set(part, o);
      const next = i + 1 < chain.length ? chain[i + 1] : 0;
      out[o + size - 3] = (index << 2) | (next >> 8);
      out[o + size - 2] = next & 0xff;
      out[o + size - 1] = part.length;
    });
    if (opts.noDirectory) return;
    const e = offset(361 + Math.floor(index / perSector)) + (index % perSector) * 16;
    out.set([0x42, chain.length & 0xff, chain.length >> 8, chain[0] & 0xff, chain[0] >> 8], e);
    out.set(ascii(pad(f.name, 8) + pad(f.ext, 3)), e + 5);
  });
  return out;
}

const file = (name: string, ext: string, data: Uint8Array | string = 'x', chain?: number[]): FileSpec => ({
  name, ext, data: typeof data === 'string' ? ascii(data) : data, chain,
});

/** A SAVEd BASIC program: the 14-byte header, then `body`. Words are the
 *  offsets of VNT, VNTE, STMTAB, STMCUR, STARP and the end, relative to
 *  LOMEM, with the body running from VNT to the end. */
function basicProgram(bodyLength = 20): Uint8Array {
  const vnt = 0x100;
  const end = vnt + bodyLength;
  const w = [0, vnt, vnt + 1, vnt + 2, end - 2, end - 1, end];
  const out = new Uint8Array(14 + bodyLength).fill(0x41);
  w.forEach((v, i) => { out[2 * i] = v & 0xff; out[2 * i + 1] = v >> 8; });
  return out;
}

/** A tiny binary-load file: the colour-register loop, optionally padded. */
function colorProgram(extra = 0): Uint8Array {
  const parts: number[] = [
    0xff, 0xff, 0x00, 0x20, 0x07, 0x20,
    0xa9, 0x46, 0x8d, 0xc8, 0x02, 0x4c, 0x05, 0x20, // LDA #$46; STA COLOR4; JMP *
  ];
  if (extra > 0) {
    const end = 0x3000 + extra - 1;
    parts.push(0x00, 0x30, end & 0xff, end >> 8, ...new Array(extra).fill(0xea));
  }
  parts.push(0xe0, 0x02, 0xe1, 0x02, 0x00, 0x20); // RUNAD = $2000
  return Uint8Array.from(parts);
}

function disk(files: FileSpec[], opts?: DiskOptions) {
  return parseAtariDisk(dosDisk(files, opts))!;
}

/** One cassette record: markers, control byte, 128 data bytes, checksum. */
function tapeRecord(control: number, data: ArrayLike<number>): Uint8Array {
  const frame = new Uint8Array(131);
  frame.set([0x55, 0x55, control]);
  frame.set(Array.from(data).slice(0, 128), 3);
  const out = new Uint8Array(132);
  out.set(frame);
  out[131] = sioChecksum(frame);
  return out;
}

function tape(records: Uint8Array[]): Uint8Array {
  return writeAtariCas({
    description: 'test',
    records: records.map((data): AtariCasRecord => ({ data, baud: 600, gapMs: 250 })),
  });
}

/** A boot tape's first record: flags 0, one record, load $0700, init $070F,
 *  boot code that points DOSVEC at $0710 (a loop storing $46 in COLOR4) and
 *  returns with carry clear. */
function bootRecordData(): Uint8Array {
  const data = new Uint8Array(128);
  data.set([0x00, 0x01, 0x00, 0x07, 0x0f, 0x07]);
  data.set([0xa9, 0x10, 0x85, 0x0a, 0xa9, 0x07, 0x85, 0x0b, 0x18, 0x60], 6);
  data.set([0xa9, 0x46, 0x8d, 0xc8, 0x02, 0x4c, 0x10, 0x07], 16);
  return data;
}

const bootTape = () => tape([tapeRecord(CAS_FULL, bootRecordData()), tapeRecord(CAS_EOF, [])]);
const planTape = (data: Uint8Array) => planForTape(parseAtariCas(data)!);

// ── Key events ──────────────────────────────────────────────────────────────

describe('atari auto-start key events', () => {
  it('types RUN "D:A.BAS" and RETURN with the Atari keys', () => {
    const events = keyEventsFor('RUN "D:A.BAS"\n')!;
    const pressed = events.map(e => {
      const k = mapAtariKey(e)!;
      return [k.code, k.shift];
    });
    expect(pressed).toEqual([
      [0x28, false], [0x0b, false], [0x23, false], // R U N
      [0x21, false],                                // space
      [0x1e, true],                                 // "  (SHIFT-2)
      [0x3a, false], [0x02, true],                  // D :  (SHIFT-;)
      [0x3f, false], [0x22, false],                 // A .
      [0x15, false], [0x3f, false], [0x3e, false],  // B A S
      [0x1e, true],                                 // "
      [0x0c, false],                                // RETURN
    ]);
  });

  it('gives digits and letters their own host codes, and no event for what has no key', () => {
    expect(keyEventFor('7')).toMatchObject({ code: 'Digit7', key: '7' });
    expect(keyEventFor('Q')).toMatchObject({ code: 'KeyQ', key: 'q' });
    expect(keyEventFor('\n')).toMatchObject({ code: 'Enter' });
    expect(keyEventFor('~')).toBeNull();
    expect(keyEventFor('{')).toBeNull();
    expect(keyEventsFor('RUN ~')).toBeNull();
    expect(keyEventsFor('')).toEqual([]);
  });
});

describe('screenIsReady', () => {
  it.each([
    ['READY', true],
    ['Ready', true], // Altirra BASIC
    ['  READY  ', true],
    ['CLOAD\nREADY\n  \n', true],
    ['READY\nPRINT 1', false],
    ['NOT READY', false],
    ['READYX', false],
    ['READ', false],
    ['', false],
    ['\n\n', false],
  ])('%j -> %s', (text, expected) => {
    expect(screenIsReady(text)).toBe(expected);
  });
});

// ── Disk planning ───────────────────────────────────────────────────────────

describe('atari directory reading', () => {
  it('lists in-use files only, skipping deleted, open and sub-directory entries', () => {
    const raw = dosDisk([file('KEEP', 'TXT'), file('GONE', 'TXT'), file('OPEN', 'TXT'), file('SUBDIR', ''), file('LAST', 'COM')]);
    // Flip the flags: entry 1 deleted ($80|$40), 2 opened for output ($41), 3 a MyDOS directory ($50).
    const dir = 16 + (361 - 1) * 128 - 0; // sector 361 (all sectors up to here are 128 bytes)
    raw[dir + 16] = 0xc2;
    raw[dir + 32] = 0x43;
    raw[dir + 48] = 0x52;
    const entries = readDirectory(parseAtariDisk(raw)!)!;
    expect(entries.map(e => `${e.name}.${e.ext}`)).toEqual(['KEEP.TXT', 'LAST.COM']);
    expect(entries[1].index).toBe(4);
  });

  it('is null for a disk without a directory, or with garbage in it', () => {
    expect(readDirectory(disk([], {}))).toBeNull();
    const raw = dosDisk([file('A', 'B')]);
    raw[16 + 360 * 128 + 5] = 0x07; // a control character where the name starts
    expect(readDirectory(parseAtariDisk(raw)!)).toBeNull();
    const far = dosDisk([file('A', 'B')]);
    far[16 + 360 * 128 + 3] = 0xff; // start sector 0x0FF? still inside; push it out of range
    far[16 + 360 * 128 + 4] = 0x7f;
    expect(readDirectory(parseAtariDisk(far)!)).toBeNull();
  });

  it('follows a sector chain that is not in order, across the directory area', () => {
    const data = Uint8Array.from({ length: 125 * 2 + 40 }, (_, i) => (i * 7 + 3) & 0xff);
    const d = disk([file('SCATTER', 'BIN', data, [500, 5, 300])]);
    const entry = readDirectory(d)![0];
    expect(entry.start).toBe(500);
    const got = readDosFile(d, entry)!;
    expect(got.length).toBe(290);
    expect([...got]).toEqual([...data]);
  });

  it('reads 256-byte sectors with the trailer in the last three bytes', () => {
    const data = Uint8Array.from({ length: 253 + 100 }, (_, i) => (i ^ 0x5a) & 0xff);
    const d = disk([file('BIGSEC', 'COM', data)], { sectorSize: 256 });
    const entry = readDirectory(d)![0];
    expect(entry.sectors).toBe(2);
    expect([...readDosFile(d, entry)!]).toEqual([...data]);
  });

  it('gives up on a chain that loops or runs off the disk', () => {
    const loop = disk([file('LOOP', 'COM', new Uint8Array(300))]);
    const entry = readDirectory(loop)![0];
    // Make the last sector point back at the first.
    const raw = dosDisk([file('LOOP', 'COM', new Uint8Array(300))]);
    const last = 16 + (6 - 1) * 128;
    raw[last + 125] = 0;
    raw[last + 126] = 4;
    expect(readDosFile(parseAtariDisk(raw)!, entry)).toBeNull();
    // A count byte larger than the sector holds is not a data sector.
    const bad = dosDisk([file('BAD', 'COM', new Uint8Array(10))]);
    bad[16 + 3 * 128 + 127] = 126;
    expect(readDosFile(parseAtariDisk(bad)!, readDirectory(parseAtariDisk(bad)!)![0])).toBeNull();
  });
});

describe('isBasicProgram', () => {
  it('accepts a SAVE header whose length matches, and rejects near misses', () => {
    expect(isBasicProgram(basicProgram(20))).toBe(true);
    const long = basicProgram(20);
    expect(isBasicProgram(long.subarray(0, long.length - 1))).toBe(false); // one byte short
    expect(isBasicProgram(Uint8Array.from([...long, 0, 0, 0]))).toBe(true); // arrays and strings follow
    const nonzero = basicProgram(20);
    nonzero[0] = 1;
    expect(isBasicProgram(nonzero)).toBe(false);
    const falling = basicProgram(20);
    falling[8] = 0x00; falling[9] = 0x00; // STMTAB below VNTE
    expect(isBasicProgram(falling)).toBe(false);
    expect(isBasicProgram(new Uint8Array(14))).toBe(false); // an empty program is not a program
    expect(isBasicProgram(new Uint8Array(13))).toBe(false);
  });
});

describe('planForDisk', () => {
  const dos = [file('DOS', 'SYS', 'D'), file('DUP', 'SYS', 'U')];

  it('boots a disk with no directory with BASIC off (a custom boot disk)', () => {
    expect(planForDisk(disk([]))).toEqual({ kind: 'boot', basic: false });
    // File data without directory entries is still no directory.
    expect(planForDisk(disk([file('X', 'BAS', basicProgram())], { noDirectory: true }))).toEqual({ kind: 'boot', basic: false });
  });

  it('boots a custom boot disk with BASIC on when its name is tagged as BASIC', () => {
    expect(planForDisk(disk([]), 'Paccie (19xx)(Elwood Software)[BASIC][bas2boot].atr')).toEqual({ kind: 'boot', basic: true });
    expect(planForDisk(disk([]), 'Pontoon (19xx)(-)[bas2boot].atr')).toEqual({ kind: 'boot', basic: true });
    expect(planForDisk(disk([]), 'Basic Thing (1984).atr')).toEqual({ kind: 'boot', basic: false });
  });

  it('boots a disk with AUTORUN.SYS; BASIC only when the disk has a BASIC file', () => {
    expect(planForDisk(disk([...dos, file('AUTORUN', 'SYS', colorProgram())]))).toEqual({ kind: 'boot', basic: false });
    expect(planForDisk(disk([...dos, file('AUTORUN', 'SYS'), file('GAME', 'BAS', basicProgram())]))).toEqual({ kind: 'boot', basic: true });
    // A BASIC program with no .BAS extension counts too.
    expect(planForDisk(disk([...dos, file('AUTORUN', 'SYS'), file('BOAT', '', basicProgram())]))).toEqual({ kind: 'boot', basic: true });
    // A data file that merely starts with zeros does not.
    expect(planForDisk(disk([...dos, file('AUTORUN', 'SYS'), file('FONT', 'FNT', new Uint8Array(40))]))).toEqual({ kind: 'boot', basic: false });
  });

  it('runs the one BASIC file, typing D: and its name', () => {
    expect(planForDisk(disk([...dos, file('MAZE3D', 'BAS', basicProgram())])))
      .toEqual({ kind: 'run-basic', file: 'MAZE3D.BAS' });
    // No extension: just the name.
    expect(planForDisk(disk([...dos, file('BLCKJACK', '', basicProgram())])))
      .toEqual({ kind: 'run-basic', file: 'BLCKJACK' });
  });

  it('prefers the conventional name, then the disk name, among several BASIC files', () => {
    const many = (...names: string[]) => disk([...dos, ...names.map(n => file(n, 'BAS', basicProgram()))]);
    expect(planForDisk(many('ZED', 'MENU', 'ALPHA'), 'x.atr')).toMatchObject({ file: 'MENU.BAS' });
    expect(planForDisk(many('ZED', 'START', 'LOADER'), 'x.atr')).toMatchObject({ file: 'START.BAS' });
    expect(planForDisk(many('ZED', 'ALPHA'), 'Alpha (1984)(Antic).atr')).toMatchObject({ file: 'ALPHA.BAS' });
    expect(planForDisk(many('ZED', 'ALPHA'), 'nothing.atr')).toMatchObject({ file: 'ZED.BAS' }); // the first
  });

  it('loads a single binary file from DUP, never DOS.SYS or DUP.SYS', () => {
    // A binary across a scattered sector chain is still recognised.
    const plan = planForDisk(disk([...dos, file('GAME', 'COM', colorProgram(200), [700, 20, 11])]));
    expect(plan).toEqual({ kind: 'dup-load', file: 'GAME.COM' });
  });

  it('picks the binary named like the menu or the disk among several, else shows DOS', () => {
    const two = (a: string, b: string, name = 'x.atr') =>
      planForDisk(disk([...dos, file(a, 'EXE', colorProgram()), file(b, 'COM', colorProgram())]), name);
    expect(two('TOOL', 'MENU')).toEqual({ kind: 'dup-load', file: 'MENU.COM' });
    expect(two('TOOL', 'KONG', 'Kong (1983).atr')).toEqual({ kind: 'dup-load', file: 'KONG.COM' });
    expect(two('TOOL', 'OTHER')).toEqual({ kind: 'boot', basic: false });
  });

  it('boots a DOS without DUP.SYS as it is (it has no menu to load from)', () => {
    expect(planForDisk(disk([file('DOS', 'SYS', 'D'), file('GAME', 'COM', colorProgram())])))
      .toEqual({ kind: 'boot', basic: false });
  });

  it('boots rather than extracts when the disk is not DOS-booted: no DOS.SYS, or one that cannot be read', () => {
    // No DOS.SYS: the boot sectors are the program's own loader.
    expect(planForDisk(disk([file('GAME', 'COM', colorProgram())]))).toEqual({ kind: 'boot', basic: false });
    // A DOS.SYS whose sector chain runs off the disk: a placeholder directory.
    const raw = dosDisk([file('DOS', 'SYS', 'D', [5]), file('GAME', 'COM', colorProgram())]);
    raw[16 + 4 * 128 + 125] = 0x03; // next sector 0x3FF: beyond the 720 sectors
    raw[16 + 4 * 128 + 126] = 0xff;
    expect(planForDisk(parseAtariDisk(raw)!)).toEqual({ kind: 'boot', basic: false });
  });

  it('ignores a "binary" that is not one, and a disk of data files only', () => {
    expect(planForDisk(disk([...dos, file('TEXT', 'COM', 'not a binary load file at all')]))).toEqual({ kind: 'boot', basic: false });
    expect(planForDisk(disk([...dos, file('NOTES', 'TXT', 'hello')]))).toEqual({ kind: 'boot', basic: false });
    expect(planForDisk(disk(dos))).toEqual({ kind: 'boot', basic: false });
  });

  it('prefers BASIC over a binary, and AUTORUN.SYS over both', () => {
    expect(planForDisk(disk([...dos, file('TOOL', 'COM', colorProgram()), file('GO', 'BAS', basicProgram())])))
      .toEqual({ kind: 'run-basic', file: 'GO.BAS' });
    expect(planForDisk(disk([...dos, file('TOOL', 'COM', colorProgram()), file('AUTORUN', 'SYS')])))
      .toEqual({ kind: 'boot', basic: false });
  });

  it('reads a double-density directory (16 entries per sector)', () => {
    const files = [...dos];
    for (let i = 0; i < 12; i++) files.push(file(`F${i}`, 'DAT'));
    files.push(file('LATE', 'BAS', basicProgram()));
    expect(planForDisk(disk(files, { sectorSize: 256 }))).toEqual({ kind: 'run-basic', file: 'LATE.BAS' });
  });

  it('turns plans into scripts', () => {
    expect(opsForDisk({ kind: 'boot', basic: false })).toEqual([{ op: 'boot', basic: false }]);
    expect(opsForDisk({ kind: 'run-basic', file: 'A.BAS' })).toEqual([
      { op: 'boot', basic: true },
      { op: 'ready', max: expect.any(Number) },
      { op: 'type', text: 'RUN "D:A.BAS"\n' },
    ]);
    expect(opsForDisk({ kind: 'dup-load', file: 'A.COM' })).toEqual([
      { op: 'boot', basic: false },
      { op: 'prompt', text: 'SELECT ITEM', max: expect.any(Number), optional: true },
      { op: 'type', text: 'L\n' },
      { op: 'prompt', text: 'WHAT FILE', max: expect.any(Number) },
      { op: 'type', text: 'A.COM\n' },
    ]);
  });
});

// ── Tape planning ───────────────────────────────────────────────────────────

describe('planForTape', () => {
  it('boots a tape whose first record has a boot header', () => {
    expect(planTape(bootTape())).toEqual({ kind: 'boot' });
  });

  it('boots a tape whatever its header flags byte says (the OS ignores it)', () => {
    // Real tapes carry 0, 1, $20 ...: Shamus and Stealth have $20, Basil $01.
    for (const flags of [0x01, 0x20, 0x80]) {
      expect(planTape(tape([tapeRecord(CAS_FULL, [flags, 5, 0x00, 0x07, 0x20, 0x07]), tapeRecord(CAS_EOF, [])])))
        .toEqual({ kind: 'boot' });
    }
  });

  it('CLOADs a tape whose first record starts 0, 0 (a CSAVE header)', () => {
    expect(planTape(tape([tapeRecord(CAS_FULL, [0, 0, 0x80, 0x00, 0x91]), tapeRecord(CAS_EOF, [])])))
      .toEqual({ kind: 'basic', via: 'CLOAD' });
  });

  it('ENTERs a tape that starts with a line number (a LISTed program)', () => {
    const text = ascii('10 PRINT "HI"\x9b20 END\x9b');
    expect(planTape(tape([tapeRecord(CAS_FULL, text), tapeRecord(CAS_EOF, [])])))
      .toEqual({ kind: 'basic', via: 'ENTER' });
  });

  it('marks a BASIC tape with more than one file as chained', () => {
    const text = ascii('10 OPEN #1,4,0,"C:"\x9b');
    const second = [tapeRecord(CAS_FULL, [1, 2, 3]), tapeRecord(CAS_EOF, [])];
    expect(planTape(tape([tapeRecord(CAS_FULL, text), tapeRecord(CAS_EOF, []), ...second])))
      .toEqual({ kind: 'basic', via: 'ENTER', chained: true });
    expect(planTape(tape([tapeRecord(CAS_FULL, [0, 0, 0x80, 0x00, 0x91]), tapeRecord(CAS_EOF, []), ...second])))
      .toEqual({ kind: 'basic', via: 'CLOAD', chained: true });
  });

  it('starts nothing for a binary file, an implausible boot header or an empty tape', () => {
    expect(planTape(tape([tapeRecord(CAS_FULL, [0xff, 0xff, 0x00, 0x20])]))).toEqual({ kind: 'none' });
    // Flags 0, one record, but loading at $0050 (zero page): not a plausible boot address.
    expect(planTape(tape([tapeRecord(CAS_FULL, [0x00, 0x01, 0x50, 0x00, 0x00, 0x00])]))).toEqual({ kind: 'none' });
    // ... or at $C000, in the OS.
    expect(planTape(tape([tapeRecord(CAS_FULL, [0x00, 0x01, 0x00, 0xc0, 0x00, 0x00])]))).toEqual({ kind: 'none' });
    expect(planTape(tape([]))).toEqual({ kind: 'none' });
    // First byte one below '0' and one above '9'.
    expect(planTape(tape([tapeRecord(CAS_FULL, [0x2f, 0x31])]))).toEqual({ kind: 'none' });
    expect(planTape(tape([tapeRecord(CAS_FULL, [0x3a, 0x31])]))).toEqual({ kind: 'none' });
  });

  it('turns plans into scripts', () => {
    expect(opsForTape({ kind: 'none' })).toBeNull();
    const ops = opsForTape({ kind: 'basic', via: 'ENTER' })!;
    expect(ops.find(o => o.op === 'type')).toEqual({ op: 'type', text: 'ENTER "C:"\n' });
    expect(ops.at(-1)).toEqual({ op: 'type', text: 'RUN\n' });
    expect(opsForTape({ kind: 'boot' })![0]).toEqual({ op: 'boot', basic: false, holdStart: true });
  });

  it('loads a CSAVEd tape with RUN "C:" and no wait for READY after it', () => {
    const ops = opsForTape({ kind: 'basic', via: 'CLOAD' })!;
    expect(ops.find(o => o.op === 'type')).toEqual({ op: 'type', text: 'RUN "C:"\n' });
    expect(ops.map(o => o.op)).toEqual(['boot', 'ready', 'type', 'beep', 'wait', 'press']);
  });

  it('answers the loader\'s own OPEN of the tape when more files follow', () => {
    const ops = opsForTape({ kind: 'basic', via: 'ENTER', chained: true })!;
    const run = ops.findIndex(o => o.op === 'type' && o.text === 'RUN\n');
    expect(ops.slice(run + 1).map(o => o.op)).toEqual(['beep', 'wait', 'press']);
    // The beep is only a possibility: a program that never opens the tape
    // again must not end the script with a complaint.
    expect(ops[run + 1]).toMatchObject({ op: 'beep', optional: true });
    expect(opsForTape({ kind: 'basic', via: 'ENTER' })!.at(-1)).toEqual({ op: 'type', text: 'RUN\n' });
  });
});

// ── Compilation and the runner ──────────────────────────────────────────────

const OPTION = 'F4';
const START = 'F2';

describe('compileAutostart', () => {
  const summary = (steps: AutostartStep[] | null) =>
    steps!.map(s => ('key' in s ? `${s.op}:${s.key.code}` : 'basic' in s ? `${s.op}:${s.basic}` : s.op));

  it('holds OPTION through an XL boot without BASIC and lets go 120 frames later', () => {
    expect(summary(compileAutostart([{ op: 'boot', basic: false }], { builtinBasic: true })))
      .toEqual([`down:${OPTION}`, 'reset:false', 'wait', 'release']);
    expect(compileAutostart([{ op: 'boot', basic: false }], { builtinBasic: true })![2]).toEqual({ op: 'wait', frames: 120 });
  });

  it('needs no key to start the 400/800 without BASIC or an XL with it', () => {
    expect(summary(compileAutostart([{ op: 'boot', basic: false }], { builtinBasic: false }))).toEqual(['reset:false']);
    expect(summary(compileAutostart([{ op: 'boot', basic: true }], { builtinBasic: true }))).toEqual(['reset:true']);
  });

  it('keeps START (and OPTION on an XL) down until released', () => {
    const ops = [{ op: 'boot', basic: false, holdStart: true }, { op: 'release' }] as const;
    expect(summary(compileAutostart(ops, { builtinBasic: true })))
      .toEqual([`down:${OPTION}`, `down:${START}`, 'reset:false', 'release']);
    expect(summary(compileAutostart(ops, { builtinBasic: false })))
      .toEqual([`down:${START}`, 'reset:false', 'release']);
  });

  it('presses each typed key for 3 frames, then leaves 3 frames before the next', () => {
    const steps = compileAutostart([{ op: 'type', text: 'A\n' }], { builtinBasic: false })!;
    expect(steps.map(s => s.op)).toEqual(['down', 'wait', 'up', 'wait', 'down', 'wait', 'up', 'wait']);
    expect(steps.filter(s => s.op === 'wait')).toEqual(Array(4).fill({ op: 'wait', frames: 3 }));
    expect(compileAutostart([{ op: 'type', text: 'a~' }], { builtinBasic: false })).toBeNull();
  });
});

/** A host that logs what the runner does, stamped with the frame number. */
function fakeHost() {
  const log: string[] = [];
  let frame = 0;
  const state = { toggles: 0, screen: '' };
  const host: AutostartHost = {
    keyDown: e => { log.push(`${frame}:down ${e.code}`); },
    keyUp: e => { log.push(`${frame}:up ${e.code}`); },
    coldStart: basic => { log.push(`${frame}:reset ${basic}`); },
    speakerToggles: () => state.toggles,
    screenText: () => state.screen,
    notify: m => { log.push(`${frame}:notify ${m}`); },
  };
  const run = (script: AtariAutostart, frames: number) => {
    for (let i = 0; i < frames; i++) { frame++; script.frame(); }
  };
  return { host, log, state, run };
}

const key = (code: string): HostKeyEvent => ({ code, key: code, shift: false, ctrl: false, alt: false });

describe('AtariAutostart runner', () => {
  it('runs the opening steps at once and each wait for exactly its frames', () => {
    const { host, log, run } = fakeHost();
    const a = key('KeyA');
    const script = new AtariAutostart(host, [
      { op: 'reset', basic: true }, { op: 'down', key: a }, { op: 'wait', frames: 3 },
      { op: 'up', key: a }, { op: 'wait', frames: 2 }, { op: 'reset', basic: false },
    ]);
    script.start();
    expect(log).toEqual(['0:reset true', '0:down KeyA']);
    run(script, 2);
    expect(log).toHaveLength(2);
    run(script, 1);
    expect(log.slice(2)).toEqual(['3:up KeyA']);
    run(script, 1);
    expect(script.finished).toBe(false);
    run(script, 1);
    expect(log.slice(3)).toEqual(['5:reset false']);
    expect(script.finished).toBe(true);
  });

  it('waits for a beep seen in a later frame, not one already in the past', () => {
    const { host, log, state, run } = fakeHost();
    state.toggles = 9; // a key click from the frame that was running
    const script = new AtariAutostart(host, [{ op: 'beep', max: 10 }, { op: 'reset', basic: true }]);
    script.start();
    expect(log).toEqual([]);
    state.toggles = 0;
    run(script, 4);
    expect(log).toEqual([]);
    state.toggles = 1;
    run(script, 1);
    expect(log).toEqual(['5:reset true']);
  });

  it('gives up quietly when the beep never comes, letting go of held keys', () => {
    const { host, log, run } = fakeHost();
    const script = new AtariAutostart(host, [
      { op: 'down', key: key(START) }, { op: 'beep', max: 5 }, { op: 'reset', basic: true },
    ]);
    script.start();
    run(script, 4);
    expect(script.finished).toBe(false);
    run(script, 1);
    expect(script.finished).toBe(true);
    expect(log).toEqual([`0:down ${START}`, `5:up ${START}`, '5:notify Auto-start gave up: the OS never beeped']);
  });

  it('looks for READY every 10 frames and ignores a stale prompt before then', () => {
    const { host, log, state, run } = fakeHost();
    state.screen = 'READY';
    const script = new AtariAutostart(host, [{ op: 'ready', max: 100 }, { op: 'reset', basic: true }]);
    script.start();
    run(script, 9);
    expect(log).toEqual([]);
    run(script, 1);
    expect(log).toEqual(['10:reset true']);
  });

  it('waits for a prompt anywhere on screen, in any case, across a line break', () => {
    const { host, log, state, run } = fakeHost();
    state.screen = 'DISK OPERATING SYSTEM\nloading';
    const script = new AtariAutostart(host, [{ op: 'prompt', text: 'SELECT ITEM', max: 100 }, { op: 'reset', basic: true }]);
    script.start();
    run(script, 10);
    expect(log).toEqual([]);
    state.screen = 'L. BINARY LOAD\nSELECT\nitem OR RETURN FOR MENU';
    run(script, 10);
    expect(log).toEqual(['20:reset true']);
  });

  it('ends quietly when an optional prompt never comes, and complains about a required one', () => {
    const { host, log, state, run } = fakeHost();
    state.screen = 'BOOT MANAGER';
    const optional = new AtariAutostart(host, [{ op: 'prompt', text: 'SELECT ITEM', max: 30, optional: true }, { op: 'reset', basic: true }]);
    optional.start();
    run(optional, 30);
    expect(optional.finished).toBe(true);
    expect(log).toEqual([]);
    const required = new AtariAutostart(host, [{ op: 'prompt', text: 'WHAT FILE', max: 30 }, { op: 'reset', basic: true }]);
    required.start();
    run(required, 30);
    expect(required.finished).toBe(true);
    expect(log).toEqual(['60:notify Auto-start gave up: "WHAT FILE" never appeared']);
  });

  it('abandons a wait for READY at its limit and says so', () => {
    const { host, log, state, run } = fakeHost();
    state.screen = 'GAME OVER';
    const script = new AtariAutostart(host, [{ op: 'ready', max: 30 }, { op: 'reset', basic: true }]);
    script.start();
    run(script, 29);
    expect(script.finished).toBe(false);
    run(script, 1);
    expect(script.finished).toBe(true);
    expect(log).toEqual(['30:notify Auto-start gave up: BASIC never reached READY']);
  });

  it('ends quietly when an optional beep never comes', () => {
    const { host, log, run } = fakeHost();
    const script = new AtariAutostart(host, [
      { op: 'beep', max: 20, optional: true },
      { op: 'reset', basic: true },
    ]);
    script.start();
    run(script, 20);
    expect(script.finished).toBe(true);
    expect(log).toEqual([]); // no complaint, and the step after it never ran
  });

  it('release lets go of every held key; cancel does too and stops the script', () => {
    const { host, log, run } = fakeHost();
    const script = new AtariAutostart(host, [
      { op: 'down', key: key('F4') }, { op: 'down', key: key('F2') }, { op: 'wait', frames: 5 },
      { op: 'release' }, { op: 'wait', frames: 5 }, { op: 'reset', basic: true },
    ]);
    script.start();
    run(script, 5);
    expect(log.slice(2)).toEqual(['5:up F2', '5:up F4']);
    run(script, 2);
    script.cancel();
    expect(script.finished).toBe(true);
    run(script, 10);
    expect(log.some(l => l.includes('reset'))).toBe(false);

    const second = fakeHost();
    const held = new AtariAutostart(second.host, [{ op: 'down', key: key('F2') }, { op: 'wait', frames: 50 }]);
    held.start();
    held.cancel();
    expect(second.log).toEqual(['0:down F2', '0:up F2']);
    held.cancel(); // a second cancel does nothing
    expect(second.log).toHaveLength(2);
  });

  it('finishes at once when the script has nothing to wait for', () => {
    const { host, log } = fakeHost();
    const script = new AtariAutostart(host, [{ op: 'reset', basic: false }]);
    script.start();
    expect(script.finished).toBe(true);
    expect(log).toEqual(['0:reset false']);
  });
});

// ── The machine and the media service (no firmware) ─────────────────────────

const casOf = (records: Uint8Array[]) => tape(records);
const csaveTape = () => casOf([tapeRecord(CAS_FULL, [0, 0, 0x80]), tapeRecord(CAS_EOF, [])]);
const basicDisk = () => dosDisk([file('DOS', 'SYS'), file('GAME', 'BAS', basicProgram())]);
const hiddenBasicImage = () => new Uint8Array(0x2000).fill(0xea);

function bare(model: AtariModel = 'atari800'): AtariMachine {
  const m = new AtariMachine(model, null);
  m.setSpeedMultiplier(0);
  return m;
}

describe('atari auto-start through the media service', () => {
  it('starts a script for a generic Load and says what it does', async () => {
    const m = bare('atari800xl');
    try {
      const boot = await m.services.media.mount(bootTape(), 'boot.cas');
      expect(boot.message).toBe('Cassette: boot.cas — booting');
      expect(m.autostart).not.toBeNull(); // the script's own reset did not cancel it
      const cload = await m.services.media.mount(csaveTape(), 'prog.cas');
      expect(cload.message).toBe('Cassette: prog.cas — RUN "C:"');
      const list = await m.services.media.mount(tape([tapeRecord(CAS_FULL, ascii('10 END\x9b'))]), 'text.cas');
      expect(list.message).toBe('Cassette: text.cas — ENTER "C:" + RUN');
      const bin = await m.services.media.mount(tape([tapeRecord(CAS_FULL, [0xff, 0xff])]), 'bin.cas');
      expect(bin.message).toContain('hold START at power-on');
      expect(m.autostart).toBeNull();
    } finally {
      m.destroy();
    }
  });

  it('boots a Load-ed disk from D1:, naming the command it will type', async () => {
    const m = bare('atari800xl');
    try {
      const r = await m.services.media.mount(basicDisk(), 'game.atr');
      expect(r).toMatchObject({ ok: true, target: 'a', message: 'Disk D1: loaded: game.atr — RUN "D:GAME.BAS"' });
      expect(m.autostart).not.toBeNull();
      const custom = await m.services.media.mount(dosDisk([], {}), 'blank.atr');
      expect(custom.message).toBe('Disk D1: loaded: blank.atr — booting (BASIC off)');
      const withAuto = await m.services.media.mount(dosDisk([file('AUTORUN', 'SYS'), file('X', 'BAS', basicProgram())]), 'a.atr');
      expect(withAuto.message).toBe('Disk D1: loaded: a.atr — booting (BASIC on)');
    } finally {
      m.destroy();
    }
  });

  it('replaces D1: even when it is full, and loads a lone program through DOS', async () => {
    const m = bare();
    try {
      await m.services.media.mount(dosDisk([], {}), 'one.atr');
      const r = await m.services.media.mount(
        dosDisk([file('DOS', 'SYS'), file('DUP', 'SYS'), file('GAME', 'COM', colorProgram())]), 'two.atr');
      expect(r.message).toBe('Disk D1: loaded: two.atr — booting DOS to load GAME.COM');
      expect(m.services.disks.drives[0].mediaName).toBe('two.atr');
      expect(m.xex).toBeNull();
      expect(m.autostart).not.toBeNull(); // typed into DUP's menu
      expect(m.services.disks.drives[1].loaded).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('never auto-starts for the Drives pane, a restore after reload, or D2:', async () => {
    const m = bare();
    try {
      for (const [target, drive] of [['unit:0', 0], ['unit:1', 1], ['a', 0], ['b', 1]] as const) {
        const r = await m.services.media.mount(basicDisk(), `d${target}.atr`, target);
        expect(r.message).toBe(`Disk D${drive + 1}: loaded: d${target}.atr`);
        expect(m.services.disks.drives[drive].mediaName).toBe(`d${target}.atr`);
        expect(m.autostart).toBeNull();
      }
      const tapeR = await m.services.media.mount(bootTape(), 'boot.cas', 'tape');
      expect(tapeR.message).toContain('hold START');
      expect(m.autostart).toBeNull();
    } finally {
      m.destroy();
    }
  });

  it('cancels a running script on any new mount, an explicit reset or a cartridge change', async () => {
    const m = bare('atari800xl');
    const consol = () => m.gtia.consol & 0x07;
    try {
      await m.services.media.mount(bootTape(), 'boot.cas');
      expect(consol()).toBe(0x02); // START and OPTION down, SELECT up
      await m.services.media.mount(basicDisk(), 'game.atr', 'unit:1');
      expect(m.autostart).toBeNull();
      expect(consol()).toBe(0x07); // the held keys were let go

      await m.services.media.mount(bootTape(), 'boot.cas');
      m.reset();
      expect(m.autostart).toBeNull();
      expect(consol()).toBe(0x07);

      await m.services.media.mount(bootTape(), 'boot.cas');
      m.services.roms.cartridge!.insert(hiddenBasicImage(), 'GAME');
      expect(m.autostart).toBeNull();

      await m.services.media.mount(bootTape(), 'boot.cas');
      expect(m.autostart).not.toBeNull();
      await m.services.media.mount(colorProgram(), 'x.xex');
      expect(m.autostart).toBeNull();
    } finally {
      m.destroy();
    }
  });
});

describe('atari auto-start BASIC handling', () => {
  it('pulls the hidden BASIC cartridge for BASIC off and puts it back for BASIC on (400/800)', () => {
    const m = bare('atari800');
    try {
      m.services.roms.cartridge!.insert(hiddenBasicImage(), '');
      expect(m.memory.cart).not.toBeNull();
      expect(m.startAutostart([{ op: 'boot', basic: false }])).toBe(true);
      expect(m.memory.cart).toBeNull();
      expect(m.cartridgeName).toBe('');
      expect(m.startAutostart([{ op: 'boot', basic: true }])).toBe(true);
      expect(m.memory.cart).not.toBeNull();
    } finally {
      m.destroy();
    }
  });

  it('leaves a cartridge the user chose in place, and refuses a BASIC script over it', () => {
    const m = bare('atari800');
    try {
      m.services.roms.cartridge!.insert(hiddenBasicImage(), '');
      m.services.roms.cartridge!.insert(hiddenBasicImage(), 'GAME.ROM');
      expect(m.startAutostart([{ op: 'boot', basic: false }])).toBe(true);
      expect(m.memory.cart).not.toBeNull();
      expect(m.startAutostart([{ op: 'boot', basic: true }])).toBe(false);
      expect(m.cartridgeName).toBe('GAME.ROM');
    } finally {
      m.destroy();
    }
  });

  it('refuses a BASIC script when no BASIC was ever supplied (400/800), but not an XL with its own', () => {
    const plain = bare('atari400');
    const xl = bare('atari600xl');
    try {
      expect(plain.canAutostartBasic()).toBe(false);
      expect(plain.startAutostart([{ op: 'boot', basic: true }])).toBe(false);
      expect(plain.autostart).toBeNull();
      expect(plain.startAutostart([{ op: 'boot', basic: false }])).toBe(true);
      expect(xl.canAutostartBasic()).toBe(true);
    } finally {
      plain.destroy();
      xl.destroy();
    }
  });

  it('holds OPTION for 120 frames on an XL booting without BASIC, then lets go', () => {
    const m = bare('atari800xl');
    try {
      expect(m.startAutostart([{ op: 'boot', basic: false }])).toBe(true);
      expect(m.gtia.consol & 0x04).toBe(0);
      for (let f = 0; f < 119; f++) m.tick();
      expect(m.gtia.consol & 0x04).toBe(0);
      m.tick();
      expect(m.gtia.consol & 0x04).toBe(0x04);
      expect(m.autostart).toBeNull();
    } finally {
      m.destroy();
    }
  });
});

// ── Real firmware, end to end ───────────────────────────────────────────────

const DIR = process.env.ATARI_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
const BASIC_ROM = resolve(DIR, 'ataribas.rom');
const OS_NAMES: Record<AtariModel, readonly string[]> = {
  atari400: ['atariosb.rom'],
  atari800: ['atariosb.rom'],
  atari600xl: ['atari600xl.rom', 'REV01.ROM'],
  atari800xl: ['atari800xl.rom', 'REV02.ROM'],
  atari1200xl: ['atari1200xl.rom', 'REV10.ROM'],
  // The XE line runs the 800XL's OS.
  atari65xe: ['atari800xl.rom', 'REV02.ROM'],
  atari800xe: ['atari800xl.rom', 'REV02.ROM'],
  atari130xe: ['atari800xl.rom', 'REV02.ROM'],
};
function osPath(model: AtariModel): string | null {
  for (const n of OS_NAMES[model]) {
    const p = resolve(DIR, n);
    if (existsSync(p)) return p;
  }
  return null;
}

/** A powered-on machine with the real OS and BASIC, as the shell leaves it. */
function powered(model: AtariModel): AtariMachine {
  const m = new AtariMachine(model, null, 'pal');
  const os = new Uint8Array(readFileSync(osPath(model)!));
  const basic = new Uint8Array(readFileSync(BASIC_ROM));
  if (atariInfo(model).builtinBasic) m.services.roms.installSystemRom(new Uint8Array([...os, ...basic]));
  else {
    m.services.roms.installSystemRom(os);
    m.services.roms.cartridge!.insert(basic, '');
  }
  m.reset();
  m.setSpeedMultiplier(0);
  for (let f = 0; f < 150; f++) m.tick();
  return m;
}

function typeText(m: AtariMachine, text: string): void {
  for (const e of keyEventsFor(text)!) {
    m.keyDown(e);
    for (let f = 0; f < 3; f++) m.tick();
    m.keyUp(e);
    for (let f = 0; f < 3; f++) m.tick();
  }
}

const lines = (m: AtariMachine) => m.ocrScreenForMcp().split('\n').map(l => l.trim());
const untilScript = (m: AtariMachine, limit: number) => {
  for (let f = 0; f < limit && m.autostart !== null; f++) m.tick();
};

describe.each(['atari800', 'atari800xl'] as const)('atari auto-start with the real OS on the %s', { timeout: 120_000 }, (model) => {
  const available = osPath(model) !== null && existsSync(BASIC_ROM);

  it.skipIf(!available)('loads and runs a CSAVEd BASIC program from a Load-ed tape', async () => {
    const saver = powered(model);
    const m = powered(model);
    try {
      typeText(saver, '10 PRINT "HELLO AUTO"\n20 END\nCSAVE\n');
      for (let f = 0; f < 30; f++) saver.tick();
      typeText(saver, '\n');
      for (let f = 0; f < 3000 && !saver.services.tape.recordedBytes(); f++) saver.tick();
      const saved = saver.services.tape.recordedBytes()!.data;
      expect(planTape(saved)).toEqual({ kind: 'basic', via: 'CLOAD' });

      const r = await m.services.media.mount(saved, 'prog.cas');
      expect(r.message).toBe('Cassette: prog.cas — RUN "C:"');
      untilScript(m, 6000);
      expect(m.autostart).toBeNull();
      // The script ends once RETURN is pressed; the OS still has the tape's
      // start-up delay to get through before the program loads and runs.
      for (let f = 0; f < 1500 && !lines(m).includes('HELLO AUTO'); f++) m.tick();
      expect(lines(m)).toContain('HELLO AUTO');
    } finally {
      saver.destroy();
      m.destroy();
    }
  });

  it.skipIf(!available)('enters and runs a LISTed BASIC program from a Load-ed tape', async () => {
    const saver = powered(model);
    const m = powered(model);
    try {
      typeText(saver, '10 PRINT "LISTED OK"\n20 END\nLIST "C:"\n');
      for (let f = 0; f < 30; f++) saver.tick();
      typeText(saver, '\n');
      for (let f = 0; f < 3000 && !saver.services.tape.recordedBytes(); f++) saver.tick();
      for (let f = 0; f < 600; f++) saver.tick();
      const saved = saver.services.tape.recordedBytes()!.data;
      expect(planTape(saved)).toEqual({ kind: 'basic', via: 'ENTER' });

      await m.services.media.mount(saved, 'text.cas');
      untilScript(m, 6000);
      expect(m.autostart).toBeNull();
      for (let f = 0; f < 30; f++) m.tick();
      expect(lines(m)).toContain('LISTED OK');
    } finally {
      saver.destroy();
      m.destroy();
    }
  });

  it.skipIf(!available)('boots a boot tape by itself, with BASIC out', async () => {
    const m = powered(model);
    try {
      const r = await m.services.media.mount(bootTape(), 'boot.cas');
      expect(r.message).toBe('Cassette: boot.cas — booting');
      for (let f = 0; f < 3000 && m.memory.readByte(0x02c8) !== 0x46; f++) m.tick();
      expect(m.memory.readByte(0x02c8)).toBe(0x46);
      for (let f = 0; f < 5; f++) m.tick();
      expect(m.gtia.colbk).toBe(0x46);
      expect(m.autostart).toBeNull();
      expect(m.gtia.consol & 0x07).toBe(0x07); // START and OPTION let go
      if (atariInfo(model).builtinBasic) expect(m.memory.basicRomEnabled).toBe(false);
      else expect(m.memory.cart).toBeNull();
    } finally {
      m.destroy();
    }
  });

  it.skipIf(!available)('boots a custom boot disk by itself, with BASIC out', async () => {
    const m = powered(model);
    try {
      const boot = new Uint8Array(128);
      boot.set(bootRecordData());
      const r = await m.services.media.mount(dosDisk([], { boot }), 'custom.atr');
      expect(r.message).toBe('Disk D1: loaded: custom.atr — booting (BASIC off)');
      for (let f = 0; f < 1500 && m.memory.readByte(0x02c8) !== 0x46; f++) m.tick();
      expect(m.memory.readByte(0x02c8)).toBe(0x46);
      if (atariInfo(model).builtinBasic) expect(m.memory.basicRomEnabled).toBe(false);
      else expect(m.memory.cart).toBeNull();
    } finally {
      m.destroy();
    }
  });

  it.skipIf(!available)('boots with BASIC and types RUN "D:..." for a disk with one BASIC file', async () => {
    const m = powered(model);
    try {
      // The boot record only returns; there is no DOS here, so BASIC's RUN
      // reaches the OS and fails with error 130 (device does not exist) -
      // which proves the command was typed, in BASIC, at its prompt.
      const boot = new Uint8Array(128);
      boot.set([0x00, 0x01, 0x00, 0x07, 0x06, 0x07, 0x18, 0x60]);
      const r = await m.services.media.mount(dosDisk([file('GAME', 'BAS', basicProgram())], { boot }), 'game.atr');
      expect(r.message).toBe('Disk D1: loaded: game.atr — RUN "D:GAME.BAS"');
      untilScript(m, 3000);
      expect(m.autostart).toBeNull();
      for (let f = 0; f < 120; f++) m.tick();
      const text = lines(m);
      expect(text).toContain('RUN "D:GAME.BAS"');
      expect(text.some(l => /^ERROR-\s+130/.test(l))).toBe(true);
    } finally {
      m.destroy();
    }
  });

  it.skipIf(!available)('loads a lone program by typing L and its name at DUP\'s prompts', async () => {
    const m = powered(model);
    try {
      // Two boot sectors standing in for DOS + DUP: through the OS's screen
      // editor (CIO on IOCB 0) they print DUP's menu prompt, read a line to
      // $0600, print the binary-load prompt and read a line to $0620.
      const cio = (command: number, buffer: number, length: number) => [
        0xa2, 0x00,                                     // LDX #0 (IOCB 0, E:)
        0xa9, command, 0x8d, 0x42, 0x03,                // ICCOM
        0xa9, buffer & 0xff, 0x8d, 0x44, 0x03,          // ICBAL
        0xa9, buffer >> 8, 0x8d, 0x45, 0x03,            // ICBAH
        0xa9, length, 0x8d, 0x48, 0x03,                 // ICBLL
        0xa9, 0x00, 0x8d, 0x49, 0x03,                   // ICBLH
        0x20, 0x56, 0xe4,                               // JSR CIOV
      ];
      const PUT_RECORD = 0x09, GET_RECORD = 0x05, EOL = 0x9b;
      const menu = [...'SELECT ITEM OR RETURN FOR MENU'].map(c => c.charCodeAt(0));
      const ask = [...'LOAD FROM WHAT FILE?'].map(c => c.charCodeAt(0));
      const boot = new Uint8Array(256);
      boot.set([0x00, 0x02, 0x00, 0x07, 0x10, 0x07]);  // 2 sectors at $0700; DOSINI $0710
      boot.set([0xa9, 0x11, 0x85, 0x0a, 0xa9, 0x07, 0x85, 0x0b, 0x18, 0x60], 6); // DOSVEC = $0711
      boot[0x10] = 0x60;                               // DOSINI: RTS
      const main = [
        ...cio(PUT_RECORD, 0x0790, menu.length + 1), ...cio(GET_RECORD, 0x0600, 0x20),
        ...cio(PUT_RECORD, 0x07b0, ask.length + 1), ...cio(GET_RECORD, 0x0620, 0x20),
      ];
      boot.set([...main, 0x4c, 0x11 + main.length, 0x07], 0x11); // then JMP to itself
      boot.set([...menu, EOL], 0x90);
      boot.set([...ask, EOL], 0xb0);
      const disk = dosDisk([file('DOS', 'SYS'), file('DUP', 'SYS'), file('GAME', 'COM', colorProgram())], { boot });
      const r = await m.services.media.mount(disk, 'game.atr');
      expect(r.message).toBe('Disk D1: loaded: game.atr — booting DOS to load GAME.COM');
      untilScript(m, 3000);
      expect(m.autostart).toBeNull();
      for (let f = 0; f < 30; f++) m.tick();
      const typed = (at: number) => {
        let s = '';
        for (let b = m.memory.readByte(at); b !== EOL && s.length < 32; b = m.memory.readByte(at + s.length)) {
          s += String.fromCharCode(b);
        }
        return s;
      };
      expect(typed(0x0600)).toBe('L');
      expect(typed(0x0620)).toBe('GAME.COM');
    } finally {
      m.destroy();
    }
  });
});
