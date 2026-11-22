/**
 * Timex Sinclair 2068 / Timex Computer 2068.
 *
 * Expected values come from the published descriptions of the machine, not from
 * the implementation (World of Spectrum "Timex Reference"; Alvin Albrecht's TS2068
 * port map; Ray Kingsley's "Bank Switching the 2068"; the Timex dock cartridge
 * (.dck) format description):
 *   - 16K HOME ROM at 0x0000-0x3FFF, 48K RAM above; an 8K EXROM inside; a dock
 *     connector. Port 0xF4: bit n set selects the alternate bank for the 8K chunk
 *     n (bit 0 = 0x0000-0x1FFF ... bit 7 = 0xE000-0xFFFF). Port 0xFF bit 7: 0 =
 *     DOCK, 1 = EXROM. DOCK and EXROM are exclusive. The EXROM answers in every
 *     chunk that selects it (it is not decoded to one). A DOCK chunk with nothing
 *     in it reads 0xFF. IN 0xF4 / IN 0xFF return the last byte written; power-up
 *     is 0 in both.
 *   - AY-3-8912 on ports 0xF5 (register select) and 0xF6 (data). Its spare I/O
 *     port (register 14) reads two joysticks, chosen by address bit A8 (left) and
 *     A9 (right): bit 0 up, 1 down, 2 left, 3 right, 7 fire, 0 when held.
 *   - The TS2068 is the 60 Hz machine and the TC2068 the 50 Hz one, both at 3.528 MHz.
 *     zx84 builds both as the one model `ts2068`, its locale picking the TV standard
 *     as on the C64: 'us' is NTSC (the TS2068), any other PAL (the TC2068).
 *   - .dck: 9-byte bank header (bank id 0 DOCK / 254 EXROM / 255 HOME, then a type
 *     per chunk: 0 none, 1 RAM, 2 ROM with image, 3 RAM with image), then an 8192-
 *     byte image for each chunk of type 2 or 3.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { spectrumDescriptor, spectrumEntry } from '@/machines/spectrum/descriptor.ts';
import { isTimexClass, isTimex2068Class, is128kClass } from '@/machines/spectrum/models.ts';
import { TIMING_TC2048, TIMING_TS2068 } from '@/machines/spectrum/contention.ts';
import { parseDck } from '@/machines/spectrum/peripherals/timex-dock.ts';
import { joyPressForType, TIMEX_JOY_LEFT, TIMEX_JOY_RIGHT } from '@/machines/spectrum/peripherals/joysticks.ts';
import { entryForModel } from '@/machines/registry.ts';
import { SpectrumSnapshotService } from '@/machines/spectrum/services/snapshots.ts';
import type { MachineHost } from '@/machines/machine.ts';
import { MODEL_LABELS, MODEL_LOCALES, menuModels, modelLocaleSuffix } from '@/ui/panes/model-menu.ts';

const CHUNK = 0x2000;

/** A HOME ROM whose every byte says where it is, and an EXROM that is different. */
const HOME_ROM = Uint8Array.from({ length: 0x4000 }, (_, i) => (i * 5 + 1) & 0xFF);
const EXROM = Uint8Array.from({ length: CHUNK }, (_, i) => (i * 7 + 3) & 0xFF);
const ROM_24K = (() => {
  const r = new Uint8Array(0x6000);
  r.set(HOME_ROM, 0);
  r.set(EXROM, 0x4000);
  return r;
})();

type Standard = 'ntsc' | 'pal';
const localeOf = (std: Standard) => (std === 'ntsc' ? 'us' : 'uk');

function make(std: Standard = 'ntsc'): Spectrum {
  const s = new Spectrum('ts2068', null, localeOf(std));
  s.start = async () => {};
  s.loadROM(ROM_24K);
  s.reset();
  return s;
}

const out = (s: Spectrum, port: number, value: number): void => s.cpu.portOutHandler!(port, value);
const inp = (s: Spectrum, port: number): number => s.cpu.portInHandler!(port);
const peek = (s: Spectrum, addr: number): number => s.cpu.read8(addr);
const poke = (s: Spectrum, addr: number, value: number): void => s.cpu.write8(addr, value);

/** Select the DOCK (exrom false) or EXROM for the chunks in `mask`. */
function page(s: Spectrum, mask: number, exrom: boolean): void {
  out(s, 0x00FF, exrom ? 0x80 : 0x00);
  out(s, 0x00F4, mask);
}

/** Build a .dck file: banks of [id, types[8], images in chunk order]. */
function dck(...banks: [id: number, types: number[], images: Uint8Array[]][]): Uint8Array {
  const parts: number[] = [];
  for (const [id, types, images] of banks) {
    parts.push(id, ...types);
    for (const img of images) parts.push(...img);
  }
  return Uint8Array.from(parts);
}
const fill = (v: number): Uint8Array => new Uint8Array(CHUNK).fill(v);

