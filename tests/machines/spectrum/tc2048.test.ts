/**
 * Timex Computer 2048.
 *
 * Expected values come from the published descriptions of the Timex SCLD, not
 * from the implementation (World of Spectrum "Timex Reference"; Fuse's
 * tc2048_tech_notes and its documented display behaviour):
 *   - 48K RAM, one 16K ROM, no paging; CPU 3.528 MHz; contention pattern
 *     6,5,4,3,2,1,0,0 starting at T 14320 over 0x4000-0x7FFF.
 *   - Port 0xFF: bits 0-2 screen mode, 3-5 hi-res colour (ink = the value, paper
 *     its complement, both bright, border = paper), 6 disables the frame
 *     interrupt. Reading it returns the last byte written.
 *   - Ports 0xFE and 0xFF are decoded on the low eight address bits. IN 0xFE has
 *     bits 5 and 7 clear; unattached ports read 0xFF (no floating bus); the
 *     Kempston joystick answers any port with A5 low.
 *   - Modes: 0 screen 0; 1 screen 1 (same layout at 0x6000); 2 screen 0 bitmap
 *     with one attribute per 8x1 taken from screen 1's bitmap layout; 3 as 2 on
 *     screen 1, the bitmap byte being its own attribute; 4-7 are 512 pixels
 *     wide, two bytes per cell: 4 screen 0 bitmap + screen 0 attribute byte,
 *     5 screen 1 bitmap + screen 1 attribute byte, 6 screen 0 bitmap + screen 1
 *     bitmap (the usual hi-res), 7 screen 1 bitmap twice.
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { spectrumDescriptor, spectrumEntry } from '@/machines/spectrum/descriptor.ts';
import { isTimexClass, is16K, is128kClass } from '@/machines/spectrum/models.ts';
import { TIMING_TC2048 } from '@/machines/spectrum/contention.ts';
import { entryForModel } from '@/machines/registry.ts';
import { MODEL_LABELS, menuModels } from '@/ui/panes/model-menu.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type { MachineHost } from '@/machines/machine.ts';
import { SpectrumSnapshotService } from '@/machines/spectrum/services/snapshots.ts';

function tc2048(display: IScreenRenderer | null = null): Spectrum {
  const s = new Spectrum('tc2048', display);
  s.start = async () => {};
  s.loadROM(new Uint8Array(16384));
  s.reset();
  return s;
}

const out = (s: Spectrum, port: number, value: number): void => s.cpu.portOutHandler!(port, value);
const inp = (s: Spectrum, port: number): number => s.cpu.portInHandler!(port);

/** The colour at (x, y) of the picture proper (the 256x192 area, or 512x192 in
 *  hi-res: x counts buffer pixels), as the ULA's palette entry it was drawn from. */
function pixel(s: Spectrum, x: number, y: number): number {
  const u = s.ula;
  const buf = new Uint32Array(u.pixels.buffer, u.pixels.byteOffset, u.pixels.length >> 2);
  return buf[(y + u.borderTop) * u.screenWidth + u.borderLeft * u.xScale + x];
}

/** The border pixel at the top left of the buffer. */
function borderPixel(s: Spectrum): number {
  return new Uint32Array(s.ula.pixels.buffer, s.ula.pixels.byteOffset, 1)[0];
}

/** Draw the frame in the given port 0xFF value from what is in screen RAM. */
function render(s: Spectrum, dec: number): void {
  out(s, 0x00FF, dec);
  s.ula.renderFrame(s.memory.screenBank, 0x4000);
}

const pal = (s: Spectrum) => s.ula.palette;

