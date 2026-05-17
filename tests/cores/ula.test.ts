/**
 * ULA tests based on documented external behaviour of the Sinclair 48K ULA
 * (Ferranti 5C-102/112). References:
 *  - Sinclair ZX Spectrum Service Manual
 *  - "World of Spectrum" Faqwiki: https://sinclair.wiki.zxnet.co.uk/wiki/ULA
 *  - Chris Smith, "The ZX Spectrum ULA" (2010)
 *
 * Tests assert documented behaviour first; comments mark any places where the
 * current implementation deliberately deviates (e.g. Issue 2 vs Issue 3 input
 * stage, MIC bit handling). Those tests use `.skip` or document the divergence.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ULA, vramBitmapAddr, vramAttrAddr, PALETTES } from '@/cores/ula.ts';
import { SpectrumKeyboard } from '@/keyboard.ts';

// ─────────────────────────────────────────────────────────────────────────
// VRAM address arithmetic — documented Spectrum interleave
// ─────────────────────────────────────────────────────────────────────────

describe('vramBitmapAddr — documented Spectrum screen interleave', () => {
  it('y=0 → 0x4000 (first scanline of top third)', () => {
    expect(vramBitmapAddr(0)).toBe(0x4000);
  });

  it('y=1 → 0x4100 (one pixel down within the same char row)', () => {
    expect(vramBitmapAddr(1)).toBe(0x4100);
  });

  it('y=7 → 0x4700 (last pixel of first char row)', () => {
    expect(vramBitmapAddr(7)).toBe(0x4700);
  });

  it('y=8 → 0x4020 (top of second char row of top third)', () => {
    expect(vramBitmapAddr(8)).toBe(0x4020);
  });

  it('y=63 → 0x47E0 (last scanline of top third)', () => {
    expect(vramBitmapAddr(63)).toBe(0x47E0);
  });

  it('y=64 → 0x4800 (top of middle third)', () => {
    expect(vramBitmapAddr(64)).toBe(0x4800);
  });

  it('y=128 → 0x5000 (top of bottom third)', () => {
    expect(vramBitmapAddr(128)).toBe(0x5000);
  });

  it('y=191 → 0x57E0 (very last scanline)', () => {
    expect(vramBitmapAddr(191)).toBe(0x57E0);
  });

  it('every line maps inside 0x4000..0x57FF (the 6144-byte display file)', () => {
    for (let y = 0; y < 192; y++) {
      const a = vramBitmapAddr(y);
      expect(a).toBeGreaterThanOrEqual(0x4000);
      expect(a + 31).toBeLessThanOrEqual(0x57FF);
    }
  });

  it('all 192 line starts are distinct', () => {
    const set = new Set<number>();
    for (let y = 0; y < 192; y++) set.add(vramBitmapAddr(y));
    expect(set.size).toBe(192);
  });
});

describe('vramAttrAddr — 32×24 attribute file at 0x5800', () => {
  it('y=0  col=0  → 0x5800', () => {
    expect(vramAttrAddr(0, 0)).toBe(0x5800);
  });

  it('all 8 pixel rows of a single char row share the same attribute row', () => {
    for (let y = 0; y < 8; y++) expect(vramAttrAddr(y, 0)).toBe(0x5800);
  });

  it('char row 1 (y=8) starts at 0x5820', () => {
    expect(vramAttrAddr(8, 0)).toBe(0x5820);
  });

  it('column shifts add 1 per step', () => {
    expect(vramAttrAddr(0, 31)).toBe(0x581F);
  });

  it('last attribute byte (y=191, col=31) is 0x5AFF', () => {
    expect(vramAttrAddr(191, 31)).toBe(0x5AFF);
  });

  it('all attributes lie inside 0x5800..0x5AFF', () => {
    for (let y = 0; y < 192; y += 8) {
      for (let col = 0; col < 32; col++) {
        const a = vramAttrAddr(y, col);
        expect(a).toBeGreaterThanOrEqual(0x5800);
        expect(a).toBeLessThanOrEqual(0x5AFF);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function makeUla(): { ula: ULA; kbd: SpectrumKeyboard } {
  const kbd = new SpectrumKeyboard();
  const ula = new ULA(kbd);
  return { ula, kbd };
}

function pixel(ula: ULA, x: number, y: number): number {
  // Returns the ABGR uint32 at screen-pixel (x, y) including border offset.
  const buf = new Uint32Array(ula.pixels.buffer);
  return buf[y * ula.screenWidth + x];
}

function displayPixel(ula: ULA, dispX: number, dispY: number): number {
  // (dispX, dispY) are inside the 256×192 paper area — convert by adding border.
  return pixel(ula, dispX + 48, dispY + 48);
}

// ─────────────────────────────────────────────────────────────────────────
// Port 0xFE — write
// ─────────────────────────────────────────────────────────────────────────

describe('Port 0xFE — write (output latch)', () => {
  let ula: ULA;
  beforeEach(() => { ula = makeUla().ula; });

  it('bits 0-2 set the border colour (8 values)', () => {
    for (let v = 0; v < 8; v++) {
      ula.writePort(v);
      expect(ula.borderColor).toBe(v);
    }
  });

  it('higher bits do not corrupt the border colour', () => {
    ula.writePort(0b11111101); // border = 5
    expect(ula.borderColor).toBe(5);
  });

  it('bit 4 (EAR) drives the beeper output', () => {
    ula.writePort(0x00); expect(ula.beeperBit).toBe(0);
    ula.writePort(0x10); expect(ula.beeperBit).toBe(1);
  });

  it('writes are independent: setting EAR does not change border', () => {
    ula.writePort(0x03); // border 3
    ula.writePort(0x13); // border 3 + EAR
    expect(ula.borderColor).toBe(3);
    expect(ula.beeperBit).toBe(1);
  });

  // Documentation: Issue 3 boards (and 128K) — bit 3 is the MIC output (used for
  // tape SAVE). It does not affect the audible beeper but on an Issue 2 ULA it
  // is the value reflected back on bit 6 of the read port when no tape is
  // playing. The current implementation does not separately model MIC — see
  // the "Issue 2 vs Issue 3" suite below for the consequence.
  it('bit 3 (MIC) is accepted without throwing', () => {
    expect(() => ula.writePort(0x08)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Port 0xFE — read (keyboard + EAR)
// ─────────────────────────────────────────────────────────────────────────

describe('Port 0xFE — read (keyboard half-rows)', () => {
  let ula: ULA;
  let kbd: SpectrumKeyboard;
  beforeEach(() => { ({ ula, kbd } = makeUla()); });

  it('with no keys pressed and all rows selected, low 5 bits read 1', () => {
    const v = ula.readPort(0x00); // every address line low → all rows selected
    expect(v & 0x1F).toBe(0x1F);
  });

  it('with no rows selected (high byte 0xFF), low 5 bits are 1 anyway', () => {
    expect(ula.readPort(0xFF) & 0x1F).toBe(0x1F);
  });

  it('bit 5 is always 1 on a 48K/+ readback', () => {
    // Documented: bit 5 is "unused" and returns 1 (not connected on 48K).
    expect(ula.readPort(0x00) & 0x20).toBe(0x20);
  });

  it('bit 7 is always 1 on a 48K/+ readback (TV signal status, unused)', () => {
    expect(ula.readPort(0x00) & 0x80).toBe(0x80);
  });

  it('pressing CAPS SHIFT (row 0, bit 0) shows in port 0xFEFE only', () => {
    kbd.setKey(0, 0, true);
    expect(ula.readPort(0xFE) & 0x01).toBe(0); // row 0 selected → CS pressed
    expect(ula.readPort(0xFD) & 0x01).toBe(1); // row 1 selected → CS not visible
  });

  it('selecting multiple rows AND-combines their state (active-low)', () => {
    kbd.setKey(0, 0, true); // CS (row 0, bit 0)
    kbd.setKey(1, 2, true); // D  (row 1, bit 2)
    // Address with A8=0 AND A9=0 selects rows 0 & 1 → both bits 0 and 2 read 0
    const v = ula.readPort(0xFC);
    expect(v & 0x01).toBe(0);
    expect(v & 0x04).toBe(0);
    expect(v & 0x02).toBe(0x02); // nothing on row 0 bit 1
  });

  it('high byte 0x00 selects every row at once and exposes any pressed key', () => {
    kbd.setKey(7, 0, true); // SPACE — port 0x7FFE alone
    expect(ula.readPort(0x7F) & 0x01).toBe(0); // canonical select
    expect(ula.readPort(0x00) & 0x01).toBe(0); // all-rows select also sees it
  });

  it('keys on different rows can be distinguished via high-byte selection', () => {
    kbd.setKey(0, 1, true); // Z
    kbd.setKey(7, 4, true); // B
    expect(ula.readPort(0xFE) & 0x02).toBe(0);    // row 0: Z
    expect(ula.readPort(0xFE) & 0x10).toBe(0x10); // row 0: B isn't here
    expect(ula.readPort(0x7F) & 0x10).toBe(0);    // row 7: B
    expect(ula.readPort(0x7F) & 0x02).toBe(0x02); // row 7: Z isn't here
  });
});

describe('Port 0xFE — EAR input (bit 6)', () => {
  let ula: ULA;
  beforeEach(() => { ula = makeUla().ula; });

  it('with no tape and beeper bit 0, bit 6 reads 0 (Issue 3 behaviour)', () => {
    ula.writePort(0x00);
    expect(ula.readPort(0xFF) & 0x40).toBe(0);
  });

  it('writing EAR=1 (bit 4) feeds back on bit 6 — Issue 3 contract', () => {
    // Real Issue 3 ULA: with no tape signal, bit 6 = last bit-4 written.
    // (Issue 2 reflects bit 3 here instead — see Issue 2 test below.)
    ula.writePort(0x10);
    expect(ula.readPort(0xFF) & 0x40).toBe(0x40);
  });

  it('during tape playback, bit 6 reflects tapeEarBit instead of the beeper', () => {
    ula.writePort(0x10);          // beeper = 1
    ula.tapeActive = true;
    ula.tapeEarBit = 0;
    expect(ula.readPort(0xFF) & 0x40).toBe(0); // tape wins
    ula.tapeEarBit = 1;
    expect(ula.readPort(0xFF) & 0x40).toBe(0x40);
  });

  it('keyboard bits and EAR/unused bits coexist cleanly in one read', () => {
    ula.writePort(0x10); // EAR=1 → bit 6 should read 1
    const v = ula.readPort(0xFF); // no rows selected, no keys pressed
    // expected: 1110_1111  (bit 7=1, bit 6=1, bit 5=1, bits 0-4 all 1)
    expect(v).toBe(0xFF);
  });
});

// Documented gap: Issue 2 boards reflect MIC (bit 3) on bit 6 of the read port,
// not EAR. We don't model board-issue differences — bit 3 is silently ignored.
describe.skip('Port 0xFE — Issue 2 input stage (unmodelled)', () => {
  it('Issue 2: writing MIC=1 (bit 3) should feed back on bit 6 with no tape', () => {
    const { ula } = makeUla();
    ula.writePort(0x08); // MIC=1, EAR=0
    expect(ula.readPort(0xFF) & 0x40).toBe(0x40); // would fail on current Issue-3 model
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Reset
// ─────────────────────────────────────────────────────────────────────────

describe('reset()', () => {
  it('border latches power-on value 0 (black) on reset', () => {
    // Real hardware powers up with the border register at 0; the 48K ROM
    // writes 7 (white) during early init. Resetting to 0 keeps emulation
    // honest — the brief black flash before ROM init is genuine behaviour
    // and bugs where ROM init is bypassed should be visible.
    const { ula } = makeUla();
    ula.writePort(0x02); // dirty the latch
    ula.reset();
    expect(ula.borderColor).toBe(0);
  });

  it('clears beeper, tape, and flash state', () => {
    const { ula } = makeUla();
    ula.writePort(0x10);
    ula.tapeActive = true;
    ula.tapeEarBit = 1;
    ula.flashCounter = 9;
    ula.flashState = true;
    ula.reset();
    expect(ula.beeperBit).toBe(0);
    expect(ula.tapeActive).toBe(false);
    expect(ula.tapeEarBit).toBe(0);
    expect(ula.flashCounter).toBe(0);
    expect(ula.flashState).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FLASH — documented 16-frame period (32-frame full cycle at 50 Hz)
// ─────────────────────────────────────────────────────────────────────────

describe('FLASH attribute toggle', () => {
  it('flashState flips every 16 frames', () => {
    const { ula } = makeUla();
    expect(ula.flashState).toBe(false);
    for (let i = 0; i < 15; i++) ula.advanceFlash();
    expect(ula.flashState).toBe(false);
    ula.advanceFlash(); // 16th
    expect(ula.flashState).toBe(true);
    for (let i = 0; i < 16; i++) ula.advanceFlash();
    expect(ula.flashState).toBe(false);
  });

  it('the renderFrame path also advances flash', () => {
    const { ula } = makeUla();
    const mem = new Uint8Array(0x10000);
    for (let i = 0; i < 16; i++) ula.renderFrame(mem);
    expect(ula.flashState).toBe(true);
  });

  it('FLASH attribute bit 7 swaps ink/paper when flashState is true', () => {
    const { ula } = makeUla();
    const mem = new Uint8Array(0x10000);

    // Solid INK pixel at (0,0): set bitmap byte to 0x80, attr = 0x86
    //   = ink=6 (yellow), paper=0, no bright, no flash
    mem[vramBitmapAddr(0)] = 0x80;
    mem[vramAttrAddr(0, 0)] = 0x86;
    ula.renderFrame(mem);
    const noFlash = displayPixel(ula, 0, 0); // expect ink colour (yellow)

    // Now with flash bit set: attr = 0x86 | 0x80 = 0x06? wait — ink=6, paper=0 ALREADY
    // We need to set bit 7 (flash). 0x86 = paper 0 ink 6, no flash. 0x06 = paper 0 ink 6.
    // Set flash bit (0x80) → attr = 0x86. So we already have bright bit (0x40)? Let me redo:
    // attr layout: F B P P P I I I → ink=6=110, paper=0, bright=0, flash=0  → 00000110 = 0x06
    mem[vramAttrAddr(0, 0)] = 0x06;
    ula.flashState = false;
    ula.renderFrame(mem); // re-render, flashState false → ink colour
    const inkColour = displayPixel(ula, 0, 0);

    mem[vramAttrAddr(0, 0)] = 0x86; // FLASH set
    ula.flashState = false;
    ula.renderFrame(mem);
    const flashOff = displayPixel(ula, 0, 0);
    ula.flashState = true;
    // Don't call renderFrame again (it would auto-tick flash). Force-render:
    ula.flashState = true;
    ula.renderFrame(mem);
    const flashOn = displayPixel(ula, 0, 0);

    // When flash bit is set and flashState=false → behaves like no-flash
    expect(flashOff).toBe(inkColour);
    // When flash bit is set and flashState=true → ink/paper swap → paper colour
    expect(flashOn).not.toBe(inkColour);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// renderFrame — pixels reflect bitmap × attribute correctly
// ─────────────────────────────────────────────────────────────────────────

describe('renderFrame — pixel decoding', () => {
  let ula: ULA;
  let mem: Uint8Array;
  beforeEach(() => {
    ula = makeUla().ula;
    mem = new Uint8Array(0x10000);
  });

  it('blank memory + border 0 → entire framebuffer is black', () => {
    ula.borderColor = 0;
    ula.renderFrame(mem);
    expect(displayPixel(ula, 0, 0)).toBe(0xFF000000);
    expect(displayPixel(ula, 255, 191)).toBe(0xFF000000);
    expect(pixel(ula, 0, 0)).toBe(0xFF000000); // top-left of border
  });

  it('bitmap byte 0xFF + attr ink=7 paper=0 → row of white pixels', () => {
    mem[vramBitmapAddr(0)] = 0xFF;
    mem[vramAttrAddr(0, 0)] = 0x07;
    ula.renderFrame(mem);
    for (let x = 0; x < 8; x++) {
      expect(displayPixel(ula, x, 0)).toBe(PALETTES.basic[7]);
    }
  });

  it('bit ordering is MSB-left: 0x80 lights only the leftmost pixel', () => {
    mem[vramBitmapAddr(0)] = 0x80;
    mem[vramAttrAddr(0, 0)] = 0x07; // white ink, black paper
    ula.renderFrame(mem);
    expect(displayPixel(ula, 0, 0)).toBe(PALETTES.basic[7]);
    for (let x = 1; x < 8; x++) {
      expect(displayPixel(ula, x, 0)).toBe(PALETTES.basic[0]);
    }
  });

  it('BRIGHT bit (0x40) selects the bright half of the palette', () => {
    mem[vramBitmapAddr(0)] = 0x80;
    mem[vramAttrAddr(0, 0)] = 0x47; // bright=1, ink=7
    ula.renderFrame(mem);
    expect(displayPixel(ula, 0, 0)).toBe(PALETTES.basic[15]); // bright white
  });

  it('paper colour fills cleared bits', () => {
    mem[vramBitmapAddr(0)] = 0x00;
    mem[vramAttrAddr(0, 0)] = 0x28; // ink=0 paper=5 (cyan)
    ula.renderFrame(mem);
    for (let x = 0; x < 8; x++) {
      expect(displayPixel(ula, x, 0)).toBe(PALETTES.basic[5]);
    }
  });

  it('a different char column reads from the correct byte', () => {
    mem[vramBitmapAddr(0) + 1] = 0xFF;        // column 1 lit
    mem[vramAttrAddr(0, 1)] = 0x02;           // ink=2 red
    ula.renderFrame(mem);
    for (let x = 8; x < 16; x++) {
      expect(displayPixel(ula, x, 0)).toBe(PALETTES.basic[2]);
    }
  });

  it('scanline y=8 reads from the interleaved address 0x4020 (not 0x4100)', () => {
    mem[0x4020] = 0xFF;
    mem[vramAttrAddr(8, 0)] = 0x04; // ink=4 green
    ula.renderFrame(mem);
    for (let x = 0; x < 8; x++) {
      expect(displayPixel(ula, x, 8)).toBe(PALETTES.basic[4]);
    }
  });

  it('border area fills with the configured border colour', () => {
    ula.borderColor = 2; // red
    ula.renderFrame(mem);
    // sample several border points
    expect(pixel(ula, 0, 0)).toBe(PALETTES.basic[2]);
    expect(pixel(ula, ula.screenWidth - 1, ula.screenHeight - 1)).toBe(PALETTES.basic[2]);
    expect(pixel(ula, 4, 100)).toBe(PALETTES.basic[2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Palette selection
// ─────────────────────────────────────────────────────────────────────────

describe('Palette selection', () => {
  it('PALETTES exports three named tables of length 16', () => {
    for (const name of ['basic', 'measured', 'vivid'] as const) {
      expect(PALETTES[name].length).toBe(16);
    }
  });

  it('non-bright black equals bright black in all palettes (index 0 vs 8)', () => {
    for (const name of ['basic', 'measured', 'vivid'] as const) {
      expect(PALETTES[name][0]).toBe(0xFF000000);
      expect(PALETTES[name][8]).toBe(0xFF000000);
    }
  });

  it('bright entries (8-15, except black) are >= corresponding normal entry', () => {
    for (const name of ['basic', 'measured', 'vivid'] as const) {
      for (let i = 1; i < 8; i++) {
        // The bright variant must be at least as luminous (any RGB channel >=)
        const n = PALETTES[name][i];
        const b = PALETTES[name][i + 8];
        // crude check: bright channel sum >= normal channel sum
        const sum = (c: number) => ((c >> 16) & 0xFF) + ((c >> 8) & 0xFF) + (c & 0xFF);
        expect(sum(b)).toBeGreaterThanOrEqual(sum(n));
      }
    }
  });

  it('switching ula.palette changes the rendered colour', () => {
    const { ula } = makeUla();
    const mem = new Uint8Array(0x10000);
    mem[vramBitmapAddr(0)] = 0xFF;
    mem[vramAttrAddr(0, 0)] = 0x02; // red ink (non-bright)
    ula.palette = PALETTES.basic;
    ula.renderFrame(mem);
    const basicRed = displayPixel(ula, 0, 0);
    ula.palette = PALETTES.measured;
    ula.renderFrame(mem);
    const measuredRed = displayPixel(ula, 0, 0);
    expect(basicRed).not.toBe(measuredRed);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Border modes
// ─────────────────────────────────────────────────────────────────────────

describe('Border modes', () => {
  it('default border is 48px → 352×288 framebuffer', () => {
    const { ula } = makeUla();
    expect(ula.screenWidth).toBe(352);
    expect(ula.screenHeight).toBe(288);
  });

  it('mode 1 ("small") shrinks border to 24px → 304×240', () => {
    const { ula } = makeUla();
    ula.setBorderMode(1);
    expect(ula.screenWidth).toBe(304);
    expect(ula.screenHeight).toBe(240);
  });

  it('mode 0 ("none") removes border → 256×192', () => {
    const { ula } = makeUla();
    ula.setBorderMode(0);
    expect(ula.screenWidth).toBe(256);
    expect(ula.screenHeight).toBe(192);
  });

  it('pixel buffer size matches the new screen dimensions', () => {
    const { ula } = makeUla();
    ula.setBorderMode(0);
    expect(ula.pixels.length).toBe(256 * 192 * 4);
  });

  it('switching modes preserves a usable render path', () => {
    const { ula } = makeUla();
    ula.setBorderMode(0);
    const mem = new Uint8Array(0x10000);
    mem[vramBitmapAddr(0)] = 0xFF;
    mem[vramAttrAddr(0, 0)] = 0x07;
    expect(() => ula.renderFrame(mem)).not.toThrow();
    // With border 0, paper-area pixel (0,0) is at framebuffer (0,0).
    const buf = new Uint32Array(ula.pixels.buffer);
    expect(buf[0]).toBe(PALETTES.basic[7]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Audio EAR routing
// ─────────────────────────────────────────────────────────────────────────

describe('getAudioEarBit — beeper / tape routing', () => {
  let ula: ULA;
  beforeEach(() => { ula = makeUla().ula; });

  it('without tape, returns the beeper bit', () => {
    ula.writePort(0x00);
    expect(ula.getAudioEarBit(true)).toBe(0);
    ula.writePort(0x10);
    expect(ula.getAudioEarBit(true)).toBe(1);
  });

  it('with tape active + sound enabled, returns the tape signal', () => {
    ula.writePort(0x10); // beeper=1
    ula.tapeActive = true;
    ula.tapeEarBit = 0;
    expect(ula.getAudioEarBit(true)).toBe(0); // tape wins
  });

  it('with tape active but sound disabled, falls back to beeper', () => {
    ula.writePort(0x10);
    ula.tapeActive = true;
    ula.tapeEarBit = 0;
    expect(ula.getAudioEarBit(false)).toBe(1); // beeper still audible
  });
});

// ─────────────────────────────────────────────────────────────────────────
// fillBorder + renderDisplayCell (sub-frame render path)
// ─────────────────────────────────────────────────────────────────────────

describe('Sub-frame rendering helpers', () => {
  it('fillBorder paints a horizontal segment of a single row', () => {
    const { ula } = makeUla();
    ula.borderColor = 0;
    ula.renderFrame(new Uint8Array(0x10000));
    ula.fillBorder(10, 100, 110, 2); // red strip
    for (let x = 100; x < 110; x++) {
      expect(pixel(ula, x, 10)).toBe(PALETTES.basic[2]);
    }
    expect(pixel(ula, 99, 10)).toBe(PALETTES.basic[0]);
    expect(pixel(ula, 110, 10)).toBe(PALETTES.basic[0]);
  });

  it('renderDisplayCell paints exactly one 8-pixel cell of a scanline', () => {
    const { ula } = makeUla();
    const mem = new Uint8Array(0x10000);
    mem[vramBitmapAddr(0) + 3] = 0xAA;      // alternating bits in column 3
    mem[vramAttrAddr(0, 3)] = 0x07;          // white ink, black paper
    ula.renderFrame(mem); // first wipe
    // Re-render only cell (0, 3) — should still produce the same pixels
    ula.renderDisplayCell(0, 3, mem);
    // 0xAA = 10101010
    for (let b = 0; b < 8; b++) {
      const expected = (b % 2 === 0) ? PALETTES.basic[7] : PALETTES.basic[0];
      expect(displayPixel(ula, 24 + b, 0)).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// blankCells (TEXT mode helper)
// ─────────────────────────────────────────────────────────────────────────

describe('blankCells — TEXT mode helper', () => {
  it('clears matched 8×8 cells to the paper colour from the attribute file', () => {
    const { ula } = makeUla();
    const mem = new Uint8Array(0x10000);
    // Fill cell (row 0, col 0) bitmap with 0xFF over all 8 lines
    for (let py = 0; py < 8; py++) mem[vramBitmapAddr(py)] = 0xFF;
    mem[vramAttrAddr(0, 0)] = 0x07; // ink=7 white, paper=0 black
    ula.renderFrame(mem);
    // confirm baseline: cell is white
    expect(displayPixel(ula, 0, 0)).toBe(PALETTES.basic[7]);

    const mask = Array(32 * 24).fill(false);
    mask[0] = true; // blank cell (0,0)
    ula.blankCells(mem, mask);
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        expect(displayPixel(ula, px, py)).toBe(PALETTES.basic[0]); // paper
      }
    }
  });

  it('does not touch cells whose mask entry is false', () => {
    const { ula } = makeUla();
    const mem = new Uint8Array(0x10000);
    for (let py = 0; py < 8; py++) mem[vramBitmapAddr(py) + 1] = 0xFF; // col 1
    mem[vramAttrAddr(0, 1)] = 0x07;
    ula.renderFrame(mem);
    const before = displayPixel(ula, 8, 0);
    expect(before).toBe(PALETTES.basic[7]);
    const mask = Array(32 * 24).fill(false); // nothing masked
    ula.blankCells(mem, mask);
    expect(displayPixel(ula, 8, 0)).toBe(PALETTES.basic[7]); // untouched
  });
});