describe('Timex 2068 — models and timing', () => {
  it('is a Timex class machine, and the only 2068-class model is ts2068', () => {
    expect(isTimexClass('ts2068')).toBe(true);
    expect(isTimex2068Class('ts2068')).toBe(true);
    expect(is128kClass('ts2068')).toBe(false);
    expect(isTimex2068Class('tc2048')).toBe(false);
    expect(isTimexClass('tc2048')).toBe(true);
    expect(isTimex2068Class('zx48k')).toBe(false);
  });

  it('runs both standards at 3.528 MHz: NTSC (the TS2068) on a 60 Hz 262-line frame, PAL (the TC2068) on the 50 Hz one', () => {
    expect(TIMING_TS2068.cpuClock).toBe(3_528_000);
    expect(TIMING_TS2068.tStatesPerLine).toBe(224);
    expect(TIMING_TS2068.tStatesPerFrame).toBe(224 * 262);
    expect(TIMING_TS2068.cpuClock / TIMING_TS2068.tStatesPerFrame).toBeCloseTo(60.1, 1);
    expect(make('ntsc').tStatesPerFrame).toBe(58_688);
    expect(make('pal').tStatesPerFrame).toBe(TIMING_TC2048.tStatesPerFrame);
    expect(TIMING_TC2048.cpuClock / TIMING_TC2048.tStatesPerFrame).toBeCloseTo(50.5, 1);
    expect(make('pal').cpuClockHz).toBe(3_528_000);
  });

  it('is built in the TV standard its locale names, by the registry entry the shell uses', () => {
    const ntsc = spectrumEntry.create('ts2068', null, 'us') as Spectrum;
    const pal = spectrumEntry.create('ts2068', null, 'uk') as Spectrum;
    expect(ntsc.tStatesPerFrame).toBe(58_688);
    expect(pal.tStatesPerFrame).toBe(69_888);
    expect(spectrumEntry.create('ts2068', null).descriptor.locale).toBe('uk');
    expect(ntsc.descriptor.locale).toBe('us');
  });

  it('has an AY on the CPU clock halved, and contends 0x4000-0x7FFF', () => {
    const s = make();
    expect(s.variant.hasAY).toBe(true);
    expect(s.variant.ayClock).toBe(1_764_000);
    expect(s.variant.hasBanking).toBe(false);
    expect(s.variant.isContended(0x3FFF, -1)).toBe(false);
    expect(s.variant.isContended(0x4000, 5)).toBe(true);
    expect(s.variant.isContended(0x7FFF, 5)).toBe(true);
    expect(s.variant.isContended(0x8000, 2)).toBe(false);
  });

  it('is registered as one Spectrum model with a PAL / NTSC choice, on the hosted TC2068 ROM pair', () => {
    expect(entryForModel('ts2068').kind).toBe('spectrum');
    for (const locale of ['uk', 'us'] as const) {
      expect(spectrumEntry.romSources('ts2068', locale)).toEqual(['timex/tc2068-0.rom', 'timex/tc2068-1.rom']);
    }
    expect(menuModels()).toContain('ts2068');
    expect(MODEL_LABELS.ts2068).toBe('Timex 2068');
    expect(MODEL_LOCALES.ts2068).toEqual(['uk', 'us']);
    expect(modelLocaleSuffix('ts2068', 'us')).toBe('NTSC');
    expect(modelLocaleSuffix('ts2068', 'uk')).toBe('PAL');
  });

  it('keeps a 2068 when a ROM is dropped on it, and a 24K image makes a TS2068 of anything else', () => {
    expect(spectrumEntry.detectModelForRom!(new Uint8Array(24576), 'ts2068')).toBe('ts2068');
    expect(spectrumEntry.detectModelForRom!(new Uint8Array(16384), 'ts2068')).toBe('ts2068');
    expect(spectrumEntry.detectModelForRom!(new Uint8Array(24576), 'zx48k')).toBe('ts2068');
    expect(spectrumEntry.detectModelForRom!(new Uint8Array(16384), 'zx48k')).toBe('zx48k');
  });

  it('offers a dock slot, the AY, two joystick ports and no mouse or Kempston', () => {
    const ui = spectrumDescriptor('ts2068').ui;
    expect(ui.cartridge).toBe(true);
    expect(ui.soundChip).toBe('AY-3-8912');
    expect(ui.joystickTypes?.map(t => t.id)).toEqual([TIMEX_JOY_LEFT, TIMEX_JOY_RIGHT]);
    expect(ui.mouseTypes).toEqual([]);
    expect(spectrumDescriptor('zx48k').ui.joystickTypes).toBeUndefined();
    expect(spectrumDescriptor('tc2048').ui.soundChip).toBeUndefined();
  });
});