describe('Timex Computer 2048 — model, memory and timing', () => {
  it('is the one Timex class model; no other Spectrum is', () => {
    expect(isTimexClass('tc2048')).toBe(true);
    for (const m of ['zx16k', 'zx48k', 'zx128k', 'scorpion256', 'pentagon128'] as const) expect(isTimexClass(m)).toBe(false);
  });

  it('is a 48K machine: 16K ROM in one page, 48K RAM, no banking', () => {
    const s = tc2048();
    expect(is16K('tc2048')).toBe(false);
    expect(is128kClass('tc2048')).toBe(false);
    expect(s.memory.romPages.length).toBeGreaterThanOrEqual(1);
    expect(s.variant.hasBanking).toBe(false);
    expect(s.variant.hasAY).toBe(false);
    expect(s.variant.is48K).toBe(true);
    s.memory.writeByte(0xFFFF, 0x5A);
    expect(s.memory.readByte(0xFFFF)).toBe(0x5A);
  });

  it('contends 0x4000-0x7FFF only', () => {
    const s = tc2048();
    expect(s.variant.isContended(0x3FFF, -1)).toBe(false);
    expect(s.variant.isContended(0x4000, 5)).toBe(true);
    expect(s.variant.isContended(0x7FFF, 5)).toBe(true);
    expect(s.variant.isContended(0x8000, 2)).toBe(false);
  });

  it('runs a 3.528 MHz CPU with contention at T 14320 and a 69,888 T frame', () => {
    expect(TIMING_TC2048.cpuClock).toBe(3_528_000);
    expect(TIMING_TC2048.contentionStart).toBe(14320);
    expect(TIMING_TC2048.tStatesPerFrame).toBe(69_888);
    expect(tc2048().tStatesPerFrame).toBe(69_888);
    expect(tc2048().cpuClockHz).toBe(3_528_000);
  });

  it('has no floating bus: an unattached port reads 0xFF', () => {
    expect(tc2048().variant.hasFloatingBus).toBe(false);
    expect(inp(tc2048(), 0x00FD)).toBe(0xFF);
  });
});

describe('Timex Computer 2048 — registration', () => {
  it('is a Spectrum-kind model whose ROM is the hosted Timex image', () => {
    expect(entryForModel('tc2048').kind).toBe('spectrum');
    expect(spectrumEntry.romSources('tc2048')).toEqual(['timex/tc2048.rom']);
  });

  it('is in the model menu under its own name', () => {
    expect(menuModels()).toContain('tc2048');
    expect(MODEL_LABELS.tc2048).toBe('Timex Computer 2048');
  });

  it('keeps itself when a 16K ROM image is dropped on it, and a 48K stays a 48K', () => {
    const rom = new Uint8Array(16384);
    expect(spectrumEntry.detectModelForRom!(rom, 'tc2048')).toBe('tc2048');
    expect(spectrumEntry.detectModelForRom!(rom, 'zx48k')).toBe('zx48k');
  });

  it('is a 352x288 frame of square pixels, and 704 wide at half-width pixels in hi-res', () => {
    const normal = spectrumDescriptor('tc2048').screen;
    expect([normal.width, normal.height, normal.pixelAspectX, normal.activeWidth, normal.borderLeft]).toEqual([352, 288, 1, 256, 48]);
    const hires = spectrumDescriptor('tc2048', 'uk', 2).screen;
    expect([hires.width, hires.height, hires.pixelAspectX, hires.activeWidth, hires.borderLeft]).toEqual([704, 288, 0.5, 512, 96]);
  });

  it('offers no mouse interface, which its port decode does not reach', () => {
    expect(spectrumDescriptor('tc2048').ui.mouseTypes).toEqual([]);
    expect(spectrumDescriptor('tc2048').ui.statusLeds).not.toContain('mouse');
    expect(spectrumDescriptor('zx48k').ui.mouseTypes.length).toBeGreaterThan(0);
  });
});

