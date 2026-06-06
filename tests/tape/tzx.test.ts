import { describe, it, expect } from 'vitest';
import { parseTZX } from '@/tape/tzx.ts';
import type {
  TapeBlock,
  DataBlock,
  ToneBlock,
  PulsesBlock,
  PauseBlock,
  DirectBlock,
  SetLevelBlock,
  GroupStartBlock,
  TextBlock,
  ArchiveInfoBlock,
} from '@/tape/tap.ts';

// ── Builder helpers ────────────────────────────────────────────────────────

const TZX_MAGIC = [0x5A, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1A];

function header(major = 1, minor = 20): number[] {
  return [...TZX_MAGIC, major, minor];
}

function w16(v: number): number[] {
  return [v & 0xFF, (v >> 8) & 0xFF];
}
function w24(v: number): number[] {
  return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF];
}
function w32(v: number): number[] {
  return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF];
}

function bytesOf(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function tzx(...parts: number[][]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Build a standard-speed data block (0x10): pause + length + flag+payload+checksum. */
function block10(pauseMs: number, flag: number, payload: number[]): number[] {
  let cs = flag;
  for (const b of payload) cs ^= b;
  return [
    0x10,
    ...w16(pauseMs),
    ...w16(1 + payload.length + 1),
    flag,
    ...payload,
    cs & 0xFF,
  ];
}

/** Build a turbo-speed data block (0x11) with all timings explicit. */
function block11(opts: {
  pilotPulse?: number;
  syncPulse1?: number;
  syncPulse2?: number;
  bit0Pulse?: number;
  bit1Pulse?: number;
  pilotCount?: number;
  usedBits?: number;
  pause?: number;
  flag: number;
  payload: number[];
}): number[] {
  const {
    pilotPulse = 2168, syncPulse1 = 667, syncPulse2 = 735,
    bit0Pulse = 855, bit1Pulse = 1710, pilotCount = 3223,
    usedBits = 8, pause = 1000, flag, payload,
  } = opts;
  let cs = flag;
  for (const b of payload) cs ^= b;
  const raw = [flag, ...payload, cs & 0xFF];
  return [
    0x11,
    ...w16(pilotPulse), ...w16(syncPulse1), ...w16(syncPulse2),
    ...w16(bit0Pulse), ...w16(bit1Pulse), ...w16(pilotCount),
    usedBits,
    ...w16(pause),
    ...w24(raw.length),
    ...raw,
  ];
}

function block12(pulseLen: number, count: number): number[] {
  return [0x12, ...w16(pulseLen), ...w16(count)];
}

function block13(lengths: number[]): number[] {
  return [0x13, lengths.length, ...lengths.flatMap(w16)];
}

function block14(bit0: number, bit1: number, usedBits: number, pause: number, data: number[]): number[] {
  return [
    0x14, ...w16(bit0), ...w16(bit1), usedBits, ...w16(pause),
    ...w24(data.length), ...data,
  ];
}

function block15(tStatesPerSample: number, pause: number, usedBits: number, data: number[]): number[] {
  return [
    0x15, ...w16(tStatesPerSample), ...w16(pause), usedBits,
    ...w24(data.length), ...data,
  ];
}

function block20(duration: number): number[] {
  return [0x20, ...w16(duration)];
}

function block21(name: string): number[] {
  const n = bytesOf(name);
  return [0x21, n.length, ...n];
}

function block22(): number[] { return [0x22]; }

function block23(relativeOffset: number): number[] {
  // Encode signed 16-bit relative offset
  const v = relativeOffset < 0 ? 0x10000 + relativeOffset : relativeOffset;
  return [0x23, ...w16(v)];
}

function block24(repetitions: number): number[] {
  return [0x24, ...w16(repetitions)];
}
function block25(): number[] { return [0x25]; }

function block26(offsets: number[]): number[] {
  return [0x26, ...w16(offsets.length), ...offsets.flatMap(w16)];
}
function block27(): number[] { return [0x27]; }

function block28(payloadBytes: number[]): number[] {
  // 0x28 Select Block: WORD totalLength + payload
  return [0x28, ...w16(payloadBytes.length), ...payloadBytes];
}

function block2A(): number[] { return [0x2A, ...w32(0)]; }

function block2B(level: number): number[] {
  return [0x2B, ...w32(1), level & 1];
}

function block30(text: string): number[] {
  const t = bytesOf(text);
  return [0x30, t.length, ...t];
}

function block31(time: number, text: string): number[] {
  const t = bytesOf(text);
  return [0x31, time & 0xFF, t.length, ...t];
}

function block32(entries: { id: number; text: string }[]): number[] {
  const inner: number[] = [];
  for (const e of entries) {
    const t = bytesOf(e.text);
    inner.push(e.id, t.length, ...t);
  }
  // totalLength includes everything after the totalLength word itself —
  // numStrings byte + entries.
  const totalLen = 1 + inner.length;
  return [0x32, ...w16(totalLen), entries.length, ...inner];
}

function block33(hwEntries: [number, number, number][]): number[] {
  const flat: number[] = [];
  for (const [a, b, c] of hwEntries) flat.push(a, b, c);
  return [0x33, hwEntries.length, ...flat];
}

function block35(id: string, data: number[]): number[] {
  const idBytes = new Array(16).fill(0);
  const s = bytesOf(id);
  for (let i = 0; i < Math.min(16, s.length); i++) idBytes[i] = s[i];
  return [0x35, ...idBytes, ...w32(data.length), ...data];
}

function block5A(): number[] {
  return [0x5A, ...new Array(9).fill(0)];
}

/** 0x18 CSW Recording — block length excludes itself. */
function block18(bodyBytes: number[]): number[] {
  return [0x18, ...w32(bodyBytes.length), ...bodyBytes];
}
/** 0x19 Generalized Data Block — same shape for skipping purposes. */
function block19(bodyBytes: number[]): number[] {
  return [0x19, ...w32(bodyBytes.length), ...bodyBytes];
}

// ── Header / magic ─────────────────────────────────────────────────────────

describe('TZX — header and magic', () => {
  it('rejects a file with wrong magic', () => {
    const bad = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 1, 20]);
    expect(() => parseTZX(bad)).toThrow('Not a valid TZX file');
  });

  it('accepts ZXTape!\\x1A magic with major/minor 1.20 and an empty body', () => {
    const data = tzx(header(1, 20));
    expect(parseTZX(data)).toEqual([]);
  });

  it('ignores major/minor version values (forward-compatible)', () => {
    const data = tzx(header(2, 0));
    expect(parseTZX(data)).toEqual([]);
  });

  it('rejects a file shorter than the 10-byte header', () => {
    expect(() => parseTZX(new Uint8Array(5))).toThrow();
  });
});

