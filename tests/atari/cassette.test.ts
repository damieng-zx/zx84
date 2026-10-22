/**
 * Atari program recorder and disk drive model tests.
 *
 * Expectations:
 *  - `.cas` chunk layout and the SIO checksum (an 8-bit sum with the carry
 *    added back in) from the FUJI format and the OS's SIO;
 *  - a standard cassette record is $55 $55, a control byte ($FC full, $FA
 *    partial, $FE EOF), 128 data bytes, then the checksum;
 *  - the 810 reads single density only, the 1050 adds enhanced density
 *    (1040 x 128), the XF551 adds 256-byte double density and the PERCOM
 *    block (tracks, step, sectors/track hi lo, sides-1, density 0 FM / 4 MFM,
 *    bytes/sector hi lo, $FF present);
 *  - real-ROM cases: CSAVE then CLOAD through the OS's own C: handler, and a
 *    cassette boot with START held at power-on.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { percomBlock } from '@/machines/atari/drive-models.ts';
import { parseAtariDisk } from '@/media/floppy/atr.ts';
import {
  CAS_EOF, CAS_FULL, CAS_PARTIAL, atariCasFiles, isAtariCas, parseAtariCas,
  sioChecksum, writeAtariCas, type AtariCasRecord,
} from '@/media/tape/atari-cas.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

/** A cassette record: markers, control byte, 128 data bytes, checksum. */
function record(control: number, fill: number, partialCount?: number): Uint8Array {
  const frame = new Uint8Array(131);
  frame[0] = 0x55;
  frame[1] = 0x55;
  frame[2] = control;
  frame.fill(fill, 3, 131);
  if (partialCount !== undefined) frame[130] = partialCount;
  const out = new Uint8Array(132);
  out.set(frame);
  out[131] = sioChecksum(frame);
  return out;
}

function cas(records: Uint8Array[], description = 'test'): Uint8Array {
  return writeAtariCas({
    description,
    records: records.map((data): AtariCasRecord => ({ data, baud: 600, gapMs: 250 })),
  });
}

describe('atari .cas codec', () => {
  it('sums with the carry added back in', () => {
    expect(sioChecksum(new Uint8Array([0xff, 0x01]))).toBe(0x01);
    expect(sioChecksum(new Uint8Array([0x55, 0x55, 0xfe]))).toBe(0xa9); // $1A8 -> $A8 + 1
    expect(sioChecksum(new Uint8Array([0x10, 0x20]))).toBe(0x30);
  });

  it('parses FUJI, baud and data chunks, and skips turbo chunks', () => {
    const bytes = new Uint8Array([
      ...'FUJI'.split('').map(c => c.charCodeAt(0)), 2, 0, 0, 0, 0x48, 0x49,      // "HI"
      ...'baud'.split('').map(c => c.charCodeAt(0)), 0, 0, 0x58, 0x02,           // 600
      ...'data'.split('').map(c => c.charCodeAt(0)), 3, 0, 0xfa, 0x00, 1, 2, 3, // gap 250
      ...'pwms'.split('').map(c => c.charCodeAt(0)), 1, 0, 0, 0, 9,
    ]);
    expect(isAtariCas(bytes)).toBe(true);
    const image = parseAtariCas(bytes)!;
    expect(image.description).toBe('HI');
    expect(image.records).toHaveLength(1);
    expect(image.records[0].baud).toBe(600);
    expect(image.records[0].gapMs).toBe(250);
    expect([...image.records[0].data]).toEqual([1, 2, 3]);
    expect(image.unsupportedChunks).toBe(1);
  });

  it('rejects images without a FUJI chunk (an MSX .cas, say)', () => {
    expect(parseAtariCas(new Uint8Array([0x1f, 0xa6, 0xde, 0xba, 0xcc, 0x13, 0x7d, 0x74]))).toBeNull();
  });

  it('round-trips through the writer', () => {
    const image = parseAtariCas(cas([record(CAS_FULL, 7), record(CAS_EOF, 0)], 'round'))!;
    expect(image.description).toBe('round');
    expect(image.records.map(r => r.data[2])).toEqual([CAS_FULL, CAS_EOF]);
  });

  it('groups records into files at each EOF, counting partial records by their count', () => {
    const records = [record(CAS_FULL, 1), record(CAS_PARTIAL, 1, 10), record(CAS_EOF, 0), record(CAS_FULL, 2)]
      .map((data): AtariCasRecord => ({ data, baud: 600, gapMs: 0 }));
    expect(atariCasFiles(records)).toEqual([
      { first: 0, records: 3, bytes: 138, unterminated: false },
      { first: 3, records: 1, bytes: 128, unterminated: true },
    ]);
  });
});