describe('Timex Computer 2048 — ports', () => {
  it('reads port 0xFF back as the last byte written, from any address with low byte 0xFF', () => {
    const s = tc2048();
    expect(inp(s, 0x00FF)).toBe(0);
    out(s, 0x00FF, 0x3E);
    expect(inp(s, 0x00FF)).toBe(0x3E);
    expect(inp(s, 0x7FFF)).toBe(0x3E);
    expect(inp(s, 0xFFFF)).toBe(0x3E);
    out(s, 0x12FF, 0xC1);
    expect(inp(s, 0x00FF)).toBe(0xC1);
  });

  it('clears port 0xFF on reset', () => {
    const s = tc2048();
    out(s, 0x00FF, 0x3E);
    s.reset();
    expect(inp(s, 0x00FF)).toBe(0);
  });

  it('reads the keyboard port with bits 5 and 7 clear and the key bits released, where a 48K has them set', () => {
    const t = inp(tc2048(), 0xFEFE);
    expect(t & 0xA0).toBe(0);
    expect(t & 0x1F).toBe(0x1F);
    const plain = new Spectrum('zx48k', null);
    expect(plain.cpu.portInHandler!(0xFEFE) & 0xA0).toBe(0xA0);
  });

  it('answers the Kempston joystick on any port with A5 low, and 0xFF elsewhere', () => {
    const s = tc2048();
    s.joystick.state = 0x12;
    expect(inp(s, 0x001F)).toBe(0x12);
    expect(inp(s, 0x00DF)).toBe(0x12);          // A5 = 0 as well
    expect(inp(s, 0x00FD)).toBe(0xFF);          // A5 = 1: nothing there
    s.joystick.enabled = false;
    expect(inp(s, 0x001F)).toBe(0x12);          // built in: not a Hardware-pane option
  });

  it('decodes the ULA on the low byte 0xFE only: another even port does not set the border', () => {
    const s = tc2048();
    out(s, 0x00FC, 0x05);
    expect(s.ula.borderColor).toBe(0);
    out(s, 0x00FE, 0x05);
    expect(s.ula.borderColor).toBe(5);
    const plain = new Spectrum('zx48k', null);
    plain.cpu.portOutHandler!(0x00FC, 0x05);
    expect(plain.ula.borderColor).toBe(5);      // on a Ferranti ULA any even port is the ULA
  });
});

describe('Timex Computer 2048 — frame interrupt', () => {
  /** IM 1; EI; spin. The IM 1 handler counts its calls in 0x8000. */
  function interruptCounter(): Spectrum {
    const rom = new Uint8Array(16384);
    rom.set([0xED, 0x56, 0xFB, 0x18, 0xFE], 0);
    rom.set([0x21, 0x00, 0x80, 0x34, 0xFB, 0xC9], 0x38);
    const s = new Spectrum('tc2048', null);
    s.start = async () => {};
    s.loadROM(rom);
    s.reset();
    return s;
  }
  const frames = (s: Spectrum, n: number): number => {
    const before = s.memory.readByte(0x8000);
    for (let i = 0; i < n; i++) s.tick();
    return s.memory.readByte(0x8000) - before;
  };

  it('interrupts once a frame', () => {
    const s = interruptCounter();
    expect(frames(s, 10)).toBeGreaterThanOrEqual(9);
    expect(frames(s, 10)).toBeLessThanOrEqual(10);
  });

  it('is held off by port 0xFF bit 6 whatever EI says, and returns when it is cleared', () => {
    const s = interruptCounter();
    frames(s, 3);
    out(s, 0x00FF, 0x40);
    frames(s, 1);                                // the frame the write landed in
    expect(frames(s, 10)).toBe(0);
    out(s, 0x00FF, 0x00);
    expect(frames(s, 10)).toBeGreaterThanOrEqual(9);
  });
});