// ── Block 0x10 (Standard Speed Data) ───────────────────────────────────────

describe('TZX — 0x10 Standard Speed Data', () => {
  it('parses pause, length, flag, payload, and checksum', () => {
    const data = tzx(header(), block10(1500, 0xFF, [0x11, 0x22, 0x33]));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
    const b = blocks[0] as DataBlock;
    expect(b.kind).toBe('data');
    expect(b.flag).toBe(0xFF);
    expect(Array.from(b.data)).toEqual([0x11, 0x22, 0x33]);
    expect(b.pause).toBe(1500);
    expect(b.source).toBe('standard');
  });

  it('uses the standard Spectrum pulse timings', () => {
    const data = tzx(header(), block10(1000, 0x00, [0x00]));
    const b = parseTZX(data)[0] as DataBlock;
    expect(b.pilotPulse).toBe(2168);
    expect(b.syncPulse1).toBe(667);
    expect(b.syncPulse2).toBe(735);
    expect(b.bit0Pulse).toBe(855);
    expect(b.bit1Pulse).toBe(1710);
    expect(b.usedBits).toBe(8);
  });

  it.each([
    [0x00, 8063, 'header'],
    [0x01, 8063, 'unusual low flag'],
    [0x55, 8063, 'mid low flag'],
    [0x7F, 8063, 'highest header-pilot flag'],
    [0x80, 3223, 'lowest data-pilot flag'],
    [0xAA, 3223, 'mid high flag'],
    [0xFF, 3223, 'standard data'],
  ])('flag 0x%s selects pilotCount=%i (%s)', (flag, expected) => {
    const data = tzx(header(), block10(0, flag, [0x42]));
    const b = parseTZX(data)[0] as DataBlock;
    expect(b.pilotCount).toBe(expected);
  });

  it('drops a block whose declared length is too small for flag+checksum', () => {
    // length=1 means raw.length=1, extractDataBlock returns null.
    const corrupt = tzx(
      header(),
      [0x10, ...w16(0), ...w16(1), 0xFF],
    );
    expect(parseTZX(corrupt)).toEqual([]);
  });
});

