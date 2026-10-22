/**
 * Currah µSpeech — paging latch, memory-mapped SP0256 interface and sample clock.
 *
 * Documented behaviour (Currah µSpeech ROM disassembly + the unit's address decode):
 *   • an opcode fetch at 0x0038 toggles the unit's 2 KB ROM in and out of
 *     0x0000-0x3FFF; the flip lands after that fetch;
 *   • 0x0000-0x07FF is the ROM, mirrored at 0x0800-0x0FFF;
 *   • 0x1000 reads with bit 0 set while the SP0256 is busy (LRQ deasserted) and
 *     takes an allophone number (bits 0-5) on writes;
 *   • 0x3000 / 0x3001 select the low / high pitch.
 */

import { describe, it, expect } from 'vitest';
import { CurrahUSpeech, USPEECH_TOGGLE_ADDR } from '@/machines/spectrum/peripherals/currah-uspeech.ts';
import { SpectrumMemory } from '@/machines/spectrum/memory.ts';

/** A 2 KB µSpeech ROM whose byte at offset n is (n & 0xFF) ^ 0x5A, so mirrors are visible. */
function patternRom(): Uint8Array {
  return Uint8Array.from({ length: 2048 }, (_, n) => (n & 0xFF) ^ 0x5A);
}

function setup(): { u: CurrahUSpeech; mem: SpectrumMemory } {
  const mem = new SpectrumMemory('zx48k');
  const sysRom = new Uint8Array(16384).fill(0xC3);
  mem.loadROM(sysRom);
  const u = new CurrahUSpeech();
  u.enabled = true;
  u.loadROM(patternRom());
  return { u, mem };
}

describe('currah µSpeech — paging latch', () => {
  it('toggles only on a fetch at 0x0038, and only when fitted with its ROM', () => {
    const { u } = setup();
    expect(USPEECH_TOGGLE_ADDR).toBe(0x0038);
    expect(u.togglesAt(0x0038)).toBe(true);
    expect(u.togglesAt(0x0037)).toBe(false);
    expect(u.togglesAt(0x0039)).toBe(false);
    expect(u.togglesAt(0x0066)).toBe(false);
    u.enabled = false;
    expect(u.togglesAt(0x0038)).toBe(false);
    const bare = new CurrahUSpeech();
    bare.enabled = true;                       // no ROM image loaded
    expect(bare.togglesAt(0x0038)).toBe(false);
  });

  it('maps its ROM at 0x0000 and mirrors it at 0x0800', () => {
    const { u, mem } = setup();
    u.toggle(mem, false);
    expect(u.pagedIn).toBe(true);
    const rom = patternRom();
    expect(Array.from(mem.flat.subarray(0, 2048))).toEqual(Array.from(rom));
    expect(Array.from(mem.flat.subarray(0x0800, 0x1000))).toEqual(Array.from(rom));
  });

  it('takes the whole of 0x2000-0x3FFF as unmapped (floating high), not the Spectrum ROM', () => {
    const { u, mem } = setup();
    u.toggle(mem, false);
    expect(mem.flat.subarray(0x2000, 0x4000).every((b) => b === 0xFF)).toBe(true);
  });

  it('toggles back out and restores the Spectrum ROM', () => {
    const { u, mem } = setup();
    u.toggle(mem, false);
    u.toggle(mem, true);                       // slot 0 is "owned" by us, so this must still page out
    expect(u.pagedIn).toBe(false);
    expect(mem.flat[0x0000]).toBe(0xC3);
    expect(mem.flat[0x3FFF]).toBe(0xC3);
  });

  it('ignores the toggle while another interface owns slot 0', () => {
    const { u, mem } = setup();
    u.toggle(mem, true);
    expect(u.pagedIn).toBe(false);
    expect(mem.flat[0]).toBe(0xC3);
  });

  it('a hardware reset drops it out', () => {
    const { u, mem } = setup();
    u.toggle(mem, false);
    u.reset(mem);
    expect(u.pagedIn).toBe(false);
    expect(mem.flat[0]).toBe(0xC3);
  });
});