describe('Timex Computer 2048 — standard screens (modes 0 to 3)', () => {
  it('mode 0 draws screen 0 with its 8x8 attribute and leaves the buffer 352 wide', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0x80);            // pixel 0 set
    s.memory.writeByte(0x5800, 0x07);            // ink white, paper black
    s.memory.writeByte(0x6000, 0xFF);            // screen 1 must be ignored
    render(s, 0x00);
    expect(pixel(s, 0, 0)).toBe(pal(s)[7]);
    expect(pixel(s, 1, 0)).toBe(pal(s)[0]);
    expect(s.ula.screenWidth).toBe(352);
    expect(s.ula.xScale).toBe(1);
  });

  it('mode 1 draws screen 1: the same layout at 0x6000, its attributes at 0x7800', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0x00);
    s.memory.writeByte(0x5800, 0x38);
    s.memory.writeByte(0x6000, 0x80);
    s.memory.writeByte(0x7800, 0x02);            // ink red, paper black
    render(s, 0x01);
    expect(pixel(s, 0, 0)).toBe(pal(s)[2]);
    expect(pixel(s, 1, 0)).toBe(pal(s)[0]);
  });

  it('mode 2 takes an attribute for every 8x1 line from screen 1\'s bitmap layout, ignoring the 8x8 attributes', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0xF0);            // line 0
    s.memory.writeByte(0x4100, 0xF0);            // line 1
    s.memory.writeByte(0x6000, 0x02);            // line 0: ink red
    s.memory.writeByte(0x6100, 0x04);            // line 1: ink green
    s.memory.writeByte(0x5800, 0x07);            // the 8x8 attribute would make both ink white
    render(s, 0x02);
    expect(pixel(s, 0, 0)).toBe(pal(s)[2]);
    expect(pixel(s, 0, 1)).toBe(pal(s)[4]);
    expect(pixel(s, 7, 0)).toBe(pal(s)[0]);      // paper black
  });

  it('mode 3 reads screen 1\'s bitmap byte as its own attribute', () => {
    const s = tc2048();
    s.memory.writeByte(0x6000, 0x41);            // bitmap 01000001; attribute 0x41: bright, ink blue, paper black
    render(s, 0x03);
    expect(pixel(s, 1, 0)).toBe(pal(s)[1 + 8]);  // a set pixel: bright blue
    expect(pixel(s, 0, 0)).toBe(pal(s)[0 + 8]);  // a clear one: bright black
  });
});

