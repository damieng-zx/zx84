/**
 * The on-screen keyboard: its caps cover the whole matrix once each and sit
 * inside the scene without overlapping, and pressing them does to the machine
 * what the host keyboard would.
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { C64_MATRIX } from '@/machines/c64/keyboard.ts';
import { C64_KEYBOARD_SCENE, C64_KEYS, type C64KeyDef } from '@/machines/c64/ui/keyboard/layout.ts';
import { C64OnScreenKeys } from '@/machines/c64/ui/keyboard/pad.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

const cap = (id: string): C64KeyDef => {
  const key = C64_KEYS.find(k => k.id === id);
  if (!key) throw new Error(`no cap ${id}`);
  return key;
};

describe('C64 keyboard layout', () => {
  it('has a cap for every matrix key exactly once, plus RESTORE and SHIFT LOCK', () => {
    const matrix = C64_MATRIX.flat();
    const named = C64_KEYS.filter(k => k.name !== undefined).map(k => k.name);
    expect([...named].sort()).toEqual([...matrix].sort());
    expect(C64_KEYS.filter(k => k.action === 'restore')).toHaveLength(1);
    expect(C64_KEYS.filter(k => k.action === 'shift-lock')).toHaveLength(1);
    expect(C64_KEYS).toHaveLength(66);
    expect(new Set(C64_KEYS.map(k => k.id)).size).toBe(C64_KEYS.length);
  });

  it('keeps every cap inside the scene, clear of its neighbours', () => {
    const { width, height } = C64_KEYBOARD_SCENE;
    for (const k of C64_KEYS) {
      expect(k.box.x, k.id).toBeGreaterThanOrEqual(0);
      expect(k.box.y, k.id).toBeGreaterThanOrEqual(0);
      expect(k.box.x + k.box.width, k.id).toBeLessThanOrEqual(width);
      expect(k.box.y + k.box.height, k.id).toBeLessThanOrEqual(height);
    }
    for (let i = 0; i < C64_KEYS.length; i++) {
      for (let j = i + 1; j < C64_KEYS.length; j++) {
        const a = C64_KEYS[i].box, b = C64_KEYS[j].box;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${C64_KEYS[i].id} and ${C64_KEYS[j].id}`).toBe(true);
      }
    }
  });

  it('prints what SHIFT types on the keys where it matters', () => {
    expect(cap('2').shift).toBe('"');
    expect(cap(':').shift).toBe('[');
    expect(cap('arrow-up').shift).toBe('π');
    expect(cap('f1').front).toBe('f2');
    // 0 is set like the other digits, with nothing printed above it.
    expect(cap('0').shift?.trim()).toBe('');
    expect(cap('0').shift).toBeDefined();
    // The cursor keys print their pair of arrows one above the other.
    expect([cap('crsr-ud').shift, cap('crsr-ud').main]).toEqual(['↑', '↓']);
    expect([cap('crsr-lr').shift, cap('crsr-lr').main]).toEqual(['←', '→']);
  });

  it('is laid out as the machine is: staggered rows, flush right, wide RESTORE and function keys', () => {
    const right = (id: string): number => cap(id).box.x + cap(id).box.width;
    // The digit and CTRL rows start in from the RUN/STOP and C= rows; all four end together.
    expect(cap('arrow-left').box.x).toBe(cap('ctrl').box.x);
    expect(cap('arrow-left').box.x).toBeGreaterThan(cap('cbm').box.x);
    // RUN/STOP and C= start together, SHIFT LOCK is one key wide.
    expect(cap('stop').box.x).toBe(cap('cbm').box.x);
    expect(cap('shift-lock').box.width).toBe(cap('q').box.width);
    expect(cap('a').box.x).toBe(cap('shift-lock').box.x + cap('shift-lock').box.width);
    const edge = right('del');
    expect(right('restore')).toBe(edge);
    // RETURN is two keys wide and, with the cursor keys, ends a quarter key short of RESTORE.
    expect(right('return')).toBe(right('crsr-lr'));
    expect(edge - right('return')).toBe(10);
    // The bottom row has its shifts a key and a half wide, the cursor keys right after the right shift.
    expect(cap('lshift').box.width).toBe(cap('rshift').box.width);
    expect(cap('lshift').box.width).toBe(1.5 * cap('q').box.width);
    expect(cap('crsr-ud').box.x).toBe(right('rshift'));
    expect(cap('crsr-lr').box.x).toBe(right('crsr-ud'));
    // The Z row sits half a key right of the A row.
    expect(cap('z').box.x).toBe(cap('a').box.x + 20);
    // RESTORE and RETURN are wider than a plain key; the function keys are two keys wide.
    expect(cap('restore').box.width).toBeGreaterThan(cap('q').box.width);
    expect(cap('return').box.width).toBe(2 * cap('q').box.width);
    for (const id of ['f1', 'f3', 'f5', 'f7']) expect(cap(id).box.width, id).toBe(2 * cap('q').box.width);
    expect(cap('f1').box.x).toBeGreaterThan(edge);
    // The function keys are grey and level with the rows beside them.
    for (const id of ['f1', 'f3', 'f5', 'f7']) expect(cap(id).grey, id).toBe(true);
    expect(cap('f1').grey && cap('q').grey).toBeFalsy();
    expect(cap('f1').box.y).toBe(cap('arrow-left').box.y);
    expect(cap('f3').box.y).toBe(cap('ctrl').box.y);
    expect(cap('f5').box.y).toBe(cap('stop').box.y);
    expect(cap('f7').box.y).toBe(cap('cbm').box.y);
    // Neighbouring caps touch, and the case shows above the top row and below the space bar.
    expect(cap('1').box.x).toBe(cap('arrow-left').box.x + cap('arrow-left').box.width);
    expect(cap('arrow-left').box.y).toBeGreaterThan(0);
    const left = Math.min(...C64_KEYS.map(k => k.box.x));
    const rightmost = Math.max(...C64_KEYS.map(k => k.box.x + k.box.width));
    expect(left).toBe(cap('arrow-left').box.y);
    expect(C64_KEYBOARD_SCENE.width - rightmost).toBe(left);
    expect(C64_KEYBOARD_SCENE.height - (cap('space').box.y + cap('space').box.height)).toBe(cap('arrow-left').box.y);
    // The space bar sits under the letters, not under the whole row.
    expect(cap('space').box.x).toBeGreaterThan(cap('lshift').box.x);
    expect(cap('space').box.y).toBeGreaterThan(cap('z').box.y);
    // It ends where the / key starts.
    expect(cap('space').box.x + cap('space').box.width).toBe(cap('/').box.x);
  });
});

describe('pressing the caps', () => {
  function pad(): { m: C64Machine; pad: C64OnScreenKeys } {
    const m = new C64Machine('c64', null);
    return { m, pad: new C64OnScreenKeys(m.keyboard) };
  }

  it('holds a key while the pointer is down, and lights it', () => {
    const { m, pad: p } = pad();
    p.press(cap('a'));
    expect(m.keyboard.isPressed('a')).toBe(true);
    expect(p.lit(cap('a'))).toBe(true);
    p.release(cap('a'));
    expect(m.keyboard.isPressed('a')).toBe(false);
    expect(p.lit(cap('a'))).toBe(false);
    m.destroy();
  });

  it('latches SHIFT for the next keystroke and then lets it go', () => {
    const { m, pad: p } = pad();
    p.press(cap('lshift'));
    p.release(cap('lshift'));                       // a click: still down
    expect(m.keyboard.isPressed('lshift')).toBe(true);
    p.press(cap('return'));
    expect(m.keyboard.isPressed('return') && m.keyboard.isPressed('lshift')).toBe(true);
    p.release(cap('return'));
    expect(m.keyboard.isPressed('lshift')).toBe(false);
    m.destroy();
  });

  it('un-latches a modifier clicked twice', () => {
    const { m, pad: p } = pad();
    p.press(cap('ctrl'));
    p.press(cap('ctrl'));
    expect(m.keyboard.isPressed('ctrl')).toBe(false);
    m.destroy();
  });

  it('keeps SHIFT LOCK down until it is clicked again, whatever is typed', () => {
    const { m, pad: p } = pad();
    p.press(cap('shift-lock'));
    expect(p.lit(cap('shift-lock'))).toBe(true);
    p.press(cap('a')); p.release(cap('a'));
    expect(m.keyboard.isPressed('lshift')).toBe(true);
    p.press(cap('shift-lock'));
    expect(m.keyboard.isPressed('lshift')).toBe(false);
    m.destroy();
  });

  it('does not let a cap and the host keyboard release each other\'s SHIFT', () => {
    const { m, pad: p } = pad();
    p.press(cap('shift-lock'));
    m.services.input.keyDown({ code: 'Digit2', key: '"', shift: true, ctrl: false, alt: false });
    m.services.input.keyUp({ code: 'Digit2', key: '"', shift: true, ctrl: false, alt: false });
    expect(m.keyboard.isPressed('lshift')).toBe(true);
    m.destroy();
  });

  it('pulls RESTORE only while it is held', () => {
    const { m, pad: p } = pad();
    p.press(cap('restore'));
    expect(m.keyboard.restore).toBe(true);
    expect(p.lit(cap('restore'))).toBe(true);
    p.release(cap('restore'));
    expect(m.keyboard.restore).toBe(false);
    m.destroy();
  });

  it('lights a cap for a key typed on the host keyboard', () => {
    const { m, pad: p } = pad();
    m.services.input.keyDown({ code: 'KeyQ', key: 'q', shift: false, ctrl: false, alt: false });
    expect(p.lit(cap('q'))).toBe(true);
    m.destroy();
  });

  it('lets go of everything when the pane goes away', () => {
    const { m, pad: p } = pad();
    p.press(cap('shift-lock'));
    p.press(cap('ctrl'));
    p.press(cap('a'));
    p.press(cap('restore'));
    p.releaseAll();
    for (const name of ['lshift', 'ctrl', 'a']) expect(m.keyboard.isPressed(name)).toBe(false);
    expect(m.keyboard.restore).toBe(false);
    m.destroy();
  });
});

const basic = romImage('basic-901226-01.rom');
const kernal = romImage('kernal-901227-03.rom');
const chargen = romImage('chargen-901225-01.rom');

describe.skipIf(!basic || !kernal || !chargen)('typing on the caps with the real KERNAL', () => {
  it('types SHIFT+2 as a quote and runs a line', () => {
    const rom = new Uint8Array(0x5000);
    rom.set(basic!, 0);
    rom.set(kernal!, 0x2000);
    rom.set(chargen!, 0x4000);
    const m = new C64Machine('c64', null);
    m.loadROM(rom);
    m.reset();
    for (let f = 0; f < 150; f++) m.tick();
    const p = new C64OnScreenKeys(m.keyboard);
    const tap = (id: string): void => {
      p.press(cap(id));
      for (let f = 0; f < 4; f++) m.tick();
      p.release(cap(id));
      for (let f = 0; f < 4; f++) m.tick();
    };
    for (const id of ['1', '0']) tap(id);
    tap('space');
    for (const id of ['p', 'r', 'i', 'n', 't']) tap(id);
    tap('lshift'); tap('2');                         // SHIFT+2: "
    for (const id of ['h', 'i']) tap(id);
    tap('lshift'); tap('2');
    tap('return');
    for (const id of ['r', 'u', 'n']) tap(id);
    tap('return');
    for (let f = 0; f < 60; f++) m.tick();
    expect(m.ocrScreenForMcp()).toMatch(/HI\s*\n\s*READY\./);
    m.destroy();
  });
});
