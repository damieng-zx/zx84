/**
 * Oric sound and on-screen keyboard.
 *
 * The sound test drives the ROM's own `PING` command, which writes the PSG
 * through the same VIA-port-A protocol every Oric program uses, so it proves
 * the wiring end to end rather than poking the chip directly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OricMachine } from '@/machines/oric/oric-machine.ts';
import { OricKeyboard } from '@/machines/oric/oric-keyboard.ts';
import {
  ORIC_A_ROW, ORIC_BOTTOM_ROW, ORIC_DECK_KEYS, ORIC_FUNCT, ORIC_Q_ROW, ORIC_SPACE,
  ORIC_TOP_ROW, ORIC_Z_ROW, isFunctCap,
} from '@/machines/oric/ui/keyboard/layout.ts';
import { ORIC_SCENE, atmosDeck, oric1Deck, placeOricKeys } from '@/machines/oric/ui/keyboard/scene-geometry.ts';
import { ORIC_TEXT_SCREEN, ORIC_TEXT_COLS } from '@/machines/oric/constants.ts';

const CACHE = join(process.cwd(), 'mcp', '.cache');
const ATMOS_ROM = 'oric-basic11b.rom';
const hasRom = (name: string): boolean => existsSync(join(CACHE, name));
const rom = (name: string): Uint8Array => new Uint8Array(readFileSync(join(CACHE, name)));

function boot(): OricMachine {
  const m = new OricMachine('atmos', null);
  m.loadROM(rom(ATMOS_ROM));
  m.reset();
  for (let i = 0; i < 200; i++) m.tick();
  return m;
}

describe('oric keyboard rows view', () => {
  it('mirrors the matrix as eight active-high row bytes', () => {
    const kb = new OricKeyboard();
    // A is row 6 column 5; 7 is row 0 column 0.
    kb.setCell(6, 5, true);
    kb.setCell(0, 0, true);
    const rows = Array.from(kb.rows);
    expect(rows).toHaveLength(8);
    expect(rows[6]).toBe(0x20);   // bit 5
    expect(rows[0]).toBe(0x01);   // bit 0
    expect(rows[1]).toBe(0);

    kb.releaseAll();
    expect(Array.from(kb.rows)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('releases a cell once, so a second release is a no-op', () => {
    const kb = new OricKeyboard();
    kb.setCell(3, 3, true);
    kb.setCell(3, 3, false);
    kb.setCell(3, 3, false);
    expect(kb.anyPressed()).toBe(false);
  });
});

describe('oric on-screen keyboard', () => {
  it('places every cap inside the scene and without overlaps', () => {
    const placed = placeOricKeys();
    // The Atmos has 58 keys; the deck lists all of them.
    expect(placed).toHaveLength(58);
    expect(placed).toHaveLength(ORIC_DECK_KEYS.length);

    for (const { key, box } of placed) {
      expect(box.x, `${key.id} left`).toBeGreaterThanOrEqual(0);
      expect(box.y, `${key.id} top`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${key.id} right`).toBeLessThanOrEqual(ORIC_SCENE.width);
      expect(box.y + box.height, `${key.id} bottom`).toBeLessThanOrEqual(ORIC_SCENE.height);
      expect(box.width).toBeGreaterThan(0);
    }

    // No two caps may overlap, or the deck would render two keys on top of
    // one another and the lower one could never be pressed.
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i].box;
        const b = placed[j].box;
        const overlaps = a.x < b.x + b.width && b.x < a.x + a.width
          && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlaps, `${placed[i].key.id} overlaps ${placed[j].key.id}`).toBe(false);
      }
    }
  });

  it('gives every cap a unique id and the space bar its own region', () => {
    const ids = ORIC_DECK_KEYS.map(k => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ORIC_SPACE.region).toBe('space');
    // The Funct cap is the Atmos's; the pane hides it on an Oric-1.
    expect(isFunctCap(ORIC_FUNCT)).toBe(true);
    expect(isFunctCap(ORIC_SPACE)).toBe(false);
  });

  it('draws the letters in QWERTY order, row by row', () => {
    // The physical order is not the matrix order, and getting it wrong is what
    // made the deck look unlike the machine. Reading the rows off the photo of a
    // real Atmos gives these letters left to right.
    const letters = (keys: readonly { main: string }[]): string =>
      keys.map(k => k.main).filter(m => /^[A-Z]$/.test(m)).join('');
    expect(letters(ORIC_Q_ROW)).toBe('QWERTYUIOP');
    expect(letters(ORIC_A_ROW)).toBe('ASDFGHJKL');
    expect(letters(ORIC_Z_ROW)).toBe('ZXCVBNM');
    // And the digits run 1..0 along the top row.
    expect(ORIC_TOP_ROW.map(k => k.main).slice(0, 10).join('')).toBe('1234567890');
  });

  it('puts the control caps at the two edges and along the bottom row', () => {
    // The Atmos's outer caps are orange: ESC/CTRL/SHIFT down the left, DEL and
    // RETURN on the right, and the arrows plus FUNCT on the bottom row. That is
    // what gives the real deck its bracketed look, and it is the thing a
    // symbol-ordered layout gets wrong.
    expect(ORIC_Q_ROW[0]!.main).toBe('ESC');
    expect(ORIC_Q_ROW.at(-1)!.main).toBe('DEL');
    expect(ORIC_A_ROW[0]!.main).toBe('CTRL');
    expect(ORIC_A_ROW.at(-1)!.main).toBe('RETURN');
    expect(ORIC_Z_ROW[0]!.main).toBe('SHIFT');
    expect(ORIC_Z_ROW.at(-1)!.main).toBe('SHIFT');
    expect(ORIC_BOTTOM_ROW.map(k => k.main)).toEqual(['\u2190', '\u2193', '', '\u2191', '\u2192', 'FUNCT']);
  });

  it('has no CAPS key, as the real Atmos deck does not', () => {
    // The matrix has a row-7 column-6 position, but no Atmos cap was ever fitted
    // there (uppercase is CTRL-T), so drawing one would invent a key.
    const labels = ORIC_DECK_KEYS.map(k => k.main);
    expect(labels).not.toContain('CAPS');
    expect(ORIC_DECK_KEYS.some(k => k.row === 7 && k.col === 6)).toBe(false);
  });

  it('draws the Oric-1 as its own deck: no FUNCT, blank caps, plate legends', () => {
    // The two machines share a matrix and cap arrangement, but the Oric-1 has no
    // FUNCT (that matrix position is not wired on it) and looks completely
    // different — see the Tynemouth Software photos of both decks side by side.
    // This pins the differences the pane keys off.
    const atmosHasFunct = ORIC_DECK_KEYS.some(k => k.id === 'funct');
    expect(atmosHasFunct, 'the Atmos deck has FUNCT').toBe(true);

    // The Oric-1 deck is the same caps minus FUNCT: 57 rather than 58.
    const oric1 = ORIC_DECK_KEYS.filter(k => k.id !== 'funct');
    expect(oric1).toHaveLength(57);

    // ... and its keys are all still real matrix cells, so nothing goes inert.
    for (const key of oric1) {
      expect(key.row, `${key.id} row`).toBeGreaterThanOrEqual(0);
      expect(key.col, `${key.id} col`).toBeGreaterThanOrEqual(0);
    }

    // The FUNCT matrix position is row 5 column 4; confirming it is the only cap
    // there is what makes "minus FUNCT" a whole-deck difference rather than a
    // renamed key.
    expect(ORIC_DECK_KEYS.filter(k => k.row === 5 && k.col === 4).map(k => k.id))
      .toEqual(['funct']);
  });

  it('leaves the Oric-1 room on the plate for its printed legends', () => {
    // The Oric-1's caps are blank and its legends are printed on the plate above
    // each key, so the gap between one cap's top and the cap above it has to be
    // tall enough to actually write in. This is what regressed: with the Atmos's
    // 39-unit caps in a 44-unit row pitch there were only 5 units of plate, and
    // the legends were squeezed to nothing.
    const atmos = atmosDeck();
    const oric1 = oric1Deck();

    const rowTops = (deck: ReturnType<typeof atmosDeck>): number[] =>
      [...new Set(deck.keys.map(k => k.box.y))].sort((a, b) => a - b);

    const gap = (deck: ReturnType<typeof atmosDeck>): number => {
      const tops = rowTops(deck);
      const capHeight = deck.keys[0]!.box.height;
      return tops[1]! - tops[0]! - capHeight;
    };

    // The Oric-1's caps are shorter than the Atmos's...
    expect(oric1.keys[0]!.box.height).toBeLessThan(atmos.keys[0]!.box.height);
    // ...which is what gives its plate room for a legend.
    expect(gap(oric1)).toBeGreaterThanOrEqual(12);
    // The Atmos keeps its legends on the caps, so it needs no such gap.
    expect(gap(atmos)).toBeLessThan(gap(oric1));
  });

  it('lays out the control column as measured from the machine', () => {
    // Widths and insets come from a photograph of a real Atmos, normalised to
    // the cap pitch: CTRL is 1.04 caps at 0.17 in, the left SHIFT 1.46 at 0.21.
    // `capWidth` subtracts the fixed row gap, so a 1.04-cap key is 40.84px.
    const placed = placeOricKeys();
    const box = (main: string) => placed.find(({ key }) => key.main === main)!.box;
    const esc = box('ESC');
    const ctrl = box('CTRL');
    const shift = box('SHIFT');
    const returnKey = box('RETURN');

    // CTRL sits just inboard of ESC and is one cap wide.
    expect(ctrl.x - esc.x).toBeCloseTo(7.82, 0);
    expect(ctrl.width).toBeCloseTo(40.84, 0);
    // The left SHIFT's left edge lines up with CTRL's, as asked.
    expect(shift.x).toBeCloseTo(ctrl.x, 0);
    // SHIFT is narrower than it was, and RETURN is narrower too.
    expect(shift.width).toBeCloseTo(60.16, 0);
    expect(returnKey.width).toBeCloseTo(65.68, 0);
  });

  it('aligns the bottom row with the caps above it', () => {
    const placed = placeOricKeys();
    const box = (main: string) => placed.find(({ key }) => key.main === main)!.box;
    const left = box('\u2190');
    const down = box('\u2193');
    const shift = box('SHIFT');
    const z = box('Z');
    const x = box('X');
    const space = placed.find(({ key }) => key.id === 'space')!.box;

    // ↓ sits directly below Z.
    expect(down.x).toBeCloseTo(z.x, 5);
    // ← is right-aligned with the left SHIFT's right edge.
    expect(left.x + left.width).toBeCloseTo(shift.x + shift.width, 0);
    // The space bar starts at X's left edge.
    expect(space.x).toBeCloseTo(x.x, 5);
    // FUNCT is a single cap.
    expect(box('FUNCT').width).toBeCloseTo(39, 0);
  });

  it('gives every control cap a matrix cell', () => {
    // A cap with no cell is inert: it lights under the pointer and reaches
    // nothing. Only genuinely unwired caps may be cell-less, and on the Atmos
    // there are none.
    for (const key of ORIC_DECK_KEYS) {
      expect(key.row, `${key.id} row`).toBeGreaterThanOrEqual(0);
      expect(key.col, `${key.id} col`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe.runIf(hasRom(ATMOS_ROM))('oric sound', () => {
  it('writes the AY through the VIA when the ROM runs PING', () => {
    const m = boot();
    try {
      // PING is the ROM's own tone-generator command: four rising notes.
      m.typeText('PING\n');
      for (let i = 0; i < 900; i++) m.tick();

      // The ROM reached the PSG: the mixer enabled a channel and a volume is
      // set. A zero mixer or all-zero volumes would mean the VIA-port-A
      // protocol never got through.
      const regs = m.psg.ay.getRegisters();
      expect(regs[7], 'the PSG mixer').not.toBe(0);
      expect(regs[8] | regs[9] | regs[10], 'a channel volume').not.toBe(0);
      // And the machine agrees something is sounding.
      expect(m.psg.sounding).toBe(true);
    } finally {
      m.destroy();
    }
  });

  it('produces non-silent samples while a tone is playing', () => {
    const m = boot();
    try {
      m.typeText('PING\n');
      // Sample the AY on the way to the mixer, during the first note.
      const ay = m.psg.ay;
      const levels: number[] = [];
      const original = ay.generateSampleStereo.bind(ay);
      ay.generateSampleStereo = () => {
        const sample = original();
        levels.push(sample.left);
        return sample;
      };
      for (let i = 0; i < 200; i++) m.tick();
      ay.generateSampleStereo = original;

      expect(levels.length).toBeGreaterThan(0);
      // A working tone swings across its range; all-zero means silence, and a
      // single distinct value means a stuck DC level rather than a waveform.
      const peak = Math.max(...levels.map(Math.abs));
      expect(peak).toBeGreaterThan(0.01);
      expect(new Set(levels.map(v => v.toFixed(3))).size).toBeGreaterThan(2);
    } finally {
      m.destroy();
    }
  });

  it('applies the master volume so the mixer gain follows the setting', () => {
    const m = boot();
    try {
      m.applySettings({
        get: <T,>(key: string, fallback: T): T => (key === 'volume' ? 50 as T : fallback),
      });
      // A single sound device means `soundDeviceGains` returns unity and the
      // PSG rides the master volume, which is why the descriptor names
      // `beeper-volume` for it.
      expect(m.mixer.ayGain).toBe(1);
      expect(m.mixer.beeperGain).toBe(0);
    } finally {
      m.destroy();
    }
  });
});

describe.runIf(hasRom(ATMOS_ROM))('oric save menu', () => {
  it('can dump the whole address space', () => {
    const m = boot();
    try {
      const dump = m.ramExportBytes();
      expect(dump.data).toHaveLength(0x10000);
      expect(dump.filename).toBe('oric-ram.bin');
    } finally {
      m.destroy();
    }
  });

  it('offers no Spectrum .scr, and does not claim to', () => {
    const m = boot();
    try {
      // `.scr` is a Spectrum bitmap+attribute layout; a flat text screen has no
      // such thing, so the menu must not offer it.
      expect(m.descriptor.ui.saveMenu).not.toContain('screen-scr');
      expect(m.descriptor.ui.saveMenu).toContain('screenshot-png');
      expect(m.descriptor.ui.saveMenu).toContain('ram-bin');
      // The text screen is a plain 40x28 block inside the RAM dump.
      expect(m.memory.ram.subarray(ORIC_TEXT_SCREEN, ORIC_TEXT_SCREEN + ORIC_TEXT_COLS * 28))
        .toHaveLength(ORIC_TEXT_COLS * 28);
    } finally {
      m.destroy();
    }
  });
});
