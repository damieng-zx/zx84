import { describe, it, expect } from 'vitest';
import { parseBasicProgram, parseBasicVariables } from '@/debug/basic-parser.ts';

/**
 * Sinclair BASIC stored-number format: ASCII digits, then a single
 * 0x0E marker, then 5 bytes of binary form. Integer form uses
 * [exp=0, sign(0|0xFF), lo, hi, 0].
 */
function intNumber(n: number): number[] {
  const neg = n < 0;
  const v = neg ? n + 65536 : n;
  return [0x00, neg ? 0xFF : 0x00, v & 0xFF, (v >> 8) & 0xFF, 0x00];
}
function numLiteral(asciiDigits: string, value: number): number[] {
  const out: number[] = [];
  for (const c of asciiDigits) out.push(c.charCodeAt(0));
  out.push(0x0E, ...intNumber(value));
  return out;
}

function buildBasicMemory(lines: { num: number; text: number[] }[]): Uint8Array {
  const mem = new Uint8Array(65536);

  const progAddr = 0x8000;
  mem[0x5C53] = progAddr & 0xFF;
  mem[0x5C54] = (progAddr >> 8) & 0xFF;

  let offset = progAddr;
  for (const line of lines) {
    mem[offset] = (line.num >> 8) & 0xFF;
    mem[offset + 1] = line.num & 0xFF;
    const lineLen = line.text.length + 1;
    mem[offset + 2] = lineLen & 0xFF;
    mem[offset + 3] = (lineLen >> 8) & 0xFF;
    for (let i = 0; i < line.text.length; i++) {
      mem[offset + 4 + i] = line.text[i];
    }
    mem[offset + 4 + line.text.length] = 0x0D;
    offset += 4 + lineLen;
  }

  const varsAddr = offset;
  mem[0x5C4B] = varsAddr & 0xFF;
  mem[0x5C4C] = (varsAddr >> 8) & 0xFF;

  return mem;
}

describe('parseBasicProgram — empty/invalid', () => {
  it('returns no-program message when PROG is 0', () => {
    const mem = new Uint8Array(65536);
    const result = parseBasicProgram(mem);
    expect(result).toContain('no BASIC program');
  });

  it('returns no-program when PROG >= VARS', () => {
    const mem = new Uint8Array(65536);
    mem[0x5C53] = 0x00; mem[0x5C54] = 0x80;
    mem[0x5C4B] = 0x00; mem[0x5C4C] = 0x70;
    const result = parseBasicProgram(mem);
    expect(result).toContain('no BASIC program');
  });

  it('returns empty-program when there are no lines', () => {
    const mem = new Uint8Array(65536);
    const progAddr = 0x8000;
    mem[0x5C53] = progAddr & 0xFF; mem[0x5C54] = (progAddr >> 8) & 0xFF;
    const varsAddr = progAddr + 2;
    mem[0x5C4B] = varsAddr & 0xFF; mem[0x5C4C] = (varsAddr >> 8) & 0xFF;
    mem[progAddr] = 0x80;
    const result = parseBasicProgram(mem);
    expect(result).toContain('empty program');
  });
});