// ── Block 0x11 (Turbo Speed Data) ──────────────────────────────────────────

describe('TZX — 0x11 Turbo Speed Data', () => {
  it('preserves all custom timings and metadata', () => {
    const data = tzx(header(), block11({
      pilotPulse: 1000, syncPulse1: 100, syncPulse2: 200,
      bit0Pulse: 300, bit1Pulse: 600, pilotCount: 1234,
      usedBits: 5, pause: 250, flag: 0xAB, payload: [1, 2, 3],
    }));
    const b = parseTZX(data)[0] as DataBlock;
    expect(b.source).toBe('turbo');
    expect(b.flag).toBe(0xAB);
    expect(Array.from(b.data)).toEqual([1, 2, 3]);
    expect(b.pilotPulse).toBe(1000);
    expect(b.syncPulse1).toBe(100);
    expect(b.syncPulse2).toBe(200);
    expect(b.bit0Pulse).toBe(300);
    expect(b.bit1Pulse).toBe(600);
    expect(b.pilotCount).toBe(1234);
    expect(b.usedBits).toBe(5);
    expect(b.pause).toBe(250);
  });

  it('reads the 3-byte (24-bit) length field correctly', () => {
    // Build a turbo block with a 70000-byte payload — length is 70002,
    // which needs more than 16 bits to encode.
    const payload = new Array(70000).fill(0).map((_, i) => i & 0xFF);
    const data = tzx(header(), block11({ flag: 0xFF, payload }));
    const b = parseTZX(data)[0] as DataBlock;
    expect(b.data.length).toBe(70000);
    expect(b.data[0]).toBe(0);
    expect(b.data[69999]).toBe(69999 & 0xFF);
  });

  it('does not apply bit-7 pilot selection (pilotCount is explicit)', () => {
    // Even with flag=0x00, the turbo block's explicit pilotCount must win.
    const data = tzx(header(), block11({
      flag: 0x00, pilotCount: 42, payload: [1, 2],
    }));
    const b = parseTZX(data)[0] as DataBlock;
    expect(b.pilotCount).toBe(42);
  });
});

// ── Block 0x12 / 0x13 (Pure Tone / Pulse Sequence) ─────────────────────────

describe('TZX — 0x12 Pure Tone', () => {
  it('captures pulse length and count', () => {
    const data = tzx(header(), block12(2000, 50));
    const b = parseTZX(data)[0] as ToneBlock;
    expect(b.kind).toBe('tone');
    expect(b.pulseLen).toBe(2000);
    expect(b.count).toBe(50);
  });
});

describe('TZX — 0x13 Pulse Sequence', () => {
  it('captures all pulse lengths', () => {
    const lens = [100, 200, 300, 400, 500];
    const data = tzx(header(), block13(lens));
    const b = parseTZX(data)[0] as PulsesBlock;
    expect(b.kind).toBe('pulses');
    expect(b.lengths).toEqual(lens);
  });

  it('handles count=0 (empty pulses block)', () => {
    const data = tzx(header(), block13([]));
    const b = parseTZX(data)[0] as PulsesBlock;
    expect(b.kind).toBe('pulses');
    expect(b.lengths).toEqual([]);
  });
});

// ── Block 0x14 (Pure Data) ─────────────────────────────────────────────────

describe('TZX — 0x14 Pure Data', () => {
  it('produces a pure-data DataBlock with no pilot and raw bytes (no flag/checksum stripping)', () => {
    const payload = [0xDE, 0xAD, 0xBE, 0xEF];
    const data = tzx(header(), block14(/* bit0 */ 500, /* bit1 */ 1000, /* usedBits */ 7, /* pause */ 250, payload));
    const b = parseTZX(data)[0] as DataBlock;
    expect(b.source).toBe('pure-data');
    expect(b.pilotCount).toBe(0);
    expect(b.pilotPulse).toBe(0);
    expect(b.syncPulse1).toBe(0);
    expect(b.syncPulse2).toBe(0);
    expect(b.bit0Pulse).toBe(500);
    expect(b.bit1Pulse).toBe(1000);
    expect(b.usedBits).toBe(7);
    expect(b.pause).toBe(250);
    // Pure-data stores ALL bytes verbatim — no flag/checksum split.
    expect(Array.from(b.data)).toEqual(payload);
  });

  it('omits a pure-data block when its length is zero', () => {
    const data = tzx(header(), block14(500, 1000, 8, 0, []));
    expect(parseTZX(data)).toEqual([]);
  });
});

