import { describe, expect, it } from 'vitest';
import { parseMtxBasic } from '@/basic/mtx-basic-parser.ts';

/**
 * Fixture is the real tokenised program captured from a live MTX512 RAM dump
 * (program at CPU 0x4000). It exercises REM's verbatim comment, a string
 * literal, the FOR/TO/STEP + '=' spacing, and a trailing block of stale RAM
 * bytes past the last line that the parser must not mistake for a line.
 *
 *   10 REM TEST
 *   20 PRINT "HELLO"
 *   30 FOR I=1 TO 10 STEP 2
 *   40 NEXT I
 *   50 GOTO 20
 *   60 PRINT 42
 */
const PROGRAM = [
  0x0B, 0x00, 0x0A, 0x00, 0x80, 0x20, 0x54, 0x45, 0x53, 0x54, 0xFF,
  0x0D, 0x00, 0x14, 0x00, 0x90, 0x22, 0x48, 0x45, 0x4C, 0x4C, 0x4F, 0x22, 0xFF,
  0x0E, 0x00, 0x1E, 0x00, 0x95, 0x49, 0xD4, 0x31, 0xC8, 0x31, 0x30, 0xC6, 0x32, 0xFF,
  0x07, 0x00, 0x28, 0x00, 0x94, 0x49, 0xFF,
  0x08, 0x00, 0x32, 0x00, 0x96, 0x32, 0x30, 0xFF,
  0x08, 0x00, 0x3C, 0x00, 0x90, 0x34, 0x32, 0xFF,
  0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // stale RAM past the program
];

function memoryWithProgram(bytes: number[]): Uint8Array {
  const mem = new Uint8Array(0x10000);
  mem.set(bytes, 0x4000);
  return mem;
}

describe('parseMtxBasic', () => {
  it('detokenises the captured program, matching MTX LIST spacing', () => {
    const lines = parseMtxBasic(memoryWithProgram(PROGRAM));
    expect(lines).toEqual([
      { lineNumber: 10, text: 'REM TEST' },
      { lineNumber: 20, text: 'PRINT "HELLO"' },
      { lineNumber: 30, text: 'FOR I=1 TO 10 STEP 2' },
      { lineNumber: 40, text: 'NEXT I' },
      { lineNumber: 50, text: 'GOTO 20' },
      { lineNumber: 60, text: 'PRINT 42' },
    ]);
  });

  it('stops at the end of the program and ignores stale trailing bytes', () => {
    const lines = parseMtxBasic(memoryWithProgram(PROGRAM));
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toEqual({ lineNumber: 60, text: 'PRINT 42' });
  });

  it('returns an empty listing when there is no program (link word is zero)', () => {
    expect(parseMtxBasic(new Uint8Array(0x10000))).toEqual([]);
  });

  it('spaces word operators (AND) but keeps ordinary functions inline', () => {
    // 10 IF A AND INT(B) ...  →  IF(0x99) A(0x41) AND(0xDA) INT(0xE2) (0x28 B 0x29)
    const bytes = [
      0x0C, 0x00, 0x0A, 0x00, 0x99, 0x41, 0xDA, 0xE2, 0x28, 0x42, 0x29, 0xFF,
    ];
    const [line] = parseMtxBasic(memoryWithProgram(bytes));
    expect(line.text).toBe('IF A AND INT(B)');
  });
});
