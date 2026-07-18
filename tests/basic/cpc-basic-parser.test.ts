/**
 * Locomotive BASIC detokenizer tests.
 *
 * Every record below is the EXACT byte sequence the real CPC 6128 firmware
 * (OS6128 + BASIC 1.1) produced when the listed line was typed in — captured by
 * dumping RAM at &0170. The expected text is the corresponding LIST output. This
 * pins the detokenizer to verified hardware behaviour, not to its own logic.
 */
import { describe, it, expect } from 'vitest';
import { parseLocomotiveBasic, parseLocomotiveVariables } from '@/basic/cpc-basic-parser.ts';
import type { BasicVariable } from '@/basic/types.ts';

const PROG_START = 0x0170;

/** Build a 64KB RAM image with the given line records at &0170 + a 0x0000 end
 *  marker, then detokenize and return the listing as "<num> <text>" lines. */
function listing(records: number[][]): string[] {
  const ram = new Uint8Array(0x10000);
  let o = PROG_START;
  for (const rec of records) { ram.set(rec, o); o += rec.length; }
  // end-of-program marker is the next length word being zero (already 0).
  return parseLocomotiveBasic(ram).map(l => `${l.lineNumber} ${l.text}`);
}

describe('parseLocomotiveBasic', () => {
  it('detokenizes an 8-bit integer constant (PRINT 42)', () => {
    // 09 00 | 0a 00 | bf(PRINT) 20(sp) 19 2a(=42) | 00
    expect(listing([[0x09, 0x00, 0x0a, 0x00, 0xbf, 0x20, 0x19, 0x2a, 0x00]]))
      .toEqual(['10 PRINT 42']);
  });

  it('detokenizes a 16-bit integer constant (PRINT 1000)', () => {
    // 1a e8 03 = 0x03E8 = 1000
    expect(listing([[0x0a, 0x00, 0x14, 0x00, 0xbf, 0x20, 0x1a, 0xe8, 0x03, 0x00]]))
      .toEqual(['20 PRINT 1000']);
  });

  it('detokenizes single-digit constants packed in the lead byte (PRINT 9)', () => {
    // 0x17 = 0x0E + 9
    expect(listing([[0x08, 0x00, 0x0a, 0x00, 0xbf, 0x20, 0x17, 0x00]]))
      .toEqual(['10 PRINT 9']);
  });

  it('decodes a 5-byte floating-point constant (PRINT 3.5)', () => {
    // 1f 00 00 00 60 82 — mantissa 0x60000000, exp 0x82 ⇒ 0.875 × 2^2 = 3.5
    expect(listing([[0x0d, 0x00, 0x1e, 0x00, 0xbf, 0x20, 0x1f, 0x00, 0x00, 0x00, 0x60, 0x82, 0x00]]))
      .toEqual(['30 PRINT 3.5']);
  });

  it('renders a real variable with no suffix (PRINT a)', () => {
    // 0d(real) 00 00(ptr) e1(='a'|0x80)
    expect(listing([[0x0b, 0x00, 0x28, 0x00, 0xbf, 0x20, 0x0d, 0x00, 0x00, 0xe1, 0x00]]))
      .toEqual(['40 PRINT a']);
  });

  it('renders string and integer variable suffixes (PRINT b$ / c%)', () => {
    const out = listing([
      [0x0b, 0x00, 0x0a, 0x00, 0xbf, 0x20, 0x03, 0x00, 0x00, 0xe2, 0x00], // b$
      [0x0b, 0x00, 0x14, 0x00, 0xbf, 0x20, 0x02, 0x00, 0x00, 0xe3, 0x00], // c%
    ]);
    expect(out).toEqual(['10 PRINT b$', '20 PRINT c%']);
  });

  it('resolves a line-number reference (GOTO 20)', () => {
    // a0(GOTO) 20(sp) 1e 14 00(=line 20)
    expect(listing([[0x0a, 0x00, 0x32, 0x00, 0xa0, 0x20, 0x1e, 0x14, 0x00, 0x00]]))
      .toEqual(['50 GOTO 20']);
  });

  it('detokenizes keywords and an embedded comma (MODE 1 / INK 0,1)', () => {
    const out = listing([
      [0x08, 0x00, 0x0a, 0x00, 0xad, 0x20, 0x0f, 0x00],                   // MODE 1
      [0x0a, 0x00, 0x14, 0x00, 0xa2, 0x20, 0x0e, 0x2c, 0x0f, 0x00],       // INK 0,1
    ]);
    expect(out).toEqual(['10 MODE 1', '20 INK 0,1']);
  });

  it('detokenizes a function token via the &FF prefix (PRINT SIN)', () => {
    // ff 15 = SIN
    expect(listing([[0x09, 0x00, 0x0a, 0x00, 0xbf, 0x20, 0xff, 0x15, 0x00]]))
      .toEqual(['10 PRINT SIN']);
  });

  it('returns relational operator tokens as raw text (escaping is the renderer`s job)', () => {
    // a(var) ee(>) 0:  ee detokenizes to ">". The parser must return it raw —
    // it produces plain data, and the pane escapes it via Solid interpolation.
    const ram = new Uint8Array(0x10000);
    // 10 IF a>0 THEN ...  — keep it minimal: a > 0
    ram.set([0x0c, 0x00, 0x0a, 0x00, 0x0d, 0x00, 0x00, 0xe1, 0xee, 0x0e, 0x00], PROG_START);
    const lines = parseLocomotiveBasic(ram);
    expect(lines).toEqual([{ lineNumber: 10, text: 'a>0' }]);
    // No HTML entities leak into the structured output.
    expect(lines[0].text).not.toContain('&gt;');
  });

  it('returns an empty listing when there is no program', () => {
    expect(parseLocomotiveBasic(new Uint8Array(0x10000))).toEqual([]);
  });

  it('stops at the &0000 end-of-program marker (ignores trailing garbage)', () => {
    const ram = new Uint8Array(0x10000);
    ram.set([0x08, 0x00, 0x0a, 0x00, 0xbf, 0x20, 0x0f, 0x00], PROG_START); // 10 PRINT 1
    // end marker, then garbage that must not be parsed as a line
    ram.set([0x00, 0x00, 0xde, 0xad, 0xbe, 0xef], PROG_START + 8);
    const lines = parseLocomotiveBasic(ram);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ lineNumber: 10, text: 'PRINT 1' });
  });
});