// ── Block 0x15 (Direct Recording) ──────────────────────────────────────────

describe('TZX — 0x15 Direct Recording', () => {
  it('captures sample rate, pause, used bits, and raw data', () => {
    const samples = [0x80, 0x7F, 0xFF, 0x00];
    const data = tzx(header(), block15(/* tStatesPerSample */ 79, /* pause */ 50, /* usedBits */ 4, samples));
    const b = parseTZX(data)[0] as DirectBlock;
    expect(b.kind).toBe('direct');
    expect(b.tStatesPerSample).toBe(79);
    expect(b.pause).toBe(50);
    expect(b.usedBits).toBe(4);
    expect(Array.from(b.data)).toEqual(samples);
  });
});

// ── Block 0x18 / 0x19 (CSW and Generalized — skipped) ──────────────────────

describe('TZX — 0x18 CSW Recording / 0x19 Generalized Data', () => {
  it('skips a 0x18 block via its dword length and continues parsing', () => {
    const body = [0xAA, 0xBB, 0xCC, 0xDD];
    const data = tzx(header(), block18(body), block20(100));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('pause');
  });

  it('skips a 0x19 block via its dword length and continues parsing', () => {
    const body = new Array(500).fill(0xFF);
    const data = tzx(header(), block19(body), block20(50));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('pause');
  });
});

// ── Block 0x20 (Pause / Stop) ──────────────────────────────────────────────

describe('TZX — 0x20 Pause / Stop the tape', () => {
  it('captures a normal pause duration', () => {
    const data = tzx(header(), block20(2000));
    const b = parseTZX(data)[0] as PauseBlock;
    expect(b.kind).toBe('pause');
    expect(b.duration).toBe(2000);
  });

  it('represents "stop the tape" as duration=0', () => {
    const data = tzx(header(), block20(0));
    const b = parseTZX(data)[0] as PauseBlock;
    expect(b.duration).toBe(0);
  });
});

// ── Block 0x21 / 0x22 (Group Start/End) ────────────────────────────────────

describe('TZX — 0x21 Group Start / 0x22 Group End', () => {
  it('captures the group name', () => {
    const data = tzx(header(), block21('Side A'), block22());
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(2);
    expect((blocks[0] as GroupStartBlock).kind).toBe('group-start');
    expect((blocks[0] as GroupStartBlock).name).toBe('Side A');
    expect(blocks[1].kind).toBe('group-end');
  });

  it('handles an empty group name', () => {
    const data = tzx(header(), block21(''));
    const b = parseTZX(data)[0] as GroupStartBlock;
    expect(b.name).toBe('');
  });
});

// ── Block 0x23 (Jump) — silently skipped ───────────────────────────────────

describe('TZX — 0x23 Jump to Block', () => {
  it('skips the 2-byte offset without producing a block and continues parsing', () => {
    const data = tzx(header(), block23(-5), block20(123));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('pause');
  });
});

// ── Block 0x24 / 0x25 (Loop expansion) ─────────────────────────────────────