describe('Timex Computer 2048 — hi-res screens (modes 4 to 7)', () => {
  const ink = (s: Spectrum, code: number) => pal(s)[code + 8];
  const paper = (s: Spectrum, code: number) => pal(s)[(7 - code) + 8];
  const row = (s: Spectrum, from: number, n: number): number[] =>
    Array.from({ length: n }, (_, i) => pixel(s, from + i, 0));

  it('mode 6 interleaves screen 0 and screen 1 bytes across 512 pixels, in a buffer twice as wide', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0xAA);
    s.memory.writeByte(0x6000, 0xF0);
    render(s, 0x06);                              // ink code 0: black on white
    const i = ink(s, 0), p = paper(s, 0);
    expect(row(s, 0, 16)).toEqual([i, p, i, p, i, p, i, p, i, i, i, i, p, p, p, p]);
    expect(s.ula.xScale).toBe(2);
    expect(s.ula.screenWidth).toBe(704);
    expect(s.frameWidth).toBe(704);
  });

  it('mode 4 follows a screen 0 bitmap byte with screen 0\'s attribute-area byte', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0xFF);
    s.memory.writeByte(0x5800, 0x0F);
    s.memory.writeByte(0x6000, 0xFF);            // not used in this mode
    render(s, 0x04);
    const i = ink(s, 0), p = paper(s, 0);
    expect(row(s, 8, 8)).toEqual([p, p, p, p, i, i, i, i]);
    expect(row(s, 0, 8)).toEqual([i, i, i, i, i, i, i, i]);
  });

  it('mode 5 uses screen 1: its bitmap byte, then its attribute-area byte', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0xFF);            // screen 0 must be ignored
    s.memory.writeByte(0x6000, 0x80);
    s.memory.writeByte(0x7800, 0x01);
    render(s, 0x05);
    const i = ink(s, 0), p = paper(s, 0);
    expect(row(s, 0, 8)).toEqual([i, p, p, p, p, p, p, p]);
    expect(row(s, 8, 8)).toEqual([p, p, p, p, p, p, p, i]);
  });

  it('mode 7 draws the screen 1 bitmap byte twice', () => {
    const s = tc2048();
    s.memory.writeByte(0x6000, 0xC3);
    s.memory.writeByte(0x4000, 0x00);
    render(s, 0x07);
    const i = ink(s, 0), p = paper(s, 0);
    const half = [i, i, p, p, p, p, i, i];
    expect(row(s, 0, 16)).toEqual([...half, ...half]);
  });

  it.each([
    [0, 'black on white'], [1, 'blue on yellow'], [2, 'red on cyan'], [3, 'magenta on green'],
    [4, 'green on magenta'], [5, 'cyan on red'], [6, 'yellow on blue'], [7, 'white on black'],
  ])('hi-res colour %i is %s: the ink is the value, the paper its complement, both bright', (code) => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0x80);
    render(s, 0x06 | (code << 3));
    expect(pixel(s, 0, 0)).toBe(pal(s)[code + 8]);
    expect(pixel(s, 1, 0)).toBe(pal(s)[(7 - code) + 8]);
  });

  it('takes the border from the hi-res paper, not from port 0xFE', () => {
    const s = tc2048();
    out(s, 0x00FE, 0x02);                         // a red border
    render(s, 0x06 | (1 << 3));                   // blue on yellow: paper yellow (6), bright
    expect(borderPixel(s)).toBe(pal(s)[6 + 8]);
    render(s, 0x00);
    expect(borderPixel(s)).toBe(pal(s)[2]);       // outside hi-res the port 0xFE colour is back
  });

  it('returns to a 352-wide buffer when a frame is drawn in a standard mode', () => {
    const s = tc2048();
    render(s, 0x06);
    expect(s.frameWidth).toBe(704);
    render(s, 0x00);
    expect(s.frameWidth).toBe(352);
  });

  it('is 512 pixels wide with no border, and 608 with the small one', () => {
    const s = tc2048();
    s.setBorderSize(0);
    render(s, 0x06);
    expect(s.frameWidth).toBe(512);
    s.setBorderSize(1);
    render(s, 0x06);
    expect(s.frameWidth).toBe((256 + 24 * 2) * 2);
  });
});