describe('Timex 2068 — HOME memory', () => {
  it('maps the 16K ROM at 0 and the 24K ROM image\'s last 8K as the EXROM, read-only', () => {
    const s = make();
    expect(peek(s, 0x0000)).toBe(HOME_ROM[0]);
    expect(peek(s, 0x3FFF)).toBe(HOME_ROM[0x3FFF]);
    poke(s, 0x0000, 0xAA);
    poke(s, 0x2000, 0xAA);
    expect(peek(s, 0x0000)).toBe(HOME_ROM[0]);
    expect(peek(s, 0x2000)).toBe(HOME_ROM[0x2000]);
  });

  it('has 48K of RAM from 0x4000', () => {
    const s = make();
    for (const addr of [0x4000, 0x5FFF, 0x6000, 0x7FFF, 0x8000, 0xBFFF, 0xC000, 0xFFFF]) {
      poke(s, addr, 0x5A);
      expect(peek(s, addr), addr.toString(16)).toBe(0x5A);
    }
  });

  it('powers up with ports 0xF4 and 0xFF at 0', () => {
    const s = make();
    expect(inp(s, 0x00F4)).toBe(0);
    expect(inp(s, 0x00FF)).toBe(0);
  });
});

describe('Timex 2068 — the horizontal mapper (ports 0xF4 and 0xFF)', () => {
  it('reads back the last byte written to 0xF4, and to 0xFF', () => {
    const s = make();
    out(s, 0x00F4, 0xA5);
    expect(inp(s, 0x00F4)).toBe(0xA5);
    out(s, 0x00FF, 0x83);
    expect(inp(s, 0x00FF)).toBe(0x83);
  });

  it('maps the EXROM over chunk 0 only when bit 0 of F4 and bit 7 of FF are set', () => {
    const s = make();
    page(s, 0x01, true);
    expect(peek(s, 0x0000)).toBe(EXROM[0]);
    expect(peek(s, 0x1FFF)).toBe(EXROM[0x1FFF]);
    expect(peek(s, 0x2000)).toBe(HOME_ROM[0x2000]);   // chunk 1 stays HOME
    page(s, 0x00, true);
    expect(peek(s, 0x0000)).toBe(HOME_ROM[0]);
  });

  it('lets bit n of F4 choose chunk n: bit 1 is 0x2000-0x3FFF, bit 7 is 0xE000-0xFFFF', () => {
    const s = make();
    page(s, 0x02, true);
    expect(peek(s, 0x0000)).toBe(HOME_ROM[0]);
    expect(peek(s, 0x2000)).toBe(EXROM[0]);
    expect(peek(s, 0x3FFF)).toBe(EXROM[0x1FFF]);
    expect(peek(s, 0x4000)).toBe(0);
    page(s, 0x80, true);
    poke(s, 0xE000, 0x77);                       // under a ROM: discarded
    expect(peek(s, 0xE000)).toBe(EXROM[0]);
    expect(peek(s, 0xFFFF)).toBe(EXROM[0x1FFF]);
    expect(peek(s, 0xDFFF)).toBe(0);
  });

  it('shows the same 8K EXROM in every chunk that selects it', () => {
    const s = make();
    page(s, 0xFF, true);
    for (let chunk = 0; chunk < 8; chunk++) {
      expect(peek(s, chunk * CHUNK), `chunk ${chunk} first`).toBe(EXROM[0]);
      expect(peek(s, chunk * CHUNK + 0x1FFF), `chunk ${chunk} last`).toBe(EXROM[0x1FFF]);
      expect(peek(s, chunk * CHUNK + 0x123), `chunk ${chunk} inner`).toBe(EXROM[0x123]);
    }
  });

  it('reads 0xFF from a DOCK chunk when no cartridge is fitted, and ignores writes to it', () => {
    const s = make();
    page(s, 0x04, false);                          // chunk 2: 0x4000-0x5FFF
    expect(peek(s, 0x4000)).toBe(0xFF);
    expect(peek(s, 0x5FFF)).toBe(0xFF);
    poke(s, 0x4000, 0x12);
    expect(peek(s, 0x4000)).toBe(0xFF);
  });

  it('keeps the RAM a chunk hides: writes while it is swapped out are lost, what was there returns', () => {
    const s = make();
    poke(s, 0x8000, 0x42);
    poke(s, 0x9FFF, 0x43);
    page(s, 0x10, true);                           // chunk 4: 0x8000-0x9FFF, now EXROM
    expect(peek(s, 0x8000)).toBe(EXROM[0]);
    poke(s, 0x8000, 0x99);                         // ROM: discarded
    page(s, 0x00, true);
    expect(peek(s, 0x8000)).toBe(0x42);
    expect(peek(s, 0x9FFF)).toBe(0x43);
  });

  it('swaps from DOCK to EXROM, and back, when only bit 7 of FF changes', () => {
    const s = make();
    out(s, 0x00F4, 0x01);
    expect(peek(s, 0x0000)).toBe(0xFF);            // DOCK, empty
    out(s, 0x00FF, 0x80);
    expect(peek(s, 0x0000)).toBe(EXROM[0]);        // EXROM
    out(s, 0x00FF, 0x00);
    expect(peek(s, 0x0000)).toBe(0xFF);
    out(s, 0x00F4, 0x00);
    expect(peek(s, 0x0000)).toBe(HOME_ROM[0]);
  });

  it('does not let FF bit 7 swap anything by itself: a chunk needs its F4 bit', () => {
    const s = make();
    out(s, 0x00FF, 0x80);
    expect(peek(s, 0x0000)).toBe(HOME_ROM[0]);
    expect(peek(s, 0x8000)).toBe(0);
  });

  it('decodes the mapper on the low eight address bits', () => {
    const s = make();
    out(s, 0xAAF4, 0x01);
    out(s, 0x12FF, 0x80);
    expect(peek(s, 0x0000)).toBe(EXROM[0]);
    expect(inp(s, 0x77F4)).toBe(0x01);
  });

  it('puts the HOME ROM back on a reset, with the ports at 0', () => {
    const s = make();
    page(s, 0xFF, true);
    s.reset();
    expect(peek(s, 0x0000)).toBe(HOME_ROM[0]);
    expect(inp(s, 0x00F4)).toBe(0);
    expect(inp(s, 0x00FF)).toBe(0);
  });

  it('draws the screen from the RAM under a chunk swapped over it', () => {
    const s = make();
    poke(s, 0x4000, 0xC3);
    poke(s, 0x5800, 0x47);
    page(s, 0x04, true);                           // EXROM over 0x4000-0x5FFF
    expect(peek(s, 0x4000)).toBe(EXROM[0]);
    expect(s.memory.screenBank[0]).toBe(0xC3);
    expect(s.memory.screenBank[0x1800]).toBe(0x47);
  });

  it('keeps the RAM banks whole for snapshots while a chunk is swapped over them', () => {
    const s = make();
    poke(s, 0x8010, 0x21);
    poke(s, 0xA010, 0x22);
    page(s, 0x10, true);                           // EXROM over 0x8000-0x9FFF
    const bank2 = s.memory.getRamBank(2);          // the bank at 0x8000-0xBFFF
    expect(bank2[0x0010]).toBe(0x21);              // the hidden RAM, not the EXROM
    expect(bank2[0x2010]).toBe(0x22);
    expect(peek(s, 0x8010)).toBe(EXROM[0x10]);     // the CPU still sees the EXROM
  });

  it('writes a loaded snapshot bank behind a swapped chunk, not over it', () => {
    const s = make();
    page(s, 0x10, true);
    s.memory.setBankFromSnapshot(2, new Uint8Array(0x4000).fill(0x6E));
    expect(peek(s, 0x8000)).toBe(EXROM[0]);        // still the EXROM
    expect(peek(s, 0xA000)).toBe(0x6E);            // visible RAM got the data
    page(s, 0x00, true);
    expect(peek(s, 0x8000)).toBe(0x6E);            // and the hidden half did too
  });

  it('keeps swapped chunks across a ROM load', () => {
    const s = make();
    page(s, 0x01, true);
    const other = new Uint8Array(0x6000).fill(0x11);
    s.loadROM(other);
    expect(peek(s, 0x0000)).toBe(0x11);            // the new EXROM
    page(s, 0x00, true);
    expect(peek(s, 0x0000)).toBe(0x11);            // the new HOME ROM
  });
});