describe('TZX — 0x24 Loop Start / 0x25 Loop End', () => {
  it('count=2 emits the loop body twice', () => {
    const data = tzx(
      header(),
      block24(2),
      block20(100),
      block25(),
    );
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(2);
    expect(blocks.every((b) => b.kind === 'pause')).toBe(true);
  });

  it('count=3 emits the loop body three times', () => {
    const data = tzx(
      header(),
      block24(3),
      block20(7),
      block25(),
    );
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(3);
    expect((blocks[0] as PauseBlock).duration).toBe(7);
    expect((blocks[2] as PauseBlock).duration).toBe(7);
  });

  it('count=1 does not duplicate (single iteration)', () => {
    const data = tzx(
      header(),
      block24(1),
      block20(50),
      block25(),
    );
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
  });

  it('expands a 3-block loop body correctly', () => {
    const data = tzx(
      header(),
      block24(2),
      block20(10), block20(20), block20(30),
      block25(),
    );
    const blocks = parseTZX(data) as PauseBlock[];
    expect(blocks.length).toBe(6);
    expect(blocks.map((b) => b.duration)).toEqual([10, 20, 30, 10, 20, 30]);
  });

  it('expands nested loops correctly (outer=3, inner=2, 1 block → 6 copies)', () => {
    // Outer 3 × inner 2 × [pause] = 6 total pauses.
    const data = tzx(
      header(),
      block24(3),
        block24(2),
          block20(1),
        block25(),
      block25(),
    );
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(6);
    expect(blocks.every((b) => b.kind === 'pause')).toBe(true);
  });
});

// ── Block 0x26 / 0x27 (Call / Return) — skipped ────────────────────────────

describe('TZX — 0x26 Call Sequence / 0x27 Return', () => {
  it('skips a call sequence and continues parsing', () => {
    const data = tzx(header(), block26([10, 20, 30]), block20(99));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as PauseBlock).duration).toBe(99);
  });

  it('skips a return block', () => {
    const data = tzx(header(), block27(), block20(11));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
  });
});

// ── Block 0x28 (Select Block) — skipped ────────────────────────────────────

describe('TZX — 0x28 Select Block', () => {
  it('skips an entire select block via its 2-byte total length', () => {
    const payload = new Array(50).fill(0xAA);
    const data = tzx(header(), block28(payload), block20(11));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as PauseBlock).duration).toBe(11);
  });
});

// ── Block 0x2A (Stop tape if in 48K mode) ──────────────────────────────────

describe('TZX — 0x2A Stop tape if in 48K mode', () => {
  it('produces a stop-if-48k block and consumes the 4-byte length', () => {
    const data = tzx(header(), block2A(), block20(50));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(2);
    expect(blocks[0].kind).toBe('stop-if-48k');
    expect(blocks[1].kind).toBe('pause');
  });
});

// ── Block 0x2B (Set Signal Level) ──────────────────────────────────────────

describe('TZX — 0x2B Set Signal Level', () => {
  it('captures a set-level block with the level bit (0 or 1)', () => {
    const data = tzx(header(), block2B(1));
    const b = parseTZX(data)[0] as SetLevelBlock;
    expect(b.kind).toBe('set-level');
    expect(b.level).toBe(1);
  });

  it('captures level=0', () => {
    const data = tzx(header(), block2B(0));
    const b = parseTZX(data)[0] as SetLevelBlock;
    expect(b.level).toBe(0);
  });
});

// ── Block 0x30 (Text Description) ──────────────────────────────────────────

describe('TZX — 0x30 Text Description', () => {
  it('captures a text block', () => {
    const data = tzx(header(), block30('Hello, World!'));
    const b = parseTZX(data)[0] as TextBlock;
    expect(b.kind).toBe('text');
    expect(b.text).toBe('Hello, World!');
  });

  it('handles an empty text block', () => {
    const data = tzx(header(), block30(''));
    const b = parseTZX(data)[0] as TextBlock;
    expect(b.text).toBe('');
  });
});

// ── Block 0x31 (Message) — skipped ─────────────────────────────────────────

describe('TZX — 0x31 Message Block', () => {
  it('skips a message block without producing a TapeBlock', () => {
    const data = tzx(header(), block31(5, 'Insert next tape'), block20(123));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('pause');
  });
});

// ── Block 0x32 (Archive Info) ──────────────────────────────────────────────

describe('TZX — 0x32 Archive Info', () => {
  it('captures all entries in order', () => {
    const data = tzx(header(), block32([
      { id: 0x00, text: 'Manic Miner' },
      { id: 0x02, text: 'Matthew Smith' },
      { id: 0x04, text: '1983' },
    ]));
    const b = parseTZX(data)[0] as ArchiveInfoBlock;
    expect(b.kind).toBe('archive-info');
    expect(b.entries).toEqual([
      { id: 0x00, text: 'Manic Miner' },
      { id: 0x02, text: 'Matthew Smith' },
      { id: 0x04, text: '1983' },
    ]);
  });

  it('handles a single-entry archive info block', () => {
    const data = tzx(header(), block32([{ id: 0xFF, text: 'X' }]));
    const b = parseTZX(data)[0] as ArchiveInfoBlock;
    expect(b.entries).toEqual([{ id: 0xFF, text: 'X' }]);
  });
});

