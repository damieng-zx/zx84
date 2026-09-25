import { describe, expect, it } from 'vitest';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';

/** Build an 8K ROM image with `code` at 0x0000 and a HALT at the IM 1 vector. */
function romWith(code: number[]): Uint8Array {
  const rom = new Uint8Array(0x2000);
  rom.set(code, 0);
  rom[0x38] = 0x76;
  return rom;
}

describe('ZX81 A6-driven maskable interrupt', () => {
  it('fires when the refresh address has bit 6 clear, not as soon as the display row HALTs', () => {
    // The ROM's display driver loads R so that the scanline INT arrives a
    // fixed time after the row starts, however few characters it contains.
    // A collapsed (empty) row HALTs immediately and must idle until then.
    const machine = new Zx8xMachine('zx81');
    machine.loadROM(romWith([
      0xed, 0x56,       // IM 1                  8T
      0x21, 0x00, 0xc1, // LD HL,$C100 (echo)   10T
      0x3e, 0x5d,       // LD A,$5D              7T
      0xed, 0x4f,       // LD R,A                9T  (R = $5D afterwards)
      0xfb,             // EI                    4T  refresh $5D
      0xe9,             // JP (HL)               4T  refresh $5E
    ]));
    machine.memory.writeByte(0x4100, 0x76); // HALT row terminator, refresh $5F
    machine.breakpoints.add(0x0038);
    machine.tick();

    expect(machine.breakpointHit).toBe(0x0038);
    // HALT then idles through refreshes $60..$7F (32) and $00 (1): 33 x 4T.
    // /INT is sampled after the $00 refresh; IM 1 acknowledge takes 13T.
    // 8+10+7+9+4+4+4 + 33*4 + 13 = 191.
    expect(machine.cpu.tStates).toBe(191);
  });

  it('samples /INT after any instruction, not only while HALTed', () => {
    // A6 is low whenever the refresh address has bit 6 clear; the Z80 takes
    // the level at the end of whatever instruction is executing.
    const machine = new Zx8xMachine('zx81');
    machine.loadROM(romWith([
      0xed, 0x56,       // IM 1        8T
      0x3e, 0x7d,       // LD A,$7D    7T
      0xed, 0x4f,       // LD R,A      9T
      0xfb,             // EI          4T  refresh $7D
      0x00,             // NOP         4T  refresh $7E
      0x00,             // NOP         4T  refresh $7F
      0x00,             // NOP         4T  refresh $00 -> /INT low
      0x00, 0x00, 0x00,
    ]));
    machine.breakpoints.add(0x0038);
    machine.tick();
    expect(machine.breakpointHit).toBe(0x0038);
    // 8+7+9+4 + 3*4 + 13 (IM 1 acknowledge) = 53.
    expect(machine.cpu.tStates).toBe(53);
  });
});