describe('Timex Computer 2048 — the display follows the mode', () => {
  function stubDisplay() {
    return {
      resize: vi.fn(), setPixelAspectX: vi.fn(),
    } as unknown as IScreenRenderer & { resize: ReturnType<typeof vi.fn>; setPixelAspectX: ReturnType<typeof vi.fn> };
  }

  it('resizes the display to 704x288 at half-width pixels when hi-res comes in, and back', () => {
    const display = stubDisplay();
    const s = tc2048(display);
    const changed = vi.fn();
    s.onScreenChange = changed;
    render(s, 0x06);
    expect(display.resize).toHaveBeenLastCalledWith(704, 288);
    expect(display.setPixelAspectX).toHaveBeenLastCalledWith(0.5);
    expect(changed).toHaveBeenCalled();
    expect(s.descriptor.screen.width).toBe(704);
    expect(s.descriptor.screen.pixelAspectX).toBe(0.5);
    render(s, 0x00);
    expect(display.resize).toHaveBeenLastCalledWith(352, 288);
    expect(display.setPixelAspectX).toHaveBeenLastCalledWith(1);
    expect(s.descriptor.screen.width).toBe(352);
  });

  it('does not resize while the mode stays standard', () => {
    const display = stubDisplay();
    const s = tc2048(display);
    render(s, 0x00);
    render(s, 0x02);
    expect(display.resize).not.toHaveBeenCalled();
  });

  it('keeps what a frame had drawn when hi-res arrives part-way down it', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0x80);
    s.memory.writeByte(0x5800, 0x07);
    s.ula.renderDisplayCell(0, 0, s.memory.screenBank, 0x4000);   // a standard cell: ink white, then black paper
    expect(pixel(s, 0, 0)).toBe(pal(s)[7]);
    out(s, 0x00FF, 0x06);                         // hi-res from here on
    s.ula.renderDisplayCell(1, 0, s.memory.screenBank, 0x4000);
    expect(s.ula.xScale).toBe(2);
    // The cell already drawn survives, each of its pixels now two wide.
    expect(pixel(s, 0, 0)).toBe(pal(s)[7]);
    expect(pixel(s, 1, 0)).toBe(pal(s)[7]);
    expect(pixel(s, 2, 0)).toBe(pal(s)[0]);
    expect(pixel(s, 3, 0)).toBe(pal(s)[0]);
  });

  it('stays wide for a frame that had hi-res in it, then narrows once a whole frame has none', () => {
    const s = tc2048();
    render(s, 0x06);
    out(s, 0x00FF, 0x00);
    s.ula.beginFrame();                           // the frame that had hi-res has just ended
    expect(s.frameWidth).toBe(704);
    s.ula.beginFrame();                           // a frame with none has ended
    expect(s.frameWidth).toBe(352);
  });

  it('blanks a text cell to the hi-res paper across its 16 buffer pixels in the doubled buffer, and no further', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0xFF);             // hi-res pixels 0-7: ink
    s.memory.writeByte(0x4001, 0xFF);             // hi-res pixels 16-23: ink, in the next cell
    s.memory.writeByte(0x5800, 0x38);             // an 8x8 attribute, which hi-res ignores
    render(s, 0x3E);                              // white ink on black, both bright
    expect(pixel(s, 0, 0)).toBe(pal(s)[15]);
    s.ula.blankCells(s.memory.screenBank, [true], 0x4000, 8, 8, 1, 1);   // a cell 8 logical pixels wide
    expect(pixel(s, 0, 0)).toBe(pal(s)[8]);       // the hi-res paper, not the attribute's
    expect(pixel(s, 15, 0)).toBe(pal(s)[8]);
    expect(pixel(s, 16, 0)).toBe(pal(s)[15]);     // the next cell is untouched ink
  });
});

describe('Timex Computer 2048 — drawn through the beam renderer at every accuracy', () => {
  /** DI; LD A,0x06; OUT (0xFF),A; JR $ - hi-res from before the picture starts. */
  function hiresMachine(): Spectrum {
    const rom = new Uint8Array(16384);
    rom.set([0xF3, 0x3E, 0x06, 0xD3, 0xFF, 0x18, 0xFE], 0);
    const s = new Spectrum('tc2048', null);
    s.start = async () => {};
    s.loadROM(rom);
    s.reset();
    s.memory.writeByte(0x4000, 0xAA);
    s.memory.writeByte(0x6000, 0xF0);
    return s;
  }

  it.each(['low', 'mid', 'high'] as const)('%s: a hi-res frame is 704 wide with the interleaved pixels', (accuracy) => {
    const s = hiresMachine();
    s.scanlineAccuracy = accuracy;
    s.tick();
    s.tick();
    expect(s.frameWidth).toBe(704);
    const i = pal(s)[8], p = pal(s)[15];
    expect(Array.from({ length: 16 }, (_, k) => pixel(s, k, 0)))
      .toEqual([i, p, i, p, i, p, i, p, i, i, i, i, p, p, p, p]);
    expect(borderPixel(s)).toBe(p);              // paper of ink 0
  });
});

