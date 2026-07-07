/**
 * mcp/format.ts — address argument parsing.
 *
 * parseAddr feeds every MCP tool that takes an address (read/write_memory,
 * breakpoints, traps, set_register, port I/O). It must never return NaN:
 * NaN & 0xFFFF is 0, so a typo'd symbol or bad hex would silently read or
 * WRITE address 0x0000 instead of erroring.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { parseAddr } from '../../mcp/format.ts';
import { symbols } from '../../mcp/state.ts';

afterEach(() => symbols.clear());

describe('parseAddr — accepted forms', () => {
  it('parses 0x-prefixed hex', () => {
    expect(parseAddr('0x1F')).toBe(0x1F);
    expect(parseAddr('0X8000')).toBe(0x8000);
  });

  it('parses $-prefixed hex', () => {
    expect(parseAddr('$FF')).toBe(0xFF);
  });

  it('parses bare hex (this is a Z80 debugger — digits are hex, not decimal)', () => {
    expect(parseAddr('4000')).toBe(0x4000);
    expect(parseAddr('38')).toBe(0x38);
  });

  it('resolves loaded symbols by name', () => {
    // sjasmplus .lst line: <line> <addr> name:
    symbols.loadLst('1 8000 start:', 'test.lst');
    expect(parseAddr('start')).toBe(0x8000);
  });

  it('identifier-shaped tokens that are valid hex fall back to hex when no symbol matches', () => {
    expect(parseAddr('face')).toBe(0xFACE);
  });

  it('an explicit 0x prefix wins over a same-named symbol', () => {
    symbols.loadLst('1 1234 face:', 'test.lst');
    expect(parseAddr('face')).toBe(0x1234);
    expect(parseAddr('0xface')).toBe(0xFACE);
  });
});

describe('parseAddr — invalid input must throw, never return NaN', () => {
  it('throws on an unresolved symbol that is not valid hex', () => {
    expect(() => parseAddr('loop_lable')).toThrow(/loop_lable/);
  });

  it('throws on non-hex garbage', () => {
    expect(() => parseAddr('GG')).toThrow();
  });

  it('throws on a bad explicit-hex prefix', () => {
    expect(() => parseAddr('0xZZ')).toThrow();
    expect(() => parseAddr('$')).toThrow();
  });

  it('throws on an empty string', () => {
    expect(() => parseAddr('')).toThrow();
    expect(() => parseAddr('   ')).toThrow();
  });
});
