/**
 * The `InputService.charDown` character-level typing entry, checked against the
 * machines whose keyboard legends differ from a PC's.
 *
 * The bug this pins down: the MCP `type` tool used to resolve every printable
 * symbol through the Spectrum's SYM SHIFT chords, so `LOAD "INDEX"` became
 * `LOAD PINDEXP` on an Atom and `PRINT "A"` became `PRINT A` on a BBC. A
 * character-intent machine must be handed the character, not a host symbol key.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AtomMachine } from '@/machines/atom/atom-machine.ts';
import { AtomInputService } from '@/machines/atom/services/input.ts';
import { BbcInputService } from '@/machines/bbc/services/input.ts';
import { OricInputService } from '@/machines/oric/services/input.ts';
import { SpectrumInputService } from '@/machines/spectrum/services/input.ts';
import type { Machine } from '@/machines/machine.ts';

const CACHE = join(process.cwd(), 'mcp', '.cache');
const have = (f: string): boolean => existsSync(join(CACHE, f));

/** The three Atom system chips, concatenated in `romSources` order. */
const ATOM_ROMS = ['acorn/atom-basic.rom', 'acorn/atom-float.rom', 'acorn/atom-kernel.rom'];

const key = (code: string, k: string): { code: string; key: string; shift: boolean; ctrl: boolean; alt: boolean } =>
  ({ code, key: k, shift: false, ctrl: false, alt: false });

/** Drive `char` down and up once, with a frame either side, as `type` does. */
function typeOnce(m: Machine, char: string): boolean {
  const input = m.services.input;
  if (!input.charDown) throw new Error(`${m.kind} has no charDown`);
  const pressed = input.charDown(char);
  for (let i = 0; i < 5; i++) m.tick();
  input.charUp!(char);
  for (let i = 0; i < 6; i++) m.tick();
  return pressed;
}

function pressEnter(m: Machine): void {
  const input = m.services.input;
  input.keyDown(key('Enter', 'Enter'));
  for (let i = 0; i < 6; i++) m.tick();
  input.keyUp(key('Enter', 'Enter'));
  for (let i = 0; i < 30; i++) m.tick();
}

const atomRoms = (): Uint8Array => {
  const data = new Uint8Array(0x3000);
  ATOM_ROMS.forEach((f, i) => data.set(readFileSync(join(CACHE, f)), i * 0x1000));
  return data;
};

const haveAtom = ATOM_ROMS.every(have);

(haveAtom ? describe : describe.skip)('charDown on the Atom', () => {
  it('presses the shifted symbol of its own legend, not a PC key', () => {
    const m = new AtomMachine('atom', null);
    try {
      m.loadROM(atomRoms());
      m.reset();
      for (let i = 0; i < 120; i++) m.tick();
      // `"` lives on the Atom's SHIFT+2 cell. The old broken path handed the
      // machine a host Digit2-with-shift event, landing it on `2`; charDown
      // must assert the Atom's own SHIFT line and press that cell.
      expect(m.services.input.charDown!('"')).toBe(true);
      expect(m.keyboard.shiftHeld).toBe(true);
      // Row 1 (the `2` row), column 1; SHIFT is port B bit 7.
      expect(m.keyboard.readRow(1)).toBe(0x7D);
    } finally {
      m.destroy();
    }
  });

  it('echoes a whole PRINT line including its quotes', () => {
    const m = new AtomMachine('atom', null);
    try {
      m.loadROM(atomRoms());
      m.reset();
      for (let i = 0; i < 120; i++) m.tick();
      for (const ch of 'PRINT "HI"') typeOnce(m, ch);
      pressEnter(m);
      for (let i = 0; i < 60; i++) m.tick();
      const screen = m.ocrScreenForMcp();
      expect(screen).toContain('PRINT "HI"');
      expect(screen).toContain('HI');
    } finally {
      m.destroy();
    }
  });
});

describe('charDown coverage by kind', () => {
  /**
   * A machine whose legend is not a PC's must expose the character-level entry.
   * The Spectrum is deliberately not listed: it really does have SYM SHIFT
   * chords, and its `type` path keeps resolving characters through them.
   * Constructing the services directly keeps this a pure capability check,
   * with no ROMs or boot needed.
   */
  it('is offered by the Atom, BBC and Oric input services', () => {
    const stub = { cancelPaste: () => {}, keyboardActivity: () => {}, keyboard: null as never };
    expect(typeof new AtomInputService(stub as never).charDown).toBe('function');
    expect(typeof new BbcInputService(stub as never).charDown).toBe('function');
    expect(typeof new OricInputService(stub as never).charDown).toBe('function');
  });

  it('is absent on the Spectrum, which keeps its symbol-shift chords', () => {
    // The Spectrum's interface deliberately has no character entry, so the MCP
    // `type` tool keeps resolving symbols through its SYM SHIFT chords.
    expect('charDown' in new SpectrumInputService({ keyboard: null as never } as never)).toBe(false);
  });
});