describe('Timex 2068 — dock cartridges (.dck)', () => {
  it('maps a DOCK ROM chunk, and reads a chunk the cartridge leaves empty as 0xFF', () => {
    const s = make();
    // DOCK: chunk 0 ROM (fill 0x11), chunk 1 ROM (fill 0x22), the rest nothing.
    s.memory.timexMmu!.setCartridge(parseDck(dck([0, [2, 2, 0, 0, 0, 0, 0, 0], [fill(0x11), fill(0x22)]]), 'a.dck'));
    s.reset();
    page(s, 0x03, false);
    expect(peek(s, 0x0000)).toBe(0x11);
    expect(peek(s, 0x1FFF)).toBe(0x11);
    expect(peek(s, 0x2000)).toBe(0x22);
    page(s, 0x04, false);
    expect(peek(s, 0x4000)).toBe(0xFF);            // chunk 2: empty in the cartridge
    poke(s, 0x4000, 1);
    expect(peek(s, 0x4000)).toBe(0xFF);
  });

  it('makes a DOCK ROM chunk read-only and a DOCK RAM chunk writable, keeping what is written', () => {
    const s = make();
    // chunk 4 ROM with an image; chunk 5 RAM with no image (starts zeroed); chunk 6 RAM with an image.
    s.memory.timexMmu!.setCartridge(parseDck(dck([0, [0, 0, 0, 0, 2, 1, 3, 0], [fill(0xE1), fill(0xE2)]]), 'b.dck'));
    s.reset();
    page(s, 0x70, false);
    expect(peek(s, 0x8000)).toBe(0xE1);
    poke(s, 0x8000, 0x00);
    expect(peek(s, 0x8000)).toBe(0xE1);            // ROM
    expect(peek(s, 0xA000)).toBe(0x00);            // RAM, empty
    poke(s, 0xA000, 0x5C);
    expect(peek(s, 0xA000)).toBe(0x5C);            // RAM takes writes
    expect(peek(s, 0xC000)).toBe(0xE2);            // RAM with initial contents
    page(s, 0x00, false);
    page(s, 0x70, false);
    expect(peek(s, 0xA000)).toBe(0x5C);            // and keeps them when swapped out and in
  });

  it('keeps the HOME RAM a DOCK chunk hides, separate from the cartridge RAM', () => {
    const s = make();
    s.memory.timexMmu!.setCartridge(parseDck(dck([0, [0, 0, 0, 0, 0, 0, 0, 1], []]), 'c.dck'));
    s.reset();
    poke(s, 0xE000, 0x33);                         // HOME RAM
    page(s, 0x80, false);
    expect(peek(s, 0xE000)).toBe(0);               // cartridge RAM
    poke(s, 0xE000, 0x44);
    page(s, 0x00, false);
    expect(peek(s, 0xE000)).toBe(0x33);
    page(s, 0x80, false);
    expect(peek(s, 0xE000)).toBe(0x44);
  });

  it('lets a cartridge override EXROM chunks, and leaves the others with the built-in EXROM', () => {
    const s = make();
    s.memory.timexMmu!.setCartridge(parseDck(dck([254, [2, 0, 0, 0, 0, 0, 0, 0], [fill(0xAB)]]), 'd.dck'));
    s.reset();
    page(s, 0x03, true);
    expect(peek(s, 0x0000)).toBe(0xAB);            // overridden
    expect(peek(s, 0x2000)).toBe(EXROM[0]);        // built in
  });

  it('replaces the HOME ROM with a bank-255 cartridge, read-only or writable by its type', () => {
    const s = make();
    // chunk 0 ROM (0x33), chunk 1 RAM with an image (0x44): a "writable ROM".
    s.memory.timexMmu!.setCartridge(parseDck(dck([255, [2, 3, 0, 0, 0, 0, 0, 0], [fill(0x33), fill(0x44)]]), 'e.dck'));
    s.reset();
    expect(peek(s, 0x0000)).toBe(0x33);
    expect(peek(s, 0x2000)).toBe(0x44);
    poke(s, 0x0000, 0x00);
    poke(s, 0x2000, 0x00);
    expect(peek(s, 0x0000)).toBe(0x33);            // ROM
    expect(peek(s, 0x2000)).toBe(0x00);            // writable
    expect(peek(s, 0x4000)).toBe(0);               // HOME RAM untouched
  });

  it('restores the built-in ROM when the cartridge is removed', () => {
    const s = make();
    s.memory.timexMmu!.setCartridge(parseDck(dck([255, [2, 2, 0, 0, 0, 0, 0, 0], [fill(0x33), fill(0x44)]]), 'f.dck'));
    s.reset();
    expect(peek(s, 0x0000)).toBe(0x33);
    s.memory.timexMmu!.setCartridge(null);
    s.reset();
    expect(peek(s, 0x0000)).toBe(HOME_ROM[0]);
    expect(peek(s, 0x2000)).toBe(HOME_ROM[0x2000]);
  });

  it('reads several banks from one file', () => {
    const cart = parseDck(dck(
      [0, [2, 0, 0, 0, 0, 0, 0, 0], [fill(0x01)]],
      [254, [0, 2, 0, 0, 0, 0, 0, 0], [fill(0x02)]],
      [255, [0, 0, 0, 0, 0, 0, 0, 0], []],
    ), 'g.dck');
    expect(cart.name).toBe('g.dck');
    expect(cart.dock[0]?.data[0]).toBe(1);
    expect(cart.dock[0]?.writable).toBe(false);
    expect(cart.exrom[1]?.data[0]).toBe(2);
    expect(cart.dock[1]).toBeNull();
    expect(cart.home.every(c => c === null)).toBe(true);
  });

  it('skips reserved bank ids (1-253) but still steps over their images', () => {
    const cart = parseDck(dck(
      [7, [2, 0, 0, 0, 0, 0, 0, 0], [fill(0x77)]],
      [0, [2, 0, 0, 0, 0, 0, 0, 0], [fill(0x01)]],
    ), 'h.dck');
    expect(cart.dock[0]?.data[0]).toBe(1);
  });

  it('rejects files that are not cartridges: too short, cut short mid-image, unknown chunk type, empty', () => {
    expect(() => parseDck(new Uint8Array(0), 'x')).toThrow(/too short/);
    expect(() => parseDck(new Uint8Array(8), 'x')).toThrow(/too short/);
    expect(() => parseDck(dck([0, [2, 0, 0, 0, 0, 0, 0, 0], []]), 'x')).toThrow(/truncated/);
    expect(() => parseDck(Uint8Array.from([0, 2, 0, 0, 0, 0, 0, 0, 0, ...fill(1).subarray(0, 8191)]), 'x')).toThrow(/truncated/);
    expect(() => parseDck(Uint8Array.from([0, 4, 0, 0, 0, 0, 0, 0, 0]), 'x')).toThrow(/unknown chunk type/);
    expect(() => parseDck(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]), 'x')).toThrow(/truncated/);
  });

  it('is inserted through the ROM service, restarts the machine, and names itself', () => {
    const s = make();
    const slot = s.services.roms.cartridge!;
    expect(slot.name).toBe('');
    slot.insert(dck([255, [2, 0, 0, 0, 0, 0, 0, 0], [fill(0x5D)]]), 'game.dck');
    expect(slot.name).toBe('game.dck');
    expect(peek(s, 0x0000)).toBe(0x5D);
    slot.eject();
    expect(slot.name).toBe('');
    expect(peek(s, 0x0000)).toBe(HOME_ROM[0]);
  });

  it('refuses a bad file without changing the machine', () => {
    const s = make();
    const slot = s.services.roms.cartridge!;
    expect(() => slot.insert(new Uint8Array(3), 'bad.dck')).toThrow();
    expect(slot.name).toBe('');
    expect(peek(s, 0x0000)).toBe(HOME_ROM[0]);
  });

  it('is accepted by the media service as a cartridge, and refused on a machine with no dock', async () => {
    const s = make();
    const good = await s.services.media.mount(dck([0, [2, 0, 0, 0, 0, 0, 0, 0], [fill(1)]]), 'ok.dck');
    expect(good).toMatchObject({ ok: true, target: 'cartridge' });
    const bad = await s.services.media.mount(new Uint8Array(4), 'bad.dck');
    expect(bad.ok).toBe(false);
    const k = new Spectrum('zx48k', null);
    expect((await k.services.media.mount(dck([0, [2, 0, 0, 0, 0, 0, 0, 0], [fill(1)]]), 'ok.dck')).ok).toBe(false);
  });
});