// ── SIO harness ────────────────────────────────────────────────────────────

function setDcb(m: AtariMachine, device: number, unit: number, command: number, buffer: number, length: number, aux = 0): void {
  const w = (a: number, v: number) => m.memory.writeByte(a, v);
  w(0x0300, device);
  w(0x0301, unit);
  w(0x0302, command);
  w(0x0304, buffer & 0xff);
  w(0x0305, buffer >> 8);
  w(0x0308, length & 0xff);
  w(0x0309, length >> 8);
  w(0x030a, aux & 0xff);
  w(0x030b, aux >> 8);
}

function callSio(m: AtariMachine): number {
  m.cpu.sp = 0xfd;
  m.memory.writeByte(0x01fe, 0xff);
  m.memory.writeByte(0x01ff, 0x11);
  m.sio.handle();
  return m.memory.readByte(0x0303);
}

describe('atari program recorder over SIO', () => {
  it('serves records in order into the cassette buffer', () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.services.tape.mount(cas([record(CAS_FULL, 0x11), record(CAS_EOF, 0)]), 't.cas');
      setDcb(m, 0x60, 0, 0x52, 0x03fd, 131);
      expect(callSio(m)).toBe(0x01);
      expect(m.memory.readByte(0x03fd)).toBe(0x55);
      expect(m.memory.readByte(0x03ff)).toBe(CAS_FULL);
      expect(m.memory.readByte(0x0400)).toBe(0x11);
      setDcb(m, 0x60, 0, 0x52, 0x03fd, 131);
      expect(callSio(m)).toBe(0x01);
      expect(m.memory.readByte(0x03ff)).toBe(CAS_EOF);
    } finally {
      m.destroy();
    }
  });

  it('times out past the end of the tape, and with no tape', () => {
    const m = new AtariMachine('atari800', null);
    try {
      setDcb(m, 0x60, 0, 0x52, 0x03fd, 131);
      expect(callSio(m)).toBe(0x8a);
      m.services.tape.mount(cas([record(CAS_EOF, 0)]), 't.cas');
      callSio(m);
      setDcb(m, 0x60, 0, 0x52, 0x03fd, 131);
      expect(callSio(m)).toBe(0x8a);
    } finally {
      m.destroy();
    }
  });

  it('reports a record whose checksum does not match as error 143', () => {
    const m = new AtariMachine('atari800', null);
    try {
      const bad = record(CAS_FULL, 3);
      bad[131] ^= 0xff;
      m.services.tape.mount(cas([bad]), 'bad.cas');
      setDcb(m, 0x60, 0, 0x52, 0x03fd, 131);
      expect(callSio(m)).toBe(0x8f);
    } finally {
      m.destroy();
    }
  });

  it('records written frames with their checksum, until a reset', () => {
    const m = new AtariMachine('atari800', null);
    try {
      for (let i = 0; i < 131; i++) m.memory.writeByte(0x03fd + i, i < 2 ? 0x55 : i === 2 ? CAS_EOF : 0);
      setDcb(m, 0x60, 0, 0x57, 0x03fd, 131);
      expect(callSio(m)).toBe(0x01);
      const saved = parseAtariCas(m.services.tape.recordedBytes()!.data)!;
      expect(saved.records).toHaveLength(1);
      expect(saved.records[0].data.length).toBe(132);
      expect(saved.records[0].data[131]).toBe(0xa9);
      m.reset();
      expect(m.services.tape.recordedBytes()).toBeNull();
    } finally {
      m.destroy();
    }
  });

  it('records a frame written with the PUT command too, as AltirraOS saves with it', () => {
    const m = new AtariMachine('atari800', null);
    try {
      for (let i = 0; i < 131; i++) m.memory.writeByte(0x03fd + i, i < 2 ? 0x55 : i === 2 ? CAS_EOF : 0);
      setDcb(m, 0x60, 0, 0x50, 0x03fd, 131);
      m.memory.writeByte(0x0303, 0x80); // DSTATS: the computer sends
      expect(callSio(m)).toBe(0x01);
      const saved = parseAtariCas(m.services.tape.recordedBytes()!.data)!;
      expect(saved.records).toHaveLength(1);
    } finally {
      m.destroy();
    }
  });

  it('routes .cas files to the recorder through the media service', async () => {
    const m = new AtariMachine('atari800', null);
    try {
      const result = await m.services.media.mount(cas([record(CAS_EOF, 0)]), 'game.cas');
      expect(result.ok).toBe(true);
      expect(m.services.tape.loaded).toBe(true);
      expect(m.services.tape.blocks).toHaveLength(1);
      const bad = await m.services.media.mount(new Uint8Array(16), 'not.cas');
      expect(bad.ok).toBe(false);
    } finally {
      m.destroy();
    }
  });
});