describe('Timex Computer 2048 — reading the displayed screen as text', () => {
  it('is the screen bank in the standard screen 0 modes, and any other Spectrum', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0x77);
    s.memory.writeByte(0x6000, 0x88);
    expect(s.textScreen![0]).toBe(0x77);
    expect(s.textScreen).toHaveLength(16384);     // the whole bank, not a view shifted into it
    out(s, 0x00FF, 0x02);
    expect(s.textScreen![0]).toBe(0x77);
    const plain = new Spectrum('zx48k', null);
    plain.memory.writeByte(0x4000, 0x55);
    expect(plain.textScreen![0]).toBe(0x55);
  });

  it('starts at screen 1 when screen 1 is shown (modes 1 and 3)', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0x11);
    s.memory.writeByte(0x6000, 0x99);
    s.memory.writeByte(0x7800, 0x45);             // screen 1's first attribute
    for (const mode of [0x01, 0x03]) {
      out(s, 0x00FF, mode);
      expect(s.textScreen![0]).toBe(0x99);
      expect(s.textScreen![0x1800]).toBe(0x45);
      expect(s.screenExportBytes()![0]).toBe(0x99);
    }
    out(s, 0x00FF, 0x00);
    expect(s.screenExportBytes()![0]).toBe(0x11);
    expect(s.screenExportBytes()).toHaveLength(6912);
  });

  it('is the 64-byte-row hi-res bitmap in hi-res, which the hi-res grids read (see hires-ocr.test.ts)', () => {
    const s = tc2048();
    s.memory.writeByte(0x4000, 0x81);
    s.memory.writeByte(0x6000, 0x42);
    out(s, 0x00FF, 0x06);
    expect(s.textScreen).toHaveLength(64 * 192);
    expect(s.textScreen[0]).toBe(0x81);            // screen 0's byte, then screen 1's
    expect(s.textScreen[1]).toBe(0x42);
  });
});

describe('Timex Computer 2048 — snapshots', () => {
  /** Payload offset and size of the first SZX block with this id, or null. */
  function findBlock(szx: Uint8Array, id: string): { at: number; size: number } | null {
    let o = 8;
    while (o + 8 <= szx.length) {
      const size = szx[o + 4] | (szx[o + 5] << 8) | (szx[o + 6] << 16) | (szx[o + 7] << 24);
      if (String.fromCharCode(...szx.subarray(o, o + 4)) === id) return { at: o + 8, size };
      o += 8 + size;
    }
    return null;
  }
  const hostThat = (answer: boolean): { host: MachineHost; asked: [string, string][] } => {
    const asked: [string, string][] = [];
    return {
      asked,
      host: {
        setStatus: () => {}, persistMedia: () => {},
        requestModel: async (model, reason) => { asked.push([model, reason]); return answer; },
      },
    };
  };
  const service = (s: Spectrum, host: MachineHost | null = null) => new SpectrumSnapshotService(s, () => host);

  it('writes an .szx as machine 8 with an SCLD block of chF4 = 0 and chFF = port 0xFF', async () => {
    const s = tc2048();
    out(s, 0x00FF, 0x3E);
    const szx = await service(s).save('szx');
    expect(szx[6]).toBe(8);
    const scld = findBlock(szx, 'SCLD')!;
    expect(scld.size).toBe(8);
    expect(Array.from(szx.subarray(scld.at, scld.at + 8))).toEqual([0, 0x3E, 0, 0, 0, 0, 0, 0]);
  });

  it('writes no SCLD block and machine 1 for a 48K', async () => {
    const szx = await service(new Spectrum('zx48k', null)).save('szx');
    expect(szx[6]).toBe(1);
    expect(findBlock(szx, 'SCLD')).toBeNull();
  });

  it('restores the screen mode, hi-res colour and RAM from an .szx', async () => {
    const src = tc2048();
    src.memory.writeByte(0x6000, 0xC3);
    out(src, 0x00FF, 0x1E);                       // mode 6, colour code 3
    const szx = await service(src).save('szx');
    const dst = tc2048();
    const r = await service(dst, hostThat(false).host).apply(szx, 'a.szx');
    expect(r.ok).toBe(true);
    expect(inp(dst, 0x00FF)).toBe(0x1E);
    expect(dst.ula.timexMode).toBe(6);
    expect(dst.ula.hiResInk).toBe(3);
    expect(dst.memory.readByte(0x6000)).toBe(0xC3);
  });

  it('resumes a refresh blob in the same screen mode', async () => {
    const src = tc2048();
    out(src, 0x00FF, 0x06);
    const blob = service(src).saveSync();
    const dst = tc2048();
    expect(await service(dst).restoreSync(blob)).toBe(true);
    expect(dst.timex!.dec).toBe(0x06);
    expect(dst.ula.isHiRes).toBe(true);
  });

  it('asks a 48K for a TC2048 when given a TC2048 .szx, and replays it on the new machine', async () => {
    const szx = await service(tc2048()).save('szx');
    const { host, asked } = hostThat(true);
    const r = await service(new Spectrum('zx48k', null), host).apply(szx, 'tc.szx');
    expect(asked).toEqual([['tc2048', 'TC2048 .szx: tc.szx']]);
    expect(r.needsReplay).toBe(true);
  });

  it('loads it as a plain 48K when the switch is declined', async () => {
    const szx = await service(tc2048()).save('szx');
    const { host } = hostThat(false);
    const dst = new Spectrum('zx48k', null);
    dst.start = async () => {};
    const r = await service(dst, host).apply(szx, 'tc.szx');
    expect(r.ok).toBe(true);
    expect(r.needsReplay).toBeUndefined();
  });

  it('writes a .z80 as hardware mode 14 with the last OUT to port 0xFF in byte 36', async () => {
    const s = tc2048();
    s.cpu.im = 1;
    out(s, 0x00FF, 0x3E);
    const z80 = await service(s).save('z80');
    expect(z80[34]).toBe(14);
    expect(z80[36]).toBe(0x3E);
  });

  it('restores a .z80 TC2048 file\'s screen mode, and asks a 48K to become one', async () => {
    const src = tc2048();
    src.cpu.im = 1;
    out(src, 0x00FF, 0x0E);
    const z80 = await service(src).save('z80');
    const dst = tc2048();
    expect((await service(dst).apply(z80, 'a.z80')).ok).toBe(true);
    expect(dst.timex!.dec).toBe(0x0E);
    const { host, asked } = hostThat(true);
    const r = await service(new Spectrum('zx48k', null), host).apply(z80, 'b.z80');
    expect(asked).toEqual([['tc2048', 'TC2048 .z80: b.z80']]);
    expect(r.needsReplay).toBe(true);
  });

  it('leaves a 48K .z80 as hardware mode 0', async () => {
    const s = new Spectrum('zx48k', null);
    s.cpu.im = 1;
    expect((await service(s).save('z80'))[34]).toBe(0);
  });
});