describe('Timex 2068 — the AY on ports 0xF5 and 0xF6', () => {
  it('selects a register on 0xF5 and writes it on 0xF6, reading it back', () => {
    const s = make();
    out(s, 0x00F5, 8);
    out(s, 0x00F6, 0x0F);
    expect(s.ay.regs[8]).toBe(0x0F);
    expect(inp(s, 0x00F6)).toBe(0x0F);
    out(s, 0x00F5, 0);
    out(s, 0x00F6, 0xA7);
    expect(s.ay.regs[0]).toBe(0xA7);
    expect(inp(s, 0x00F6)).toBe(0xA7);
  });

  it('reads 0xFF from the select port', () => {
    expect(inp(make(), 0x00F5)).toBe(0xFF);
  });

  it('is on the low eight address bits', () => {
    const s = make();
    out(s, 0x34F5, 9);
    out(s, 0x56F6, 0x0C);
    expect(s.ay.regs[9]).toBe(0x0C);
  });

  it('is not there on a TC2048, nor is any of the 2068\'s ports', () => {
    const t = new Spectrum('tc2048', null);
    t.start = async () => {};
    t.loadROM(new Uint8Array(16384));
    t.reset();
    out(t, 0x00F5, 8);
    out(t, 0x00F6, 0x0F);
    expect(t.ay.regs[8]).toBe(0);
    expect(inp(t, 0x00F4)).toBe(0xFF);
  });
});

