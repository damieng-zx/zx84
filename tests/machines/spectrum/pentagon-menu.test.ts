/**
 * The Pentagon's "TR-DOS" menu entry, added to the Sinclair 128K ROM at load.
 *
 * A real Pentagon ROM shows the same five-item menu with TR-DOS last; the menu
 * is the Sinclair one with "Tape Tester" replaced. The entry must do what typing
 * RANDOMIZE USR 15616 does: page TR-DOS in. The ROM-backed case needs the images
 * under mcp/.cache/ (not redistributable) and is skipped when absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { withTrdosMenuEntry } from '@/machines/spectrum/pentagon-menu.ts';
import { blankTrdDisk } from '@/media/floppy/trd-image.ts';

const CACHE = resolve(__dirname, '../../../mcp/.cache');
const have = (names: string[]): boolean => names.every((n) => existsSync(resolve(CACHE, n)));

/** The two Sinclair 128K pages: the image zx84 hosts. */
function sinclair128(): Uint8Array {
  const rom = new Uint8Array(32768);
  rom.set(readFileSync(resolve(CACHE, '128-0.rom')), 0);
  rom.set(readFileSync(resolve(CACHE, '128-1.rom')), 16384);
  return rom;
}

const ascii = (rom: Uint8Array, at: number, n: number): string =>
  String.fromCharCode(...rom.subarray(at, at + n).map((b) => b & 0x7F));

describe('withTrdosMenuEntry', () => {
  it('leaves a ROM that is not the stock Sinclair 128K pair untouched, returning the same buffer', () => {
    const blank = new Uint8Array(32768);
    expect(withTrdosMenuEntry(blank)).toBe(blank);
    const short = new Uint8Array(16384);
    expect(withTrdosMenuEntry(short)).toBe(short);
  });

  describe.skipIf(!have(['128-0.rom', '128-1.rom']))('on the Sinclair 128K ROMs', () => {
    it('renames the fifth menu entry, in the same width with the terminator bit on its last letter', () => {
      const rom = sinclair128();
      expect(ascii(rom, 0x2784, 11)).toBe('Tape Tester');
      const out = withTrdosMenuEntry(rom);
      expect(ascii(out, 0x2784, 11)).toBe('TR-DOS     ');
      expect(out[0x2789]).toBe(0xD3);                 // 'S' | 0x80 ends the string
    });

    it('changes only the entry text and the old Tape Tester body, and not its input', () => {
      const rom = sinclair128();
      const before = rom.slice();
      const out = withTrdosMenuEntry(rom);
      expect(rom).toEqual(before);                    // the caller's buffer is not modified
      const changed: number[] = [];
      for (let i = 0; i < out.length; i++) if (out[i] !== rom[i]) changed.push(i);
      expect(changed.length).toBeGreaterThan(0);
      for (const at of changed) {
        const inText = at >= 0x2784 && at < 0x2784 + 11;
        const inBody = at >= 0x3BE9 && at < 0x3C56;   // Tape Tester, ahead of the shared EI/HALT at 0x3C56
        expect(inText || inBody).toBe(true);
      }
      // Page 1 (the 48K BASIC ROM) is untouched.
      expect(out.subarray(16384)).toEqual(rom.subarray(16384));
    });

    it('is applied once: a ROM that already has the entry comes back as it is', () => {
      const once = withTrdosMenuEntry(sinclair128());
      expect(withTrdosMenuEntry(once)).toBe(once);
    });

    it('is only applied to the Pentagons: other 128K machines keep Tape Tester', () => {
      const rom = sinclair128();
      const pentagon = new Spectrum('pentagon128', null);
      pentagon.loadROM(rom);
      expect(ascii(pentagon.memory.romPages[0], 0x2784, 6)).toBe('TR-DOS');
      const sinclair = new Spectrum('zx128k', null);
      sinclair.loadROM(rom);
      expect(ascii(sinclair.memory.romPages[0], 0x2784, 11)).toBe('Tape Tester');
    });
  });
});

describe.skipIf(!have(['128-0.rom', '128-1.rom', 'trdos.rom']))('TR-DOS menu entry on the Pentagon', () => {
  const FRAME_HOLD = 5;
  const CAPS: [number, number] = [0, 0], SIX: [number, number] = [4, 4], ENTER: [number, number] = [6, 0];

  function press(s: Spectrum, keys: [number, number][], frames: number): void {
    for (const [r, b] of keys) s.keyboard.setKey(r, b, true);
    for (let f = 0; f < frames; f++) s.runUntil(1);
    for (const [r, b] of keys) s.keyboard.setKey(r, b, false);
  }

  it('selects TR-DOS with cursor-down x4 + ENTER, which enters TR-DOS and returns to BASIC', () => {
    const s = new Spectrum('pentagon128', null);
    s.loadROM(sinclair128());
    s.betaDisk.loadROM(new Uint8Array(readFileSync(resolve(CACHE, 'trdos.rom'))));
    s.betaDisk.enabled = true;
    s.loadBetaDiskDisk(blankTrdDisk(80, 2), 0);
    s.reset();
    let pageIns = 0;
    const pageIn = s.betaDisk.pageIn.bind(s.betaDisk);
    s.betaDisk.pageIn = (m) => { if (!s.betaDisk.pagedIn) pageIns++; pageIn(m); };

    for (let f = 0; f < 120; f++) s.runUntil(1);                 // let the menu draw
    for (let i = 0; i < 4; i++) { press(s, [CAPS, SIX], FRAME_HOLD); for (let f = 0; f < 15; f++) s.runUntil(1); }
    expect(pageIns).toBe(0);                                      // nothing chosen yet
    press(s, [ENTER], FRAME_HOLD);
    for (let f = 0; f < 300; f++) s.runUntil(1);
    expect(pageIns).toBeGreaterThanOrEqual(1);                    // USR 15616 reached TR-DOS
  });
});
