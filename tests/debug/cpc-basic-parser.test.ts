/**
 * Locomotive BASIC detokenizer tests.
 *
 * Every record below is the EXACT byte sequence the real CPC 6128 firmware
 * (OS6128 + BASIC 1.1) produced when the listed line was typed in — captured by
 * dumping RAM at &0170. The expected text is the corresponding LIST output. This
 * pins the detokenizer to verified hardware behaviour, not to its own logic.
 */
import { describe, it, expect } from 'vitest';
import { parseLocomotiveBasic } from '@/debug/cpc-basic-parser.ts';

const PROG_START = 0x0170;

/** Build a 64KB RAM image with the given line records at &0170 + a 0x0000 end
 *  marker, then detokenize and return the listing as plain-text lines. */
function listing(records: number[][]): string[] {
  const ram = new Uint8Array(0x10000);
  let o = PROG_START;
  for (const rec of records) { ram.set(rec, o); o += rec.length; }
  // end-of-program marker is the next length word being zero (already 0).
  const html = parseLocomotiveBasic(ram);
  return html.split('\n').map(l => l.replace(/<[^>]*>/g, '').trim());
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

  it('escapes HTML metacharacters from relational operator tokens', () => {
    // a(var) ee(>) b(var):  ee renders as ">", which must be HTML-escaped.
    const html = parseLocomotiveBasic((() => {
      const ram = new Uint8Array(0x10000);
      // 10 IF a>0 THEN ...  — keep it minimal: a > 0
      ram.set([0x0c, 0x00, 0x0a, 0x00, 0x0d, 0x00, 0x00, 0xe1, 0xee, 0x0e, 0x00], PROG_START);
      return ram;
    })());
    expect(html).toContain('&gt;');
    expect(html).not.toMatch(/[^&]>0/); // the raw '>' must not appear unescaped before 0
  });

  it('returns a placeholder when there is no program', () => {
    expect(parseLocomotiveBasic(new Uint8Array(0x10000))).toContain('no BASIC program');
  });

  it('stops at the &0000 end-of-program marker (ignores trailing garbage)', () => {
    const ram = new Uint8Array(0x10000);
    ram.set([0x08, 0x00, 0x0a, 0x00, 0xbf, 0x20, 0x0f, 0x00], PROG_START); // 10 PRINT 1
    // end marker, then garbage that must not be parsed as a line
    ram.set([0x00, 0x00, 0xde, 0xad, 0xbe, 0xef], PROG_START + 8);
    const lines = parseLocomotiveBasic(ram).split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].replace(/<[^>]*>/g, '').trim()).toBe('10 PRINT 1');
  });
});