describe('currah µSpeech — SP0256 interface at 0x1000', () => {
  /** Chip program: every command plays one short silent frame, then halts. */
  function withChip(): { u: CurrahUSpeech; mem: SpectrumMemory } {
    const s = setup();
    // 64 JMP vectors to 0x1100, where a PAUSE (repeat 1) and an RTS sit.
    const rom = new Uint8Array(2048);
    for (let cmd = 0; cmd < 64; cmd++) { rom[cmd * 2] = 0xE8; rom[cmd * 2 + 1] = 0x00; } // JMP 0x1100 (op 0xE, page nibble 1 bit-reversed = 8)
    rom[0x100] = 0xF1;  // PAUSE (op 0xF), repeat 1
    rom[0x101] = 0x00;  // RTS
    s.u.chip.loadRaw(rom);
    return s;
  }

  it('reads bit 0 clear while the chip is ready, across the whole 0x1000-0x1FFF page', () => {
    const { u, mem } = withChip();
    u.toggle(mem, false);
    expect(mem.flat[0x1000] & 1).toBe(0);
    expect(mem.flat[0x1FFF] & 1).toBe(0);
  });

  it('sets bit 0 as soon as a command is written, and clears it once the chip has taken it', () => {
    const { u, mem } = withChip();
    u.toggle(mem, false);
    u.write(0x1000, 0x05, mem);
    expect(mem.flat[0x1000] & 1).toBe(1);
    expect(mem.flat[0x1ABC] & 1).toBe(1);
    // One chip sample is 312 chip clocks ~ 350 T-states at 3.5 MHz.
    u.advance(400, mem);
    expect(mem.flat[0x1000] & 1).toBe(0);
  });

  it('keeps only bits 0-5 of the command (bit 6 is the pitch flag, bit 7 unused)', () => {
    const { u, mem } = withChip();
    u.toggle(mem, false);
    u.write(0x1000, 0xC5, mem);
    expect(u.lastCommand).toBe(0x05);
  });

  it('drops a write that arrives while the chip is still busy', () => {
    const { u, mem } = withChip();
    u.toggle(mem, false);
    u.write(0x1000, 0x05, mem);
    u.write(0x1000, 0x09, mem);
    expect(u.lastCommand).toBe(0x05);
    expect(u.accepted).toBe(1);
  });

  it('does not let writes disturb the ROM or the unmapped area', () => {
    const { u, mem } = withChip();
    u.toggle(mem, false);
    const rom = patternRom();
    u.write(0x0100, 0xEE, mem);
    u.write(0x0900, 0xEE, mem);
    u.write(0x2000, 0xEE, mem);
    expect(mem.flat[0x0100]).toBe(rom[0x100]);
    expect(mem.flat[0x0900]).toBe(rom[0x100]);
    expect(mem.flat[0x2000]).toBe(0xFF);
    expect(u.accepted).toBe(0);
  });

  it('latches the pitch from the low bit of the address written at 0x3000', () => {
    const { u, mem } = withChip();
    u.toggle(mem, false);
    expect(u.highPitch).toBe(false);
    u.write(0x3001, 0x40, mem);
    expect(u.highPitch).toBe(true);
    u.write(0x3000, 0x00, mem);
    expect(u.highPitch).toBe(false);
    u.write(0x3002, 0x00, mem);      // not a pitch address
    u.write(0x3001, 0x00, mem);
    u.write(0x3002, 0x00, mem);
    expect(u.highPitch).toBe(true);
  });
});

describe('currah µSpeech — output', () => {
  it('is silent while idle', () => {
    const { u, mem } = setup();
    u.configure(3_500_000, 44100);
    for (let i = 0; i < 100; i++) { u.advance(80, mem); expect(u.generateSampleMono()).toBe(0); }
  });
});