describe('Timex 2068 — the joysticks (AY register 14)', () => {
  /** Select register 14 and read 0xF6 with the given high address byte. */
  function readStick(s: Spectrum, high: number): number {
    out(s, 0x00F5, 14);
    return inp(s, (high << 8) | 0xF6);
  }

  it('reads 0xFF with nothing held, whichever stick is chosen', () => {
    const s = make();
    for (const high of [0x00, 0x01, 0x02, 0x03]) expect(readStick(s, high), `A9:A8 = ${high}`).toBe(0xFF);
  });

  it('puts up, down, left, right on bits 0-3 and fire on bit 7, each 0 when held', () => {
    const s = make();
    const bit = { up: 0, down: 1, left: 2, right: 3, fire: 7 };
    for (const [dir, b] of Object.entries(bit)) {
      joyPressForType(s, dir, true, TIMEX_JOY_LEFT);
      expect(readStick(s, 0x01), dir).toBe(0xFF & ~(1 << b));
      joyPressForType(s, dir, false, TIMEX_JOY_LEFT);
      expect(readStick(s, 0x01), `${dir} released`).toBe(0xFF);
    }
  });

  it('chooses the left stick with A8 and the right with A9, and ORs both when both are chosen', () => {
    const s = make();
    joyPressForType(s, 'up', true, TIMEX_JOY_LEFT);
    joyPressForType(s, 'fire', true, TIMEX_JOY_RIGHT);
    expect(readStick(s, 0x01)).toBe(0xFE);         // left: up
    expect(readStick(s, 0x02)).toBe(0x7F);         // right: fire
    expect(readStick(s, 0x03)).toBe(0x7E);         // both
    expect(readStick(s, 0x00)).toBe(0xFF);         // neither
  });

  it('reads register 14 as written when the AY port is set to output (register 7 bit 6)', () => {
    const s = make();
    joyPressForType(s, 'up', true, TIMEX_JOY_LEFT);
    out(s, 0x00F5, 7);
    out(s, 0x00F6, 0x40);                          // port A: output
    out(s, 0x00F5, 14);
    out(s, 0x00F6, 0xA5);
    expect(inp(s, 0x01F6)).toBe(0xA5);
    out(s, 0x00F5, 7);
    out(s, 0x00F6, 0x00);                          // port A: input again
    out(s, 0x00F5, 14);
    expect(inp(s, 0x01F6)).toBe(0xFE);
  });

  it('releases both sticks on a reset', () => {
    const s = make();
    joyPressForType(s, 'left', true, TIMEX_JOY_LEFT);
    joyPressForType(s, 'right', true, TIMEX_JOY_RIGHT);
    s.reset();
    expect(readStick(s, 0x03)).toBe(0xFF);
  });

  it('answers no Kempston port: 0x1F reads 0xFF on a 2068 whatever the sticks do', () => {
    const s = make();
    joyPressForType(s, 'fire', true, TIMEX_JOY_LEFT);
    s.joystick.press('fire', true);
    expect(inp(s, 0x001F)).toBe(0xFF);
  });

  it('routes a Timex joystick type to the matching stick through the input service', () => {
    const s = make();
    s.services.input.joystick!.press('down', true, TIMEX_JOY_RIGHT, 1);
    expect(readStick(s, 0x02)).toBe(0xFD);
    expect(readStick(s, 0x01)).toBe(0xFF);
  });
});