// ── The real ROM ───────────────────────────────────────────────────────────

const ROM = [process.env.SPECTRUM_ROM_DIR, resolve(__dirname, '../../../mcp/.cache')]
  .filter((d): d is string => !!d)
  .map(d => resolve(d, 'tc2048.rom'))
  .find(p => existsSync(p));

describe.skipIf(!ROM)('Timex Computer 2048 — the real ROM', { timeout: 30_000 }, () => {
  if (!ROM) console.warn('tc2048.rom not found (SPECTRUM_ROM_DIR or mcp/.cache): skipping the ROM run');

  it('boots to the BASIC prompt on 48K of RAM with the frame interrupt running', () => {
    const s = new Spectrum('tc2048', null);
    s.start = async () => {};
    s.loadROM(new Uint8Array(readFileSync(ROM!)));
    s.reset();
    // The ROM's RAM test runs with interrupts off for the first ~80 frames.
    for (let f = 0; f < 300; f++) s.tick();
    const word = (a: number) => s.memory.readByte(a) | (s.memory.readByte(a + 1) << 8);
    expect(word(0x5CB2)).toBe(65367);             // RAMTOP: 48K's, just under the 168 bytes of UDGs
    expect(word(0x5C78)).toBeGreaterThan(150);    // FRAMES: counting the frame interrupt
    expect(s.memory.readByte(0x5800)).toBe(0x38); // the ROM's ATTR-P: black on white
    expect(pixel(s, 100, 100)).toBe(pal(s)[7]);   // drawn: a paper pixel in the middle of the picture
    expect(s.ocrScreenForMcp()).toContain('1982 Sinclair Research Ltd');
  });
});
