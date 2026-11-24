/**
 * The VIC-II's sprite interrupt sources.
 *
 * Expectations come from Christian Bauer's "The MOS 6567/6569 video controller
 * (VIC-II)" (the interrupt table in section 3.2, 3.8.2 "Priority and collision
 * detection" and 3.9 "The border unit"):
 *
 *  - $D019/$D01A bit 1 is the sprite-graphics collision (MBC — "collision of at
 *    least one sprite with the text/bitmap graphics"), bit 2 the sprite-sprite
 *    one (MMC — "collision of two or more sprites"). That is the reverse of the
 *    collision registers' own order, where $D01E is sprite-sprite and $D01F
 *    sprite-graphics.
 *  - A sprite-sprite collision is detected wherever two sprite data sequencers
 *    output a non-transparent pixel, "this can also happen somewhere outside of
 *    the visible screen area", so the display being off or in the border makes
 *    no difference.
 *  - A sprite-graphics collision needs a foreground pixel from the graphics data
 *    sequencer, and the vertical border flip-flop turns that sequencer's output
 *    off: "This was probably done to prevent sprite-graphics collisions in the
 *    border area." With DEN cleared the flip-flop is never reset, so a blanked
 *    display has no sprite-graphics collisions at all.
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';

/** Bits of $D019/$D01A, from the interrupt table. */
const IRQ_SPRITE_GRAPHICS = 0x02;    // MBC
const IRQ_SPRITE_SPRITE = 0x04;      // MMC

/** A machine that never runs any code: the CPU spins in RAM, the VIC runs. */
function idleMachine(): C64Machine {
  const m = new C64Machine('c64', null);
  m.reset();
  m.memory.ram.set([0x4C, 0x00, 0xC0], 0xC000);      // JMP $C000
  m.cpu.pc = 0xC000;
  for (const n of [0, 1]) {
    // Sprite data $3000/$3040: every pixel opaque.
    m.memory.ram.fill(0xFF, 0x3000 + n * 0x40, 0x3000 + n * 0x40 + 0x3F);
    m.memory.ram[0x07F8 + n] = 0xC0 + n;
  }
  return m;
}

/** Text mode, character 0 a solid block ($2000 in the bank, so no ROM needed). */
function solidScreen(m: C64Machine): void {
  m.memory.ram.fill(0xFF, 0x2000, 0x2100);
  m.memory.writeByte(0xD018, 0x18);                  // screen $0400, characters $2000
}

/** Ten frames, then the interrupt flags as $D019 shows them (without its 1-bits). */
function flagsAfterFrames(m: C64Machine, frames = 10): number {
  for (let f = 0; f < frames; f++) m.tick();
  return (m.vic.peek(0xD019) & 0x0F);
}