describe('Timex 2068 — snapshots', () => {
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

  it('writes an .szx as machine 12 (TS2068) in NTSC or 9 (TC2068) in PAL, with an SCLD block holding F4 and FF', async () => {
    const s = make('ntsc');
    out(s, 0x00FF, 0x86);                          // EXROM select, mode 6
    out(s, 0x00F4, 0x05);
    const szx = await service(s).save('szx');
    expect(szx[6]).toBe(12);
    const scld = findBlock(szx, 'SCLD')!;
    expect(Array.from(szx.subarray(scld.at, scld.at + 2))).toEqual([0x05, 0x86]);
    expect((await service(make('pal')).save('szx'))[6]).toBe(9);
  });

  it('records the AY registers in the file', async () => {
    const s = make();
    out(s, 0x00F5, 8);
    out(s, 0x00F6, 0x0B);
    const szx = await service(s).save('szx');
    const ay = findBlock(szx, 'AY  ')!;
    expect(szx[ay.at + 2 + 8]).toBe(0x0B);
  });

  it('restores the dock / EXROM paging and the RAM behind it', async () => {
    const src = make();
    poke(src, 0x8000, 0x7C);
    page(src, 0x11, true);                         // EXROM over chunks 0 and 4
    const szx = await service(src).save('szx');
    const dst = make();
    const r = await service(dst, hostThat(false).host).apply(szx, 'a.szx');
    expect(r.ok).toBe(true);
    expect(inp(dst, 0x00F4)).toBe(0x11);
    expect(inp(dst, 0x00FF) & 0x80).toBe(0x80);
    expect(peek(dst, 0x0000)).toBe(EXROM[0]);
    expect(peek(dst, 0x8000)).toBe(EXROM[0]);
    page(dst, 0x00, true);
    expect(peek(dst, 0x8000)).toBe(0x7C);
  });

  it('does not page an empty dock over the program when a snapshot recorded a DOCK selection', async () => {
    const src = make();
    poke(src, 0x8000, 0x7C);
    page(src, 0x10, false);
    const szx = await service(src).save('szx');
    const dst = make();
    await service(dst, hostThat(false).host).apply(szx, 'a.szx');
    expect(inp(dst, 0x00F4)).toBe(0);
    expect(peek(dst, 0x8000)).toBe(0x7C);
  });

  it('resumes the same machine after a refresh with its paging and joysticks idle', async () => {
    const src = make();
    page(src, 0x02, true);
    const blob = service(src).saveSync();
    const dst = make();
    expect(await service(dst).restoreSync(blob)).toBe(true);
    expect(peek(dst, 0x2000)).toBe(EXROM[0]);
  });

  it('asks another machine to become a 2068 for a 2068 file, and takes a file of either standard', async () => {
    const ts = await service(make('ntsc')).save('szx');
    const tc = await service(make('pal')).save('szx');
    const ask = hostThat(true);
    const r = await service(new Spectrum('zx48k', null), ask.host).apply(ts, 'a.szx');
    expect(ask.asked).toEqual([['ts2068', 'Timex 2068 .szx: a.szx']]);
    expect(r.needsReplay).toBe(true);
    const onTs = hostThat(true);
    expect((await service(make('ntsc'), onTs.host).apply(tc, 'b.szx')).ok).toBe(true);
    expect(onTs.asked).toEqual([]);
    const fromTc2048 = hostThat(true);
    const tc2048Szx = await service(Object.assign(new Spectrum('tc2048', null), { start: async () => {} })).save('szx');
    await service(make('ntsc'), fromTc2048.host).apply(tc2048Szx, 'c.szx');
    expect(fromTc2048.asked).toEqual([['tc2048', 'TC2048 .szx: c.szx']]);
  });

  it('offers no .z80 for a 2068, and refuses to write one', async () => {
    expect(spectrumDescriptor('ts2068').ui.saveMenu).not.toContain('snapshot-z80');
    expect(spectrumDescriptor('tc2048').ui.saveMenu).toContain('snapshot-z80');
    await expect(service(make()).save('z80')).rejects.toThrow(/szx/);
  });
});

