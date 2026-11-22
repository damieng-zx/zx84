import { describe, expect, it } from 'vitest';
import { parseZx8xBasicProgram, parseZx8xBasicVariables } from '@/machines/zx8x/basic.ts';
import { Zx8xScreenText } from '@/machines/zx8x/screen-text.ts';

function write16(mem: Uint8Array, address: number, value: number): void {
  mem[address] = value & 0xff;
  mem[address + 1] = value >> 8;
}

describe('ZX80/ZX81 BASIC viewers', () => {
  it('detokenizes a ZX80 line and reads an integer variable', () => {
    const mem = new Uint8Array(0x10000);
    const line = [0x00, 0x0a, 0xf4, 0x01, 0x2d, 0x2e, 0x01, 0x76]; // 10 PRINT "HI"
    mem.set(line, 0x4028);
    write16(mem, 0x4008, 0x4030);
    write16(mem, 0x400a, 0x4034);
    mem.set([0x66, 42, 0, 0x80], 0x4030); // A=42, end marker

    expect(parseZx8xBasicProgram(mem, 'zx80')).toEqual([{ lineNumber: 10, text: 'PRINT "HI"' }]);
    expect(parseZx8xBasicVariables(mem, 'zx80')).toEqual([{ name: 'A', kind: 'number', value: '42' }]);
  });

  it('detokenizes a ZX81 line and reads a floating-point-format integer variable', () => {
    const mem = new Uint8Array(0x10000);
    const body = [0xf5, 0x0b, 0x2d, 0x2e, 0x0b, 0x76]; // PRINT "HI"
    mem.set([0x00, 0x14, body.length, 0, ...body], 0x407d);
    write16(mem, 0x400c, 0x4087);
    write16(mem, 0x4010, 0x4200);
    write16(mem, 0x4014, 0x4207);
    mem.set([0x66, 0, 0, 99, 0, 0, 0x80], 0x4200); // A=99, end marker

    expect(parseZx8xBasicProgram(mem, 'zx81')).toEqual([{ lineNumber: 20, text: 'PRINT "HI"' }]);
    expect(parseZx8xBasicVariables(mem, 'zx81')).toEqual([{ name: 'A', kind: 'number', value: '99' }]);
  });
});

describe.each(['ts1000', 'ts1500'] as const)('%s runs the ZX81 viewers', (model) => {
  it('detokenizes a program line and reads a number variable as the ZX81 does', () => {
    const mem = new Uint8Array(0x10000);
    const body = [0xf5, 0x0b, 0x2d, 0x2e, 0x0b, 0x76]; // PRINT "HI"
    mem.set([0x00, 0x14, body.length, 0, ...body], 0x407d);
    write16(mem, 0x400c, 0x4087);
    write16(mem, 0x4010, 0x4200);
    write16(mem, 0x4014, 0x4207);
    mem.set([0x66, 0, 0, 99, 0, 0, 0x80], 0x4200); // A=99, end marker

    expect(parseZx8xBasicProgram(mem, model)).toEqual([{ lineNumber: 20, text: 'PRINT "HI"' }]);
    expect(parseZx8xBasicVariables(mem, model)).toEqual([{ name: 'A', kind: 'number', value: '99' }]);
  });

  it('reads the ZX81 display file as 32x24 text and not the ZX80 character set', () => {
    const mem = new Uint8Array(0x10000);
    write16(mem, 0x400c, 0x4200);
    mem.set([0x76, 0x2d, 0x2e, 0x76, 0x76], 0x4200);
    const screenText = new Zx8xScreenText();
    expect(screenText.ocr(mem, model)).toBe('HI');
    expect(screenText.ocrStyled(mem, model).mask.slice(0, 3)).toEqual([true, true, false]);
  });
});

describe('ZX80/ZX81 text viewer', () => {
  it('extracts the active 32x24 display file directly', () => {
    const mem = new Uint8Array(0x10000);
    write16(mem, 0x400c, 0x4200);
    mem.set([0x76, 0x2d, 0x2e, 0x76, 0x76], 0x4200);
    const screenText = new Zx8xScreenText();

    expect(screenText.ocr(mem, 'zx81')).toBe('HI');
    const styled = screenText.ocrStyled(mem, 'zx81');
    expect(styled.grid).toBe('32x24');
    expect(styled.mask.slice(0, 3)).toEqual([true, true, false]);
  });

  it('keeps rows in step when a row fills all 32 columns and its terminator follows', () => {
    // A 16K machine's display file is expanded: every row is its full width
    // followed by the 0x76 that ends it, and a full row's terminator must not
    // be read as the next (empty) row.
    const mem = new Uint8Array(0x10000);
    write16(mem, 0x400c, 0x4200);
    const full = new Array<number>(32).fill(0x26);              // 32 x 'A'
    mem.set([0x76, ...full, 0x76, 0x2d, 0x2e, 0x76, 0x76], 0x4200);
    const screenText = new Zx8xScreenText();

    expect(screenText.ocr(mem, 'zx81')).toBe(`${'A'.repeat(32)}
HI`);
    expect(screenText.ocr(mem, 'ts1500')).toBe(`${'A'.repeat(32)}
HI`);
  });
});
