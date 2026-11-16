/**
 * The 128's on-screen keyboard: its caps cover the whole matrix once each,
 * sit inside the scene without overlapping, are laid out as the machine's are,
 * and pressing them does to the machine what the host keyboard would.
 */

import { describe, it, expect } from 'vitest';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { C128_MATRIX } from '@/machines/c128/keyboard.ts';
import {
  C128_KEYBOARD_SCENE, C128_KEYS, isLatch, type C128KeyDef, type C128MatrixDef,
} from '@/machines/c128/ui/keyboard/layout.ts';
import { CbmOnScreenKeys } from '@/machines/shared/ui/cbm-keyboard/pad.ts';

const cap = (id: string): C128KeyDef => {
  const key = C128_KEYS.find(k => k.id === id);
  if (!key) throw new Error(`no cap ${id}`);
  return key;
};
const matrixCap = (id: string): C128MatrixDef => {
  const key = cap(id);
  if (isLatch(key)) throw new Error(`${id} is a latch`);
  return key;
};
const right = (id: string): number => cap(id).box.x + cap(id).box.width;

describe('C128 keyboard layout', () => {
  it('has a cap for every matrix key exactly once, RESTORE, SHIFT LOCK and the two latching keys', () => {
    const matrix = C128_MATRIX.flat();
    const named = C128_KEYS.filter(k => !isLatch(k) && (k as C128MatrixDef).name !== undefined).map(k => (k as C128MatrixDef).name);
    expect([...named].sort()).toEqual([...matrix].sort());
    expect(C128_KEYS.filter(k => k.action === 'restore')).toHaveLength(1);
    expect(C128_KEYS.filter(k => k.action === 'shift-lock')).toHaveLength(1);
    expect(C128_KEYS.filter(isLatch).map(k => k.action).sort()).toEqual(['caps-lock', 'display-80']);
    expect(C128_KEYS).toHaveLength(92);
    expect(new Set(C128_KEYS.map(k => k.id)).size).toBe(C128_KEYS.length);
  });

  it('keeps every cap inside the scene, clear of its neighbours', () => {
    const { width, height } = C128_KEYBOARD_SCENE;
    for (const k of C128_KEYS) {
      expect(k.box.x, k.id).toBeGreaterThanOrEqual(0);
      expect(k.box.y, k.id).toBeGreaterThanOrEqual(0);
      expect(k.box.x + k.box.width, k.id).toBeLessThanOrEqual(width);
      expect(k.box.y + k.box.height, k.id).toBeLessThanOrEqual(height);
    }
    for (let i = 0; i < C128_KEYS.length; i++) {
      for (let j = i + 1; j < C128_KEYS.length; j++) {
        const a = C128_KEYS[i].box, b = C128_KEYS[j].box;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${C128_KEYS[i].id} and ${C128_KEYS[j].id}`).toBe(true);
      }
    }
  });

  it('is laid out as the machine is: four rows flush left and flush right, the extra keys above and beside', () => {
    // Every row of the main block starts and ends together.
    for (const id of ['arrow-left', 'ctrl', 'stop', 'cbm']) expect(cap(id).box.x, id).toBe(cap('arrow-left').box.x);
    for (const id of ['del', 'restore', 'return', 'crsr-lr']) expect(right(id), id).toBe(right('del'));
    // CONTROL and RESTORE are a key and a half, RETURN two.
    expect(cap('ctrl').box.width).toBeGreaterThan(cap('q').box.width);
    expect(cap('restore').box.width).toBe(cap('ctrl').box.width);
    expect(cap('return').box.width).toBeGreaterThan(cap('restore').box.width);
    // RUN/STOP and SHIFT LOCK are single keys, the A row starts after them.
    expect(cap('shift-lock').box.width).toBe(cap('a').box.width);
    expect(cap('a').box.x - right('shift-lock')).toBe(2);
    // The rows step in by half a key each: Q, A, Z.
    expect(cap('q').box.x).toBeGreaterThan(cap('1').box.x);
    expect(cap('z').box.x).toBeGreaterThan(cap('a').box.x);
    // The space bar sits under the Z row, from the X key to the end of the / key.
    expect(cap('space').box.x).toBe(cap('x').box.x);
    expect(right('space')).toBe(right('/'));
    expect(cap('space').box.y).toBeGreaterThan(cap('z').box.y);
    // The grey strip is above the main block; the function keys and keypad stand to its right.
    expect(cap('esc').box.y).toBeLessThan(cap('arrow-left').box.y);
    expect(cap('f1').box.x).toBeGreaterThan(right('del'));
    expect(cap('kp7').box.x).toBe(cap('f1').box.x);
    expect(cap('kp7').box.y).toBe(cap('arrow-left').box.y);
    // The keypad's ENTER is two keys tall, beside the 1 2 3 and 0 . rows.
    expect(cap('kp-enter').box.height).toBeGreaterThan(cap('kp3').box.height);
    expect(cap('kp-enter').box.y).toBe(cap('kp3').box.y);
    // And its 0 is two keys wide.
    expect(cap('kp0').box.width).toBeGreaterThan(cap('kp1').box.width);
  });

  it('orders the grey strip as the machine does', () => {
    const strip = C128_KEYS.filter(k => k.box.y === cap('esc').box.y).sort((a, b) => a.box.x - b.box.x).map(k => k.id);
    expect(strip).toEqual([
      'esc', 'tab', 'alt', 'caps-lock',
      'help', 'linefeed', 'display-80', 'no-scroll',
      'up', 'down', 'left', 'right',
      'f1', 'f3', 'f5', 'f7',
    ]);
  });

  it('prints what SHIFT types on the keys where it matters', () => {
    expect(matrixCap('2').shift).toBe('"');
    expect(matrixCap(':').shift).toBe('[');
    expect(matrixCap('f1').front).toBe('F2');
    expect(matrixCap('home').shift).toBe('CLR');
    expect(matrixCap('crsr-ud').lines).toEqual(['↑', 'CRSR', '↓']);
    expect(matrixCap('no-scroll').lines).toEqual(['NO', 'SCROLL']);
  });
});

const key = (id: string): C128MatrixDef => matrixCap(id);

describe('C128 on-screen keys on a machine', () => {
  it('press the extra lines the host keys do', () => {
    const m = new C128Machine(null);
    const pad = new CbmOnScreenKeys(m.keyboard);
    for (const id of ['esc', 'tab', 'alt', 'help', 'linefeed', 'no-scroll', 'up', 'down', 'left', 'right', 'kp7', 'kp-enter', 'kp.']) {
      pad.press(key(id));
      expect(m.keyboard.isPressed(id), id).toBe(true);
      expect(pad.lit(key(id)), id).toBe(true);
      pad.release(key(id));
      expect(m.keyboard.isPressed(id), id).toBe(false);
    }
  });

  it('latches CAPS LOCK and the 40/80 key in the keyboard', () => {
    const m = new C128Machine(null);
    m.keyboard.toggleCapsLock();
    m.keyboard.toggleDisplay80();
    expect([m.keyboard.capsLock, m.keyboard.display80]).toEqual([true, true]);
    m.keyboard.toggleCapsLock();
    expect(m.keyboard.capsLock).toBe(false);
  });
});
