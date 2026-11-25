/**
 * The Plus/4's cartridge, media routing and TEXT overlay, plus its tape format.
 *
 * Expectations come from the hardware: the `$FDD0` bank select, the cartridge
 * port's two 16K banks, the .tap header's platform byte (2 = the C16/Plus/4)
 * and what BASIC 3.5 puts on the screen.
 */

import { describe, it, expect } from 'vitest';
import { Plus4Machine } from '@/machines/plus4/plus4-machine.ts';
import { parsePlus4Cartridge } from '@/machines/plus4/cartridge.ts';
import { plus4Entry } from '@/machines/plus4/descriptor.ts';
import { tapClock, tapFormat } from '@/media/tape/c64-tap.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

function bareMachine(): Plus4Machine {
  const m = new Plus4Machine('plus4', null, false);
  m.reset();
  return m;
}

/** A VICE .crt whose two chips are `low` and `high`. */
function crt(low: Uint8Array, high: Uint8Array): Uint8Array {
  const header = 0x40;
  const chipLen = 0x10 + 0x4000;
  const out = new Uint8Array(header + chipLen * 2);
  const be32 = (at: number, v: number): void => {
    out[at] = (v >>> 24) & 0xFF; out[at + 1] = (v >>> 16) & 0xFF; out[at + 2] = (v >>> 8) & 0xFF; out[at + 3] = v & 0xFF;
  };
  const be16 = (at: number, v: number): void => { out[at] = (v >> 8) & 0xFF; out[at + 1] = v & 0xFF; };
  out.set(new Uint8Array([...'C64 CARTRIDGE '].map(c => c.charCodeAt(0))), 0);
  be32(0x10, header);       // header length
  be16(0x16, 0);            // hardware type: a plain ROM cartridge
  const chip = (at: number, bank: number, addr: number, rom: Uint8Array): void => {
    out.set(new Uint8Array([...'CHIP'].map(c => c.charCodeAt(0))), at);
    be32(at + 4, chipLen);
    be16(at + 8, bank);
    be16(at + 0x0C, addr);
    be16(at + 0x0E, rom.length);
    out.set(rom, at + 0x10);
  };
  chip(header, 0, 0x8000, low);
  chip(header + chipLen, 1, 0xC000, high);
  return out;
}

describe('Plus/4 cartridges', () => {
  it('parses a .crt into the two banks, and the bank select reaches them', () => {
    const low = new Uint8Array(0x4000).fill(0x11);
    const high = new Uint8Array(0x4000).fill(0x22);
    const parsed = parsePlus4Cartridge(crt(low, high), 'game.crt');
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.cart.low?.[0]).toBe(0x11);
    expect(parsed.cart.high?.[0]).toBe(0x22);

    const m = bareMachine();
    m.setCartridge(parsed.cart);
    // $FDDA: low = cartridge, high = cartridge.
    m.memory.setBank(10);
    expect(m.memory.readByte(0x8000)).toBe(0x11);
    expect(m.memory.readByte(0xC000)).toBe(0x22);
    // With the ROMs banked out the cartridge is gone with them.
    m.memory.setRomVisible(false);
    expect(m.memory.readByte(0x8000)).not.toBe(0x11);
  });

  it('takes a raw image from $8000 up, padded to two banks', () => {
    const image = new Uint8Array(0x4000).fill(0x33);
    const parsed = parsePlus4Cartridge(image, 'rom.bin');
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.cart.low?.[0x3FFF]).toBe(0x33);
    expect(parsed.cart.high?.[0], 'the second bank is empty').toBe(0xFF);

    const m = bareMachine();
    m.setCartridge(parsed.cart);
    m.memory.setBank(10);
    expect(m.memory.readByte(0xBFFF)).toBe(0x33);
  });

  it('refuses a ROM of the wrong size, and one whose chips do not fit', () => {
    const tooBig = parsePlus4Cartridge(new Uint8Array(0x10000), 'big.bin');
    expect('error' in tooBig).toBe(true);
    const short = parsePlus4Cartridge(new Uint8Array(0x1000), 'short.bin');
    expect('short' in short, 'a 4K image is taken and padded').toBe(false);
  });

  it('accepts .crt and .bin in the media service', () => {
    const m = bareMachine();
    const exts = m.services.media.accepts().map(t => t.ext);
    expect(exts).toContain('.crt');
    expect(exts).toContain('.bin');
  });
});

describe('Plus/4 media', () => {
  it('routes the Commodore tape and disk formats', () => {
    const exts = bareMachine().services.media.accepts().map(t => t.ext);
    for (const ext of ['.tap', '.prg', '.t64', '.d64', '.g64', '.d71', '.d81', '.plus4state']) {
      expect(exts, ext).toContain(ext);
    }
  });

  it('writes a .tap that says it is a Plus/4 tape (platform 2)', () => {
    // The .tap header's platform byte: 2 is the C16/Plus/4, whose pulses count
    // that machine's clock.
    expect(tapClock(2, 0), 'PAL').toBe(1_773_447);
    expect(tapClock(2, 1), 'NTSC').toBe(1_789_772);
    const fmt = tapFormat(2, 0);
    expect(fmt.platform).toBe(2);
  });
});

// ── OCR, on the real ROM's banner ──────────────────────────────────────

const REAL = 'plus4-dev/';
const kernal = romImage(REAL + 'kernal');
const basic = romImage(REAL + 'basic');

describe.skipIf(!kernal || !basic)('Plus/4 TEXT overlay with the Commodore ROMs', () => {
  function boot(): Plus4Machine {
    const m = new Plus4Machine('plus4', null, false);
    const image = new Uint8Array(kernal!.length + basic!.length);
    image.set(kernal!, 0);
    image.set(basic!, kernal!.length);
    m.loadROM(image);
    m.reset();
    for (let f = 0; f < 400; f++) m.tick();
    return m;
  }

  it('reads the banner and the READY prompt off the character screen', () => {
    const m = boot();
    const grid = m.ocrScreenStyled();
    expect(grid.text).toContain('COMMODORE BASIC V3.5');
    expect(grid.text).toContain('READY.');
    // Every cell of the banner carries at least one matched glyph.
    expect(grid.mask.some(Boolean)).toBe(true);
    // The overlay's field is the 40 x 25 window inside the frame buffer.
    const field = m.textField;
    expect(field.width).toBe(320);
    expect(field.height).toBe(200);
  });

  it('the descriptor declares the frame the machine draws', () => {
    const d = plus4Entry.descriptor('plus4');
    const m = boot();
    expect(m.frameWidth).toBe(d.screen.width);
    expect(m.frameHeight).toBe(d.screen.height);
    expect(d.screen.activeWidth).toBe(320);
    expect(d.screen.activeHeight).toBe(200);
  });
});
