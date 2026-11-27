/**
 * Z80DebugService.cpuStateText — the "Copy CPU state" clipboard block.
 *
 * The disassembler tags operand types with marker bytes (\x01 value, \x02
 * address, \x03 port) so the pane can colour them. The 6502 block copied them
 * already stripped; the Z80 one pasted raw, so a copied mnemonic carried
 * invisible control characters into whatever document it was pasted into.
 *
 * These tests check the block is plain printable text with its columns still
 * lined up, and that it disassembles from the PC as usual.
 */

import { describe, it, expect } from 'vitest';
import { Z80DebugService, type Z80DebugTarget } from '@/debug/z80/service.ts';
import { Z80 } from '@/cores/z80/core.ts';

function make(program: number[] = [], at = 0x8000): { dbg: Z80DebugService; cpu: Z80 } {
  const cpu = new Z80();
  const memory = new Uint8Array(0x10000);
  memory.set(program, at);
  cpu.pc = at;
  const target = {
    cpu,
    memory: {
      readByte: (addr: number) => memory[addr & 0xFFFF],
      snapshot: () => memory,
    },
  } as unknown as Z80DebugTarget;
  return { dbg: new Z80DebugService(target), cpu };
}

/** Characters a plain-text clipboard block may contain: printable ASCII + CR/LF. */
const PRINTABLE = /^[\x20-\x7E\r\n]*$/;

describe('Z80DebugService.cpuStateText', () => {
  it('is plain text with no disassembler marker bytes', () => {
    // LD A,n   3E 12   — the operand is tagged as a numeric value (\x01)
    // LD HL,nn 21 34 12 — tagged value
    // OUT (n),A D3 03  — the port is tagged (\x03)
    const { dbg } = make([0x3E, 0x12, 0x21, 0x34, 0x12, 0xD3, 0x03]);
    const text = dbg.cpuStateText();
    expect(text).toMatch(PRINTABLE);
    expect(text).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  });

  it('still shows the operands that were tagged', () => {
    const { dbg } = make([0x3E, 0x12, 0x21, 0x34, 0x12, 0xD3, 0x03]);
    const text = dbg.cpuStateText();
    expect(text).toContain('LD A,12');
    expect(text).toContain('LD HL,1234');
    expect(text).toContain('OUT (03),A');
  });

  it('disassembles 16 rows from PC and marks the current instruction', () => {
    const { dbg, cpu } = make([0x00, 0x00, 0x00, 0x00], 0x8000);
    cpu.pc = 0x8002;
    const lines = dbg.cpuStateText().split('\n');
    const start = lines.indexOf('Disassembly:') + 1;
    const rows = lines.slice(start);
    expect(rows).toHaveLength(16);
    expect(rows[0]).toMatch(/^> 8002 {2}00/);
    expect(rows[1]).toMatch(/^ {2}8003/);
    // Only the PC row carries the marker.
    expect(rows.filter(row => row.startsWith('>'))).toHaveLength(1);
  });

  it('carries the register block and the flags in the order the pane shows', () => {
    const { dbg, cpu } = make();
    cpu.af = 0x12FF;
    const text = dbg.cpuStateText();
    expect(text).toContain('AF  12FF');
    expect(text).toContain('Flags: Sign=1  Zero=1  Half=1  P/V=1  Sub=1  Carry=1');
    expect(text.indexOf('AF  ')).toBeLessThan(text.indexOf('Disassembly:'));
  });
});