// ── Block 0x33 / 0x35 / 0x5A (skipped) ─────────────────────────────────────

describe('TZX — 0x33 Hardware Type / 0x35 Custom Info / 0x5A Glue', () => {
  it('skips a 0x33 hardware-type block by count * 3 bytes', () => {
    const data = tzx(
      header(),
      block33([[1, 2, 3], [4, 5, 6], [7, 8, 9]]),
      block20(7),
    );
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as PauseBlock).duration).toBe(7);
  });

  it('skips a 0x35 custom info block with its 16-byte ID + 4-byte length', () => {
    const customData = new Array(100).fill(0x42);
    const data = tzx(header(), block35('POKES   ', customData), block20(8));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as PauseBlock).duration).toBe(8);
  });

  it('skips a 0x5A glue block (9 bytes)', () => {
    const data = tzx(header(), block5A(), block20(9));
    const blocks = parseTZX(data);
    expect(blocks.length).toBe(1);
    expect((blocks[0] as PauseBlock).duration).toBe(9);
  });
});

// ── Unknown block IDs ──────────────────────────────────────────────────────

describe('TZX — unknown block IDs', () => {
  it('throws on an unrecognised block id', () => {
    const data = tzx(header(), [0xEE]);
    expect(() => parseTZX(data)).toThrow(/Unknown TZX block type/);
  });
});

// ── Realistic multi-block TZX ──────────────────────────────────────────────

describe('TZX — realistic multi-block sequence', () => {
  it('parses a canonical header/data pair surrounded by metadata blocks', () => {
    const data = tzx(
      header(),
      block30('Loader'),
      block32([{ id: 0x00, text: 'Game' }]),
      block21('Header'),
      block10(1000, 0x00, [/* type */ 3, ...bytesOf('GAME      '), ...w16(10), ...w16(0x8000), ...w16(0x8000)]),
      block22(),
      block21('Data'),
      block10(1000, 0xFF, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
      block22(),
    );
    const blocks: TapeBlock[] = parseTZX(data);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toEqual([
      'text', 'archive-info',
      'group-start', 'data', 'group-end',
      'group-start', 'data', 'group-end',
    ]);
    const header_block = blocks[3] as DataBlock;
    const data_block = blocks[6] as DataBlock;
    expect(header_block.flag).toBe(0x00);
    expect(header_block.pilotCount).toBe(8063);
    expect(data_block.flag).toBe(0xFF);
    expect(data_block.pilotCount).toBe(3223);
  });
});

describe('TZX — rawDataBlocks option (CPC/CDT faithful bytes)', () => {
  it('attaches verbatim rawBytes to 0x10 and 0x11 data blocks when requested', () => {
    const data = tzx(
      header(),
      block10(1000, 0x16, [0xAA, 0xBB, 0xCC]),
      block11({ flag: 0x2C, payload: [0x01, 0x02, 0x03] }),
    );
    const blocks = parseTZX(data, { rawDataBlocks: true });
    const b10 = blocks[0] as DataBlock;
    const b11 = blocks[1] as DataBlock;
    // rawBytes is the full on-tape frame (flag/sync first, checksum last) — not
    // the flag/payload split the Spectrum model stores in .flag/.data.
    expect(Array.from(b10.rawBytes!)).toEqual([0x16, 0xAA, 0xBB, 0xCC, 0x16 ^ 0xAA ^ 0xBB ^ 0xCC]);
    expect(Array.from(b11.rawBytes!)).toEqual([0x2C, 0x01, 0x02, 0x03, 0x2C ^ 0x01 ^ 0x02 ^ 0x03]);
  });

  it('leaves rawBytes undefined by default (Spectrum parsing unchanged)', () => {
    const data = tzx(header(), block11({ flag: 0xFF, payload: [1, 2, 3] }));
    const blk = parseTZX(data)[0] as DataBlock;
    expect(blk.rawBytes).toBeUndefined();
  });
});