describe('VIC-II sprite interrupts', () => {
  it('uses bit 1 for sprite-graphics and bit 2 for sprite-sprite', () => {
    // Two opaque sprites exactly on top of each other, over a blank background.
    const ss = idleMachine();
    ss.memory.writeByte(0xD011, 0x0B);                // display off: no graphics foreground
    ss.memory.writeByte(0xD000, 100); ss.memory.writeByte(0xD001, 100);
    ss.memory.writeByte(0xD002, 100); ss.memory.writeByte(0xD003, 100);
    ss.memory.writeByte(0xD015, 0x03);                // sprites 0 and 1
    expect(flagsAfterFrames(ss) & IRQ_SPRITE_SPRITE, 'sprite-sprite on bit 2').toBe(IRQ_SPRITE_SPRITE);
    expect(flagsAfterFrames(ss) & IRQ_SPRITE_GRAPHICS, 'nothing for sprite-graphics').toBe(0);

    // One opaque sprite over a solid character, the display on.
    const sb = idleMachine();
    solidScreen(sb);
    sb.memory.writeByte(0xD011, 0x1B);                // display on, 25 rows, YSCROLL 3
    sb.memory.writeByte(0xD000, 100); sb.memory.writeByte(0xD001, 100);
    sb.memory.writeByte(0xD015, 0x01);
    expect(flagsAfterFrames(sb) & IRQ_SPRITE_GRAPHICS, 'sprite-graphics on bit 1').toBe(IRQ_SPRITE_GRAPHICS);
    expect(flagsAfterFrames(sb) & IRQ_SPRITE_SPRITE, 'a single sprite cannot collide with itself').toBe(0);
  });

  it('enables each source by its own $D01A bit', () => {
    // A sprite-sprite collision with only the sprite-graphics interrupt enabled
    // must stay silent, and the other way round. This is what the two bits are
    // for; swapping them turns one into the other.
    const ss = idleMachine();
    ss.memory.writeByte(0xD011, 0x0B);
    ss.memory.writeByte(0xD000, 100); ss.memory.writeByte(0xD001, 100);
    ss.memory.writeByte(0xD002, 100); ss.memory.writeByte(0xD003, 100);
    ss.memory.writeByte(0xD015, 0x03);
    ss.memory.writeByte(0xD01A, IRQ_SPRITE_GRAPHICS);
    flagsAfterFrames(ss);
    expect(ss.vic.irq, 'bit 1 does not listen to a sprite-sprite collision').toBe(false);
    ss.memory.writeByte(0xD01A, IRQ_SPRITE_SPRITE);
    flagsAfterFrames(ss);
    expect(ss.vic.irq, 'bit 2 does').toBe(true);

    const sb = idleMachine();
    solidScreen(sb);
    sb.memory.writeByte(0xD011, 0x1B);
    sb.memory.writeByte(0xD000, 100); sb.memory.writeByte(0xD001, 100);
    sb.memory.writeByte(0xD015, 0x01);
    sb.memory.writeByte(0xD01A, IRQ_SPRITE_SPRITE);
    flagsAfterFrames(sb);
    expect(sb.vic.irq, 'bit 2 does not listen to a sprite-graphics collision').toBe(false);
    sb.memory.writeByte(0xD01A, IRQ_SPRITE_GRAPHICS);
    flagsAfterFrames(sb);
    expect(sb.vic.irq, 'bit 1 does').toBe(true);
  });

  it('still sees sprite-sprite collisions outside the display window', () => {
    // Sprite Y coordinates 5 and 9: the overlap lies in the upper border.
    const m = idleMachine();
    m.memory.writeByte(0xD011, 0x1B);
    m.memory.writeByte(0xD000, 100); m.memory.writeByte(0xD001, 5);
    m.memory.writeByte(0xD002, 100); m.memory.writeByte(0xD003, 9);
    m.memory.writeByte(0xD015, 0x03);
    expect(flagsAfterFrames(m) & IRQ_SPRITE_SPRITE, 'a border collision counts').toBe(IRQ_SPRITE_SPRITE);
  });

  it('reports no sprite-graphics collision in the border, where the sequencer output is blanked', () => {
    // The vertical border flip-flop is set in the upper border, so the graphics
    // sequencer suppresses its output there even though the display is on.
    const m = idleMachine();
    solidScreen(m);
    m.memory.writeByte(0xD011, 0x1B);                 // 25 rows: the display window starts at line 51
    m.memory.writeByte(0xD000, 100); m.memory.writeByte(0xD001, 5);   // drawn on lines 6-26
    m.memory.writeByte(0xD015, 0x01);
    expect(flagsAfterFrames(m) & IRQ_SPRITE_GRAPHICS, 'no collision in the upper border').toBe(0);
  });

  it('reports no sprite-graphics collision while the display is off (DEN=0)', () => {
    const m = idleMachine();
    solidScreen(m);
    // The idle byte the VIC fetches with no display: if it were used as
    // foreground this sprite would collide with all its set bits.
    m.memory.ram[0x3FFF] = 0xFF;
    m.memory.writeByte(0xD011, 0x0B);                 // DEN cleared
    m.memory.writeByte(0xD000, 100); m.memory.writeByte(0xD001, 100);
    m.memory.writeByte(0xD015, 0x01);
    expect(flagsAfterFrames(m) & IRQ_SPRITE_GRAPHICS, 'a blanked display has no graphics foreground').toBe(0);
  });
});