describe('Timex 2068 — the SCLD screen modes still work', () => {
  it('draws hi-res from port 0xFF like a TC2048, with the interrupt-disable bit', () => {
    const s = make();
    out(s, 0x00FF, 0x06);
    expect(s.ula.isHiRes).toBe(true);
    expect(s.timex!.interruptDisabled).toBe(false);
    out(s, 0x00FF, 0x40);
    expect(s.timex!.interruptDisabled).toBe(true);
  });

  it('reads port 0xFE with bits 5 and 7 clear', () => {
    expect(inp(make(), 0xFFFE) & 0xA0).toBe(0);
  });
});

// ── The real ROM ───────────────────────────────────────────────────────────

const ROM_DIRS = [process.env.SPECTRUM_ROM_DIR, resolve(__dirname, '../../../mcp/.cache')]
  .filter((d): d is string => !!d);
const REAL = (() => {
  for (const d of ROM_DIRS) {
    const a = resolve(d, 'tc2068-0.rom');
    const b = resolve(d, 'tc2068-1.rom');
    if (existsSync(a) && existsSync(b)) return [a, b] as const;
  }
  return null;
})();

describe.skipIf(!REAL)('Timex 2068 — the real ROM', { timeout: 60_000 }, () => {
  if (!REAL) console.warn('tc2068-0.rom / tc2068-1.rom not found (SPECTRUM_ROM_DIR or mcp/.cache): skipping the ROM run');

  function boot(std: Standard): Spectrum {
    const s = new Spectrum('ts2068', null, localeOf(std));
    s.start = async () => {};
    const rom = new Uint8Array(0x6000);
    rom.set(readFileSync(REAL![0]), 0);
    rom.set(readFileSync(REAL![1]), 0x4000);
    s.loadROM(rom);
    s.reset();
    for (let f = 0; f < 400; f++) s.tick();
    return s;
  }

  /** A .tap with one BASIC program, `10 PRINT "HI"`, saved under `name`. */
  function basicTap(name: string): Uint8Array {
    const program = [0x00, 0x0A, 0x06, 0x00, 0xF5, 0x22, 0x48, 0x49, 0x22, 0x0D];   // line 10, length 6: PRINT "HI"
    const block = (flag: number, body: number[]): number[] => {
      const data = [flag, ...body];
      const parity = data.reduce((x, y) => x ^ y, 0);
      return [data.length + 1 & 0xFF, (data.length + 1) >> 8, ...data, parity];
    };
    const header = [0x00, ...[...name.padEnd(10)].map(c => c.charCodeAt(0)), program.length, 0x00, 0x0A, 0x00, program.length, 0x00];
    return Uint8Array.from([...block(0x00, header), ...block(0xFF, program)]);
  }

  it('types LOAD "" and loads a BASIC program from tape through the EXROM-assisted ROM loader', async () => {
    const s = new Spectrum('ts2068', null, 'us');
    s.start = async () => {};
    const rom = new Uint8Array(0x6000);
    rom.set(readFileSync(REAL![0]), 0);
    rom.set(readFileSync(REAL![1]), 0x4000);
    s.loadROM(rom);
    s.reset();
    expect((await s.services.media.mount(basicTap('HELLO'), 'hello.tap')).ok).toBe(true);
    s.armBootTrap('rom48k');
    for (let f = 0; f < 3000 && !s.tape.finished; f++) s.tick();
    for (let f = 0; f < 200; f++) s.tick();
    // The program area holds line 10 once LOAD has finished: PROG is system variable 0x5C53.
    const prog = s.memory.readByte(0x5C53) | (s.memory.readByte(0x5C54) << 8);
    expect([...s.memory.readBlock(prog, 10)]).toEqual([0x00, 0x0A, 0x06, 0x00, 0xF5, 0x22, 0x48, 0x49, 0x22, 0x0D]);
  });

  it.each(['ntsc', 'pal'] as const)('boots the %s 2068 to the BASIC prompt with its frame interrupt running', (std) => {
    const s = boot(std);
    const word = (a: number) => s.memory.readByte(a) | (s.memory.readByte(a + 1) << 8);
    expect(word(0x5C78)).toBeGreaterThan(150);       // FRAMES: counting the frame interrupt
    expect(s.ocrScreenForMcp()).toMatch(/Timex/i);
  });

  it('fills the whole 352x288 frame on the 262-line TS2068 frame: paper in the picture, border colour at every corner and edge row', () => {
    const s = boot('ntsc');
    const u = s.ula;
    const px = new Uint32Array(u.pixels.buffer, u.pixels.byteOffset, u.pixels.length >> 2);
    const white = u.palette[7];
    expect(px[(u.borderTop + 100) * u.screenWidth + u.borderLeft + 100]).toBe(white);
    for (const y of [0, 1, u.screenHeight - 2, u.screenHeight - 1]) {
      for (const x of [0, u.screenWidth - 1]) expect(px[y * u.screenWidth + x], `(${x}, ${y})`).toBe(white);
    }
    // Every row is drawn: none is left as the cleared buffer's transparent black.
    for (let y = 0; y < u.screenHeight; y++) expect(px[y * u.screenWidth + 5], `row ${y}`).toBe(white);
  });
});