/**
 * Locomotive BASIC variable-table tests.
 *
 * The layouts here were captured from real CPC firmware by creating variables
 * (via INPUT / DIM, which need no `=` key) and dumping RAM. Simple variables and
 * arrays occupy two separate regions delimited by the pointer block
 * [016F][VARTAB][VARTAB][ARYTAB][ARYEND] in BASIC's workspace (&AE64 on BASIC
 * 1.1, &AE81 on BASIC 1.0). The builder writes that block from the region sizes
 * so each test states only the variable bytes it cares about.
 */
const ZEROS = (n: number): number[] => new Array(n).fill(0);

function buildVarRam(opts: {
  program?: number[];                       // bytes at &0170, ending with the 00 00 marker
  simple?: number[];                        // simple-variable region bytes
  arrays?: number[];                        // array region bytes
  strings?: { addr: number; bytes: number[] }[];
  blockAddr?: number;                       // pointer-block address (default &AE64)
  withBlock?: boolean;                      // omit the block entirely (default true)
}): Uint8Array {
  const ram = new Uint8Array(0x10000);
  const program = opts.program ?? [0x00, 0x00];
  ram.set(program, 0x0170);
  const vartab = 0x0170 + program.length;   // program must end with its 00 00 marker
  const simple = opts.simple ?? [];
  const arrays = opts.arrays ?? [];
  const arytab = vartab + simple.length;
  const aryend = arytab + arrays.length;
  ram.set(simple, vartab);
  ram.set(arrays, arytab);
  for (const s of opts.strings ?? []) ram.set(s.bytes, s.addr);
  if (opts.withBlock ?? true) {
    const b = opts.blockAddr ?? 0xAE64;
    const w = (a: number, v: number) => { ram[a] = v & 0xFF; ram[a + 1] = (v >> 8) & 0xFF; };
    w(b, 0x016F); w(b + 2, vartab); w(b + 4, vartab); w(b + 6, arytab); w(b + 8, aryend);
  }
  return ram;
}