describe('atari disk drive models', () => {
  const SD = 720 * 128;          // 90K single density (raw XFD)
  const ED = 1040 * 128;         // 130K enhanced density
  const DD = 720 * 256;          // 180K double density

  /** An ATR of `bytes` of 128-byte sectors (hard-disk sizes have no XFD form). */
  function atr(bytes: number): Uint8Array {
    const out = new Uint8Array(16 + bytes).fill(0x5a, 16);
    const paragraphs = bytes / 16;
    out.set([0x96, 0x02, paragraphs & 0xff, (paragraphs >> 8) & 0xff, 128, 0, (paragraphs >> 16) & 0xff]);
    return out;
  }

  function machineWith(bytes: number, drive: '810' | '1050' | 'xf551' | 'sio2pc'): AtariMachine {
    const m = new AtariMachine('atari800', null);
    m.services.disks.setDriveModel(0, drive);
    m.services.disks.insert('a', bytes > 1440 * 256 ? atr(bytes) : new Uint8Array(bytes).fill(0x5a), 'disk.atr');
    return m;
  }

  it.each([
    [SD, '810', 0x01], [ED, '810', 0x90], [DD, '810', 0x90],
    [SD, '1050', 0x01], [ED, '1050', 0x01], [DD, '1050', 0x90],
    [SD, 'xf551', 0x01], [ED, 'xf551', 0x01], [DD, 'xf551', 0x01],
  ] as const)('a %i-byte disk in an %s reads with status %i', (bytes, drive, status) => {
    const m = machineWith(bytes, drive);
    try {
      setDcb(m, 0x31, 1, 0x52, 0x4000, bytes === DD ? 256 : 128, 10);
      expect(callSio(m)).toBe(status);
      if (status === 1) expect(m.memory.readByte(0x4000)).toBe(0x5a);
    } finally {
      m.destroy();
    }
  });

  it('reports enhanced density, double density and write protect in the status block', () => {
    const ed = machineWith(ED, '1050');
    const dd = machineWith(DD, 'xf551');
    try {
      setDcb(ed, 0x31, 1, 0x53, 0x4000, 4);
      callSio(ed);
      expect(ed.memory.readByte(0x4000) & 0x80).toBe(0x80);
      expect(ed.memory.readByte(0x4001)).toBe(0xff);
      expect(ed.memory.readByte(0x4002)).toBe(0xe0);

      dd.services.disks.setWriteProtect('a', true);
      setDcb(dd, 0x31, 1, 0x53, 0x4000, 4);
      callSio(dd);
      expect(dd.memory.readByte(0x4000) & 0x28).toBe(0x28); // DD + write protect
      expect(dd.memory.readByte(0x4001)).toBe(0xbf);
    } finally {
      ed.destroy();
      dd.destroy();
    }
  });

  it('reports two sides, and a $FE format timeout on the XF551, in the status block', () => {
    const DSDD = 1440 * 256;
    const xf = machineWith(DSDD, 'xf551');
    const sd = machineWith(SD, '1050');
    try {
      setDcb(xf, 0x31, 1, 0x53, 0x4000, 4);
      callSio(xf);
      expect(xf.memory.readByte(0x4000) & 0x68).toBe(0x60);   // double density, two sides, not protected
      expect(xf.memory.readByte(0x4002)).toBe(0xfe);
      setDcb(sd, 0x31, 1, 0x53, 0x4000, 4);
      callSio(sd);
      expect(sd.memory.readByte(0x4000) & 0xe0).toBe(0);
      expect(sd.memory.readByte(0x4002)).toBe(0xe0);
    } finally {
      xf.destroy();
      sd.destroy();
    }
  });

  it('shows the last operation failing in the status block until one succeeds', () => {
    const m = machineWith(ED, '810');            // an 810 cannot read an ED disk
    try {
      const status = (): number => {
        setDcb(m, 0x31, 1, 0x53, 0x4000, 4);
        callSio(m);
        return m.memory.readByte(0x4000) & 0x04;
      };
      expect(status()).toBe(0);
      setDcb(m, 0x31, 1, 0x52, 0x4100, 128, 10);
      expect(callSio(m)).toBe(0x90);
      expect(status()).toBe(0x04);
      m.services.disks.setDriveModel(0, '1050'); // now it can
      setDcb(m, 0x31, 1, 0x52, 0x4100, 128, 10);
      expect(callSio(m)).toBe(0x01);
      expect(status()).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('reads a hard-disk sized image only on SIO2PC, and describes it as one track', () => {
    const HD = 8192 * 128; // 1 MB, as the TOSEC demo compilations ship
    const xf = machineWith(HD, 'xf551');
    const pc = machineWith(HD, 'sio2pc');
    try {
      setDcb(xf, 0x31, 1, 0x52, 0x4000, 128, 8000);
      expect(callSio(xf)).toBe(0x90);
      setDcb(pc, 0x31, 1, 0x52, 0x4000, 128, 8000);
      expect(callSio(pc)).toBe(0x01);
      setDcb(pc, 0x31, 1, 0x4e, 0x4000, 12);
      expect(callSio(pc)).toBe(0x01);
      expect([...pc.memory.readBlock(0x4000, 8)]).toEqual([1, 1, 0x20, 0x00, 0, 0, 0, 128]);
    } finally {
      xf.destroy();
      pc.destroy();
    }
  });

  it('answers PERCOM only on the XF551 (and SIO2PC)', () => {
    const xf = machineWith(DD, 'xf551');
    const d1050 = machineWith(SD, '1050');
    try {
      setDcb(xf, 0x31, 1, 0x4e, 0x4000, 12);
      expect(callSio(xf)).toBe(0x01);
      // The XF551 always reports a zero step rate and an active drive.
      expect([...xf.memory.readBlock(0x4000, 12)]).toEqual([40, 0, 0, 18, 0, 4, 1, 0, 1, 0, 0, 0]);
      setDcb(d1050, 0x31, 1, 0x4e, 0x4000, 12);
      expect(callSio(d1050)).toBe(0x8b);
    } finally {
      xf.destroy();
      d1050.destroy();
    }
  });

  it('describes single and enhanced density in PERCOM terms', () => {
    expect([...percomBlock(parseAtariDisk(new Uint8Array(SD))!)].slice(0, 8)).toEqual([40, 1, 0, 18, 0, 0, 0, 128]);
    expect([...percomBlock(parseAtariDisk(new Uint8Array(ED))!)].slice(0, 8)).toEqual([40, 1, 0, 26, 0, 4, 0, 128]);
  });

  /** Write `block` as the PERCOM configuration of D1: and return the status. */
  function writePercom(m: AtariMachine, block: number[]): number {
    block.forEach((b, i) => m.memory.writeByte(0x4100 + i, b));
    setDcb(m, 0x31, 1, 0x4f, 0x4100, 12);
    return callSio(m);
  }

  function readPercom(m: AtariMachine): number[] {
    setDcb(m, 0x31, 1, 0x4e, 0x4000, 12);
    expect(callSio(m)).toBe(0x01);
    return [...m.memory.readBlock(0x4000, 12)];
  }

  it('keeps any valid PERCOM block it is given and reports it back', () => {
    const m = machineWith(SD, 'sio2pc');
    try {
      // 77 tracks of 8 sectors of 512 bytes, one side: nothing like the disk in it.
      const block = [77, 3, 0, 8, 0, 4, 2, 0, 0xff, 0, 0, 0];
      expect(writePercom(m, block)).toBe(0x01);
      expect(readPercom(m)).toEqual(block);
    } finally {
      m.destroy();
    }
  });

  it('refuses a PERCOM block that describes no possible disk', () => {
    const m = machineWith(SD, 'sio2pc');
    try {
      const before = readPercom(m);
      for (const block of [
        [0, 1, 0, 18, 0, 0, 0, 128, 0xff, 0, 0, 0],    // no tracks
        [40, 1, 0, 0, 0, 0, 0, 128, 0xff, 0, 0, 0],    // no sectors a track
        [40, 1, 0, 18, 2, 0, 0, 128, 0xff, 0, 0, 0],   // three sides
        [40, 1, 0, 18, 0, 0, 0, 100, 0xff, 0, 0, 0],   // a sector size no drive uses
        [255, 1, 1, 0, 1, 4, 1, 0, 0xff, 0, 0, 0],     // more sectors than SIO can number
      ]) {
        expect(writePercom(m, block)).toBe(0x90);
      }
      expect(readPercom(m)).toEqual(before);
    } finally {
      m.destroy();
    }
  });

  it('has the XF551 sort a PERCOM block into single, enhanced or double density', () => {
    const m = machineWith(SD, 'xf551');
    try {
      // Garbage in the step rate, tracks and the rest is ignored.
      expect(writePercom(m, [99, 7, 9, 26, 1, 9, 9, 9, 0, 5, 5, 5])).toBe(0x01);
      expect(readPercom(m)).toEqual([40, 0, 0, 26, 0, 4, 0, 128, 1, 0x41, 0, 0]);
      expect(writePercom(m, [40, 1, 0, 18, 0, 0, 0, 128, 0xff, 0, 0, 0])).toBe(0x01);
      expect(readPercom(m)).toEqual([40, 0, 0, 18, 0, 0, 0, 128, 1, 0x41, 0, 0]);
      expect(writePercom(m, [40, 1, 0, 18, 1, 4, 1, 0, 0xff, 0, 0, 0])).toBe(0x01);
      expect(readPercom(m)).toEqual([40, 0, 0, 18, 1, 4, 1, 0, 1, 0x41, 0, 0]);
    } finally {
      m.destroy();
    }
  });

  it('shows the density a program configured in the drive status, until the disk changes', () => {
    const m = machineWith(SD, 'xf551');
    try {
      const status = (): number => {
        setDcb(m, 0x31, 1, 0x53, 0x4000, 4);
        callSio(m);
        return m.memory.readByte(0x4000);
      };
      expect(status() & 0xa0).toBe(0);
      writePercom(m, [40, 1, 0, 18, 0, 4, 1, 0, 0xff, 0, 0, 0]);
      expect(status() & 0xa0).toBe(0x20);
      writePercom(m, [40, 1, 0, 26, 0, 4, 0, 128, 0xff, 0, 0, 0]);
      expect(status() & 0xa0).toBe(0x80);
      m.services.disks.insert('a', new Uint8Array(SD), 'again.xfd');
      expect(status() & 0xa0).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('refuses the enhanced-density format command on the 810', () => {
    const m = machineWith(SD, '810');
    try {
      setDcb(m, 0x31, 1, 0x22, 0x4000, 128);
      expect(callSio(m)).toBe(0x8b);
    } finally {
      m.destroy();
    }
  });

  it('says which drive a disk needs when the fitted one cannot read it', async () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.services.disks.setDriveModel(0, '810');
      const r = await m.services.media.mount(new Uint8Array(ED), 'big.xfd');
      expect(r.ok).toBe(true);
      expect(r.message).toContain('Atari 1050');
      m.services.disks.setDriveModel(0, 'xf551');
      const hd = await m.services.media.mount(atr(8192 * 128), 'hd.atr');
      expect(hd.message).toContain('SIO2PC');
    } finally {
      m.destroy();
    }
  });

  it('takes the drive models from the settings, one per drive', () => {
    const m = new AtariMachine('atari800', null);
    const view = (models: unknown) =>
      ({ get: <T,>(key: string, fallback: T) => (key === 'drive-models:atari' ? models : fallback) as T });
    try {
      expect(m.services.disks.driveModels).toEqual(['sio2pc', 'sio2pc']); // the default pair
      m.applySettings(view(['1050', '810', 'xf551']));
      expect(m.services.disks.driveModels).toEqual(['1050', '810', 'xf551']);
      expect(m.services.disks.drives.map(d => d.label)).toEqual(['D1:', 'D2:', 'D3:']);
      m.applySettings(view(['nonsense']));
      expect(m.services.disks.driveModels).toEqual(['sio2pc']); // an unknown model is the default
      m.applySettings(view('not a list'));
      expect(m.services.disks.driveModels).toEqual(['sio2pc', 'sio2pc']);
    } finally {
      m.destroy();
    }
  });

  it('lets drives of different models share the bus', async () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.services.disks.configure(['810', '1050']);
      m.services.disks.insert('a', new Uint8Array(ED).fill(0x5a), 'ed.xfd');
      m.services.disks.insert('b', new Uint8Array(ED).fill(0x5a), 'ed.xfd');
      // The 810 cannot read an enhanced-density disk; the 1050 beside it can.
      expect(m.services.disks.canRead(0x31)).toBe(false);
      expect(m.services.disks.canRead(0x32)).toBe(true);
      const r = await m.services.media.mount(new Uint8Array(ED), 'big.xfd', 'b');
      expect(r.message).toBe('Disk D2: loaded: big.xfd');
      const r1 = await m.services.media.mount(new Uint8Array(ED), 'big.xfd', 'a');
      expect(r1.message).toContain('the Atari 810 cannot read it');
    } finally {
      m.destroy();
    }
  });
});

// ── Real-ROM recorder tests ───────────────────────────────────────────────

const DIR = process.env.ATARI_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
const OS = resolve(DIR, 'atariosb.rom');
const BASIC = resolve(DIR, 'ataribas.rom');
const haveRoms = existsSync(OS) && existsSync(BASIC);

function key(code: string, k: string, shift = false): HostKeyEvent {
  return { code, key: k, shift, ctrl: false, alt: false };
}
function charKey(ch: string): HostKeyEvent {
  if (ch === '\n') return key('Enter', 'Enter');
  if (ch === ' ') return key('Space', ' ');
  if (ch === '"') return key('Digit2', '"', true);
  if (/[A-Z]/.test(ch)) return key(`Key${ch}`, ch.toLowerCase());
  if (/[0-9]/.test(ch)) return key(`Digit${ch}`, ch);
  return key('Equal', ch);
}
function type(m: AtariMachine, text: string): void {
  for (const ch of text) {
    const e = charKey(ch);
    m.keyDown(e);
    for (let f = 0; f < 3; f++) m.tick();
    m.keyUp(e);
    for (let f = 0; f < 3; f++) m.tick();
  }
}
function rows(m: AtariMachine): string[] {
  const sav = m.memory.readByte(0x58) | (m.memory.readByte(0x59) << 8);
  const out: string[] = [];
  for (let r = 0; r < 24; r++) {
    let s = '';
    for (let c = 0; c < 40; c++) {
      const v = m.memory.readByte(sav + r * 40 + c) & 0x7f;
      const a = v < 0x40 ? v + 0x20 : v < 0x60 ? v - 0x40 : v;
      s += a >= 0x20 && a < 0x7f ? String.fromCharCode(a) : ' ';
    }
    if (s.trim()) out.push(s.trim());
  }
  return out;
}
/** Run until the last screen line is READY (the OS's tape leader and gap
 *  timing takes several emulated seconds), up to `limit` frames. */
function untilReady(m: AtariMachine, limit = 3000): void {
  for (let f = 0; f < limit && rows(m).at(-1) !== 'READY'; f++) m.tick();
}
function bootBasic(): AtariMachine {
  const m = new AtariMachine('atari800', null);
  m.services.roms.installSystemRom(new Uint8Array(readFileSync(OS)));
  m.services.roms.cartridge!.insert(new Uint8Array(readFileSync(BASIC)), '');
  m.setSpeedMultiplier(0);
  for (let f = 0; f < 120; f++) m.tick();
  return m;
}

describe.skipIf(!haveRoms)('atari program recorder with the real OS', { timeout: 30_000 }, () => {
  it('CSAVEs a program and CLOADs it back on another machine', () => {
    const saver = bootBasic();
    const loader = bootBasic();
    try {
      type(saver, '10 PRINT "HELLO TAPE"\n20 GOTO 10\nCSAVE\n');
      for (let f = 0; f < 30; f++) saver.tick();
      type(saver, '\n'); // the OS's "press RECORD and PLAY, then RETURN"
      for (let f = 0; f < 3000 && !saver.services.tape.recordedBytes(); f++) saver.tick();
      untilReady(saver);
      const tape = saver.services.tape.recordedBytes();
      expect(tape).not.toBeNull();

      loader.services.tape.mount(tape!.data, tape!.filename);
      type(loader, 'CLOAD\n');
      for (let f = 0; f < 30; f++) loader.tick();
      type(loader, '\n'); // "press PLAY, then RETURN"
      untilReady(loader);
      type(loader, 'LIST\n');
      for (let f = 0; f < 30; f++) loader.tick();
      const screen = rows(loader);
      expect(screen).toContain('10 PRINT "HELLO TAPE"');
      expect(screen).toContain('20 GOTO 10');
    } finally {
      saver.destroy();
      loader.destroy();
    }
  });

  it('boots a cassette when START is held at power-on', () => {
    // One boot record loaded at $0700: header (flags, 1 record, load $0700,
    // init $070F), then code at $0706 that points DOSVEC at $0710 and returns
    // with carry clear; $0710 loops storing $46 into COLOR4 (the background).
    const data = new Uint8Array(128);
    data.set([0x00, 0x01, 0x00, 0x07, 0x0f, 0x07]);
    data.set([0xa9, 0x10, 0x85, 0x0a, 0xa9, 0x07, 0x85, 0x0b, 0x18, 0x60], 6);
    data.set([0xa9, 0x46, 0x8d, 0xc8, 0x02, 0x4c, 0x10, 0x07], 16);
    const frame = new Uint8Array(131);
    frame.set([0x55, 0x55, CAS_FULL]);
    frame.set(data, 3);
    const rec = new Uint8Array(132);
    rec.set(frame);
    rec[131] = sioChecksum(frame);

    const m = new AtariMachine('atari800', null);
    try {
      m.services.roms.installSystemRom(new Uint8Array(readFileSync(OS)));
      m.services.tape.mount(cas([rec, record(CAS_EOF, 0)]), 'boot.cas');
      m.setSpeedMultiplier(0);
      const start = key('F2', 'F2');
      m.keyDown(start);
      m.reset();
      for (let f = 0; f < 60; f++) m.tick();
      m.keyUp(start);
      type(m, ' '); // "press PLAY, then any key"
      for (let f = 0; f < 3000 && m.memory.readByte(0x02c8) !== 0x46; f++) m.tick();
      expect(m.memory.readByte(0x02c8)).toBe(0x46);
      for (let f = 0; f < 5; f++) m.tick();
      expect(m.gtia.colbk).toBe(0x46); // the OS's VBI copied it to the hardware
    } finally {
      m.destroy();
    }
  });
});