describe('parseBasicProgram — simple lines', () => {
  it('parses a simple PRINT line', () => {
    const mem = buildBasicMemory([
      { num: 10, text: [0xF5, 0x22, 0x48, 0x49, 0x22] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('10');
    expect(result).toContain('PRINT');
    expect(result).toContain('"HI"');
  });

  it('parses a LET assignment', () => {
    const mem = buildBasicMemory([
      { num: 10, text: [0xF1, 0x61, 0x3D, 0x31, 0x32, 0x33, 0x0E, 0x00, 0x00, 0x7B, 0x00, 0x00] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('10');
    expect(result).toContain('LET');
    expect(result).toContain('a');
    expect(result).toContain('123');
  });

  it('parses multiple lines', () => {
    const mem = buildBasicMemory([
      { num: 10, text: [0xF5, 0x22, 0x48, 0x49, 0x22] },
      { num: 20, text: [0xF7] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('10');
    expect(result).toContain('20');
    expect(result).toContain('PRINT');
    expect(result).toContain('RUN');
  });

  it('detokenizes 128K-only tokens', () => {
    const mem = buildBasicMemory([
      { num: 1, text: [0xA3] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('SPECTRUM');
  });
});

describe('parseBasicProgram — line numbers', () => {
  it('pads line numbers', () => {
    const mem = buildBasicMemory([
      { num: 1, text: [0xF7] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toMatch(/\b\s*1\b/);
  });

  it('handles high line numbers', () => {
    const mem = buildBasicMemory([
      { num: 9999, text: [0xF7] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('9999');
  });
});

// ── Critical: number marker, HTML escape, embedded chars ─────────────────

describe('parseBasicProgram — number marker handling', () => {
  it('eats the 0x0E marker + 5 binary bytes after digits', () => {
    // "10 GO TO 100" — 100 is followed by 0x0E + 5 binary bytes.
    const mem = buildBasicMemory([
      { num: 10, text: [0xEC, ...numLiteral('100', 100)] },
    ]);
    const result = parseBasicProgram(mem);
    // Digits are kept, marker + binary bytes are gone — no stray ASCII '@'/'d'
    // from the binary [00 00 64 00 00] should leak into the output.
    expect(result).toContain('100');
    expect(result).not.toMatch(/100.*[\x00-\x08]/);
    // The trailing zero bytes shouldn't print as junk control chars either.
    expect(result).not.toContain('[00]');
  });

  it('treats a tilde (0x7E) as printable, NOT as a number marker', () => {
    // BUG: code currently consumes 0x7E + 5 bytes as if it were a number
    // marker. The Sinclair ROM only ever emits 0x0E; 0x7E is plain ASCII '~'.
    // A REM with "~ABCDE" should render as "~ABCDE", not as "" (the parser
    // eating ~ + the next 5 chars).
    const tilde = 0x7E;
    const abcde = [0x41, 0x42, 0x43, 0x44, 0x45]; // "ABCDE"
    const mem = buildBasicMemory([
      { num: 10, text: [0xEA, tilde, ...abcde] }, // REM ~ABCDE
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('~ABCDE');
  });
});

describe('parseBasicProgram — HTML escaping', () => {
  it('escapes <, >, & in line text', () => {
    // Use the <=, >= and "and" tokens? Those use entity-unsafe chars in their
    // detokenized form. Easier: put literal ASCII '<' '>' '&' into a REM.
    const mem = buildBasicMemory([
      { num: 10, text: [0xEA, 0x3C, 0x26, 0x3E] }, // REM <&>
    ]);
    const result = parseBasicProgram(mem);
    // Raw chars must not appear, escaped entities must.
    expect(result).not.toMatch(/REM\s+<&>/);
    expect(result).toContain('&lt;');
    expect(result).toContain('&amp;');
    expect(result).toContain('&gt;');
  });

  it('renders the <= token without leaking raw < into HTML', () => {
    // Token 0xC7 = '<='. The string contains a literal '<' — which must be
    // escaped before insertion into the output HTML.
    const mem = buildBasicMemory([
      { num: 10, text: [0xFA, 0x61, 0xC7, 0x35] }, // IF a<=5
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('&lt;=');
    // Raw '<=' would be a broken-HTML symptom.
    const lineSection = result.split('class="basic-line-num">')[1] ?? result;
    expect(lineSection).not.toMatch(/<=/);
  });
});

describe('parseBasicProgram — embedded characters', () => {
  it('renders 0x0A as the newline glyph', () => {
    const mem = buildBasicMemory([
      { num: 10, text: [0xEA, 0x41, 0x0A, 0x42] }, // REM A␤B
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('↵');
  });

  it('renders unknown control bytes as bracketed hex', () => {
    const mem = buildBasicMemory([
      { num: 10, text: [0xEA, 0x01, 0x1F] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('[01]');
    expect(result).toContain('[1F]');
  });
});

describe('parseBasicProgram — end-of-program markers', () => {
  it('stops cleanly when high-byte of line number is 0x80', () => {
    const mem = new Uint8Array(65536);
    const progAddr = 0x8000;
    mem[0x5C53] = progAddr & 0xFF; mem[0x5C54] = (progAddr >> 8) & 0xFF;
    // Real line: 10 RUN
    mem[progAddr + 0] = 0x00; mem[progAddr + 1] = 0x0A;
    mem[progAddr + 2] = 0x02; mem[progAddr + 3] = 0x00;
    mem[progAddr + 4] = 0xF7; mem[progAddr + 5] = 0x0D;
    // End marker
    mem[progAddr + 6] = 0x80;
    const varsAddr = progAddr + 16;
    mem[0x5C4B] = varsAddr & 0xFF; mem[0x5C4C] = (varsAddr >> 8) & 0xFF;
    const result = parseBasicProgram(mem);
    expect(result).toContain('10');
    expect(result).toContain('RUN');
  });

  it('aborts safely when a line claims a length that overruns VARS', () => {
    const mem = new Uint8Array(65536);
    const progAddr = 0x8000;
    mem[0x5C53] = progAddr & 0xFF; mem[0x5C54] = (progAddr >> 8) & 0xFF;
    const varsAddr = progAddr + 8;
    mem[0x5C4B] = varsAddr & 0xFF; mem[0x5C4C] = (varsAddr >> 8) & 0xFF;
    // Line claims length 0xFFFF — must NOT be parsed and must NOT hang.
    mem[progAddr + 0] = 0x00; mem[progAddr + 1] = 0x0A;
    mem[progAddr + 2] = 0xFF; mem[progAddr + 3] = 0xFF;
    const result = parseBasicProgram(mem);
    // Either renders nothing or the empty-program fallback — but doesn't crash.
    expect(typeof result).toBe('string');
  });
});

// ── parseBasicVariables ──────────────────────────────────────────────────

function buildVarsMemory(varBytes: number[]): Uint8Array {
  const mem = new Uint8Array(65536);
  const varsAddr = 0x9000;
  mem[0x5C4B] = varsAddr & 0xFF; mem[0x5C4C] = (varsAddr >> 8) & 0xFF;
  // E_LINE just past the vars area.
  const eLine = varsAddr + varBytes.length + 1;
  mem[0x5C59] = eLine & 0xFF; mem[0x5C5A] = (eLine >> 8) & 0xFF;
  for (let i = 0; i < varBytes.length; i++) mem[varsAddr + i] = varBytes[i];
  mem[varsAddr + varBytes.length] = 0x80; // end-of-vars marker
  return mem;
}

describe('parseBasicVariables — empty/invalid', () => {
  it('returns no-variables message when VARS is 0', () => {
    const mem = new Uint8Array(65536);
    expect(parseBasicVariables(mem)).toContain('no variables');
  });

  it('returns no-variables when VARS >= E_LINE', () => {
    const mem = new Uint8Array(65536);
    mem[0x5C4B] = 0x00; mem[0x5C4C] = 0x80;
    mem[0x5C59] = 0x00; mem[0x5C5A] = 0x70;
    expect(parseBasicVariables(mem)).toContain('no variables');
  });

  it('returns no-variables when the area starts with the 0x80 end marker', () => {
    const mem = buildVarsMemory([]); // helper writes 0x80 at varsAddr
    expect(parseBasicVariables(mem)).toContain('no variables defined');
  });
});

describe('parseBasicVariables — simple numeric (positive/negative/zero)', () => {
  it('parses a single-letter numeric variable a = 42', () => {
    const mem = buildVarsMemory([0x61, ...intNumber(42)]);
    const result = parseBasicVariables(mem);
    expect(result).toContain('a');
    expect(result).toContain('= 42');
  });

  it('handles negative integer correctly (uses 2-byte signed form)', () => {
    const mem = buildVarsMemory([0x61, ...intNumber(-7)]);
    const result = parseBasicVariables(mem);
    expect(result).toContain('-7');
  });

  it('handles zero', () => {
    const mem = buildVarsMemory([0x61, ...intNumber(0)]);
    const result = parseBasicVariables(mem);
    expect(result).toMatch(/=\s*0(?!\d)/);
  });

  it('parses multiple consecutive variables', () => {
    const mem = buildVarsMemory([
      0x61, ...intNumber(1),
      0x62, ...intNumber(2),
      0x63, ...intNumber(3),
    ]);
    const result = parseBasicVariables(mem);
    expect(result).toContain('a');
    expect(result).toContain('= 1');
    expect(result).toContain('b');
    expect(result).toContain('= 2');
    expect(result).toContain('c');
    expect(result).toContain('= 3');
  });
});

describe('parseBasicVariables — strings', () => {
  it('parses a$ = "hi"', () => {
    // String var: 0x40 | letter-offset. 'a' offset = 1, so byte = 0x41.
    const mem = buildVarsMemory([0x41, 0x02, 0x00, 0x68, 0x69]);
    const result = parseBasicVariables(mem);
    expect(result).toMatch(/[Aa]\$/);
    expect(result).toContain('"hi"');
  });

  it('escapes HTML metacharacters in string contents', () => {
    const mem = buildVarsMemory([0x41, 0x03, 0x00, 0x3C, 0x26, 0x3E]);
    const result = parseBasicVariables(mem);
    expect(result).toContain('&lt;');
    expect(result).toContain('&amp;');
    expect(result).toContain('&gt;');
  });

  it('handles empty string a$ = ""', () => {
    const mem = buildVarsMemory([0x41, 0x00, 0x00]);
    const result = parseBasicVariables(mem);
    expect(result).toContain('""');
  });
});

describe('parseBasicVariables — arrays', () => {
  it('shows numeric array as a name + [array] marker', () => {
    // Numeric array: top 3 bits = 100. Array A() = 0x81. dataLen=0 for the test.
    const mem = buildVarsMemory([0x81, 0x00, 0x00]);
    const result = parseBasicVariables(mem);
    expect(result).toContain('[array]');
    expect(result).toMatch(/[Aa]\(\)/);
  });

  it('shows string array as a$() with [array] marker', () => {
    // String array: top 3 bits = 110. A$() = 0xC1. dataLen=0.
    const mem = buildVarsMemory([0xC1, 0x00, 0x00]);
    const result = parseBasicVariables(mem);
    expect(result).toContain('[array]');
    expect(result).toMatch(/[Aa]\$\(\)/);
  });
});

describe('parseBasicVariables — FOR-NEXT control', () => {
  it('shows current/limit/step for FOR i=1 TO 10 STEP 1', () => {
    // FOR-NEXT: top 3 bits = 111. 'i' offset = 9, byte = 0xE9.
    const mem = buildVarsMemory([
      0xE9,
      ...intNumber(1),
      ...intNumber(10),
      ...intNumber(1),
      // The parser also reads "looping line + statement" extras in real
      // ROMs but the current parser stops at 18 bytes — that's what we test.
    ]);
    const result = parseBasicVariables(mem);
    expect(result).toMatch(/=\s*1\b/);
    expect(result).toContain('TO 10');
    expect(result).toContain('STEP 1');
  });
});

// ── Post-fix correct-behaviour tests ─────────────────────────────────────

describe('parseBasicProgram — token spacing', () => {
  it('emits a single space between tokens, not two', () => {
    // 0xF5 = ' PRINT ', 0xA5 = 'RND'. Old code appended an extra ' ' to each
    // token, producing 'PRINT  RND'. With the fix it should be 'PRINT RND'.
    const mem = buildBasicMemory([
      { num: 10, text: [0xF5, 0xA5] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('PRINT RND');
    expect(result).not.toContain('PRINT  RND');
  });

  it('does not introduce extra spaces between a token and an identifier', () => {
    // 0xF1 = 'LET ', 'a' = 0x61. Old: 'LET  a'. New: 'LET a'.
    const mem = buildBasicMemory([
      { num: 10, text: [0xF1, 0x61, 0x3D, 0x31] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('LET a=1');
  });
});

describe('parse5ByteNumber — floating-point', () => {
  // We exercise it indirectly via a numeric variable.
  function readVar(bytes5: number[]): string {
    const mem = buildVarsMemory([0x61, ...bytes5]);
    return parseBasicVariables(mem);
  }

  it('decodes PI ≈ 3.14159…', () => {
    // Spectrum-stored PI: [0x82, 0x49, 0x0F, 0xDA, 0xA2]
    const result = readVar([0x82, 0x49, 0x0F, 0xDA, 0xA2]);
    expect(result).toMatch(/=\s*3\.1415/);
  });

  it('decodes 1.0 from the canonical FP form', () => {
    // 1.0 = [0x81, 0x00, 0x00, 0x00, 0x00]
    const result = readVar([0x81, 0x00, 0x00, 0x00, 0x00]);
    expect(result).toMatch(/=\s*1\b/);
  });

  it('decodes 0.5', () => {
    const result = readVar([0x80, 0x00, 0x00, 0x00, 0x00]);
    expect(result).toMatch(/=\s*0\.5\b/);
  });

  it('decodes -2.0 (sign bit in high bit of byte 1)', () => {
    const result = readVar([0x82, 0x80, 0x00, 0x00, 0x00]);
    expect(result).toMatch(/=\s*-2\b/);
  });

  it('no longer emits the [hex hex hex hex hex] fallback', () => {
    const result = readVar([0x82, 0x49, 0x0F, 0xDA, 0xA2]);
    expect(result).not.toMatch(/\[82 49/);
  });
});

describe('parse5ByteNumber — integer-form strictness', () => {
  it('treats a record with non-canonical sign byte as FP (not int)', () => {
    // exp=0, b4=0, b1=0x50 (neither 0 nor 0xFF). Old code would compute
    // value = b2|b3<<8 = 0x42, displaying as "66". New code falls through
    // to FP — which for exp=0 yields a vanishingly small number, NOT '66'.
    const mem = buildVarsMemory([0x61, 0x00, 0x50, 0x42, 0x00, 0x00]);
    const result = parseBasicVariables(mem);
    expect(result).not.toContain('= 66');
  });
});

describe('parseBasicVariables — array dimensions', () => {
  it('shows a 1-D numeric array as A(N)', () => {
    // A(5): type=0x81, dataLen = 1 + 2 + 5*5 = 28
    const elements: number[] = [];
    for (let i = 0; i < 5; i++) elements.push(...intNumber(0));
    const dataLen = 1 + 2 + elements.length;
    const mem = buildVarsMemory([
      0x81,
      dataLen & 0xFF, (dataLen >> 8) & 0xFF,
      0x01, // dimCount
      0x05, 0x00, // dim 0 = 5
      ...elements,
    ]);
    const result = parseBasicVariables(mem);
    expect(result).toMatch(/[Aa]\(5\)/);
  });

  it('shows a 2-D numeric array as B(M,N)', () => {
    // B(2,3): type=0x82, dataLen = 1 + 4 + 6*5 = 35
    const elements: number[] = [];
    for (let i = 0; i < 6; i++) elements.push(...intNumber(0));
    const dataLen = 1 + 4 + elements.length;
    const mem = buildVarsMemory([
      0x82,
      dataLen & 0xFF, (dataLen >> 8) & 0xFF,
      0x02,
      0x02, 0x00,
      0x03, 0x00,
      ...elements,
    ]);
    const result = parseBasicVariables(mem);
    expect(result).toMatch(/[Bb]\(2,3\)/);
  });

  it('shows a string array as S$(M,N)', () => {
    // S$(2,10): type=0xD3 (0xC0 | 0x13 — letter offset 19 = 's'),
    // dataLen = 1 + 4 + 2*10 = 25
    const stringBytes = new Array(20).fill(0x20); // 20 spaces
    const dataLen = 1 + 4 + stringBytes.length;
    const mem = buildVarsMemory([
      0xD3,
      dataLen & 0xFF, (dataLen >> 8) & 0xFF,
      0x02,
      0x02, 0x00,
      0x0A, 0x00,
      ...stringBytes,
    ]);
    const result = parseBasicVariables(mem);
    expect(result).toMatch(/[Ss]\$\(2,10\)/);
  });
});

describe('parseBasicVariables — robustness', () => {
  it('stops on an unknown variable-type byte rather than looping forever', () => {
    // 0x00 has typeFlags 0x00 — none of the if-branches match.
    const mem = buildVarsMemory([0x00, 0x00, 0x00]);
    const result = parseBasicVariables(mem);
    // The parser breaks → no lines were appended → fallback message.
    expect(result).toContain('no variables defined');
  });
});