describe('parseLocomotiveVariables', () => {
  it('decodes every simple type and an array from a real 6128 capture', () => {
    // Exact bytes dumped after: INPUT a→1234, INPUT b%→1000, INPUT n$→"HELLO",
    // INPUT z→42, DIM sc(5). Names are stored upper-cased; the `%`/`$` suffix is
    // implied by the type byte (04 real, 01 integer, 02 string), not stored.
    const simple = [
      0x00, 0x00, 0xC1, 0x04, 0x00, 0x00, 0x40, 0x1A, 0x8B,   // A  = 1234 (real)
      0x00, 0x00, 0xC2, 0x01, 0xE8, 0x03,                     // B% = 1000 (integer)
      0x00, 0x00, 0xCE, 0x02, 0x05, 0x77, 0xA6,               // N$ = ptr→&A677, len 5
      0x00, 0x00, 0xDA, 0x04, 0x00, 0x00, 0x00, 0x28, 0x86,   // Z  = 42 (real)
    ];
    const arrays = [
      0x00, 0x00, 0x53, 0xC3, 0x04, 0x21, 0x00, 0x01, 0x06, 0x00, // SC(): 1 dim, size 6
      ...ZEROS(30),                                               // 6 × 5-byte elements
    ];
    const ram = buildVarRam({
      simple, arrays,
      strings: [{ addr: 0xA677, bytes: [0x48, 0x45, 0x4C, 0x4C, 0x4F] }], // "HELLO"
    });
    expect(parseLocomotiveVariables(ram)).toEqual<BasicVariable[]>([
      { name: 'A', kind: 'number', value: '1234' },
      { name: 'B%', kind: 'number', value: '1000' },
      { name: 'N$', kind: 'string', value: 'HELLO' },
      { name: 'Z', kind: 'number', value: '42' },
      { name: 'SC(5)', kind: 'array' },
    ]);
  });

  it('reads a negative integer as 16-bit two`s complement', () => {
    // X% = -5  →  &FFFB little-endian.
    const ram = buildVarRam({ simple: [0x00, 0x00, 0xD8, 0x01, 0xFB, 0xFF] });
    expect(parseLocomotiveVariables(ram)).toEqual<BasicVariable[]>([
      { name: 'X%', kind: 'number', value: '-5' },
    ]);
  });

  it('reads a multi-character variable name', () => {
    // COUNT% = 7  →  name letters C O U N, last (T) has bit 7 set.
    const ram = buildVarRam({
      simple: [0x00, 0x00, 0x43, 0x4F, 0x55, 0x4E, 0xD4, 0x01, 0x07, 0x00],
    });
    expect(parseLocomotiveVariables(ram)).toEqual<BasicVariable[]>([
      { name: 'COUNT%', kind: 'number', value: '7' },
    ]);
  });

  it('shows a 2-D array as its DIM subscripts, skipping element data', () => {
    // DIM q(2,3): 2 dims, stored sizes 3 and 4 (subscript + 1). Payload size
    // &41 = 1 (ndims) + 4 (dim words) + 60 (3×4 reals × 5 bytes).
    const ram = buildVarRam({
      arrays: [
        0x00, 0x00, 0xD1, 0x04, 0x41, 0x00, 0x02, 0x03, 0x00, 0x04, 0x00,
        ...ZEROS(60),
      ],
    });
    expect(parseLocomotiveVariables(ram)).toEqual<BasicVariable[]>([
      { name: 'Q(2,3)', kind: 'array' },
    ]);
  });

  it('locates the pointer block at the BASIC 1.0 (464) address &AE81', () => {
    const ram = buildVarRam({ simple: [0x00, 0x00, 0xC1, 0x01, 0x2A, 0x00], blockAddr: 0xAE81 });
    expect(parseLocomotiveVariables(ram)).toEqual<BasicVariable[]>([
      { name: 'A%', kind: 'number', value: '42' },
    ]);
  });

  it('returns [] when there are no variables', () => {
    expect(parseLocomotiveVariables(buildVarRam({}))).toEqual([]);
  });

  it('returns [] when the workspace pointer block is absent', () => {
    expect(parseLocomotiveVariables(buildVarRam({
      simple: [0x00, 0x00, 0xC1, 0x01, 0x2A, 0x00], withBlock: false,
    }))).toEqual([]);
  });
});
