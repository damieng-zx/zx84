/**
 * The cassette transport as the machine sees it.
 *
 * The Lynx has a real motor relay on port 0x80, so unlike the CPC nothing has
 * to be inferred from read cadence: the deck runs when the ROM spins the motor
 * and stops when it does not. These hold that wiring, and the bit encoding the
 * ROM's timing loop depends on.
 */

import { describe, expect, it } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import type { LynxModel } from '@/machines/lynx/models.ts';

/** A minimal one-entry tape: "AB" as a machine-code file. */
function tapeBytes(): Uint8Array {
  const name = [0x22, 0x41, 0x42, 0x22];
  const data = [0x4d, 0x02, 0x00, 0x11, 0x22, ...new Array(7).fill(0)];
  return Uint8Array.from([...name, ...data]);
}

function machine(model: LynxModel = 'lynx48'): LynxMachine {
  const m = new LynxMachine(model, null);
  m.loadROM(new Uint8Array(0x4000));
  m.reset();
  return m;
}

/** The motor bit, which moves between boards. */
function motorOn(m: LynxMachine, on: boolean): void {
  m.cpu.portOut(0x0080, on ? (m.memory.is128k ? 0x08 : 0x02) : 0x00);
}

/** Read the cassette line the way the ROM does, `t` T-states from now. */
function sampleAt(m: LynxMachine, t: number): number {
  m.cpu.tStates += t;
  return m.cpu.portIn(0x0080) & 1;
}

describe('Lynx cassette', () => {
  it('mounts a tape paused at the start, as a deck with the motor off', () => {
    const m = machine();
    expect(m.services.tape.mount(tapeBytes(), 'test.tap')).toBe(true);
    expect(m.services.tape.loaded).toBe(true);
    expect(m.services.tape.name).toBe('test.tap');
    expect(m.services.tape.paused).toBe(true);
    expect(m.services.tape.position).toBe(0);
    expect(m.services.tape.entries[0].name).toBe('AB');
  });

  it('runs the tape only while the motor is on', () => {
    const m = machine();
    m.services.tape.mount(tapeBytes(), 'test.tap');
    expect(m.tapeMotorOn).toBe(false);
    expect(m.services.tape.paused).toBe(true);

    motorOn(m, true);
    expect(m.tapeMotorOn).toBe(true);
    expect(m.services.tape.paused).toBe(false);

    motorOn(m, false);
    expect(m.services.tape.paused).toBe(true);
  });

  it('moves the motor bit on the 128K', () => {
    const m = machine('lynx128');
    m.services.tape.mount(tapeBytes(), 'test.tap');
    m.cpu.portOut(0x0080, 0x02);          // the 48K's motor bit
    expect(m.services.tape.paused).toBe(true);
    m.cpu.portOut(0x0080, 0x08);
    expect(m.services.tape.paused).toBe(false);
  });

  it('toggles the cassette line as the leader plays', () => {
    const m = machine();
    m.services.tape.mount(tapeBytes(), 'test.tap');
    motorOn(m, true);

    // The leader is zero bytes: every bit a 0, one half-cycle every 2 samples
    // of 4kHz, which is 2000 T-states at 4MHz. Sampling each half-cycle should
    // alternate; sampling a whole cycle apart should not.
    const a = sampleAt(m, 0);
    const b = sampleAt(m, 2000);
    const c = sampleAt(m, 2000);
    expect(b).not.toBe(a);
    expect(c).toBe(a);
  });

  it('holds the line still while the motor is off', () => {
    const m = machine();
    m.services.tape.mount(tapeBytes(), 'test.tap');
    const levels = [sampleAt(m, 0), sampleAt(m, 4000), sampleAt(m, 4000)];
    expect(new Set(levels).size).toBe(1);
  });

  it('ejects back to an empty deck', () => {
    const m = machine();
    m.services.tape.mount(tapeBytes(), 'test.tap');
    m.services.tape.eject();
    expect(m.services.tape.loaded).toBe(false);
    expect(m.services.tape.name).toBe('');
    expect(m.services.tape.entries).toEqual([]);
  });

  it('mounts through the media service, and says how to load it', async () => {
    const m = machine();
    const result = await m.services.media.mount(tapeBytes(), 'game.tap');
    expect(result.ok).toBe(true);
    expect(result.target).toBe('tape');
    expect(result.message).toContain('MLOAD "AB"');
  });

  it('refuses a ZX Spectrum .tap rather than playing noise at the ROM', async () => {
    const m = machine();
    const spectrum = Uint8Array.from([0x13, 0x00, 0x00, 0x00, 0x50, 0x52, 0x4f]);
    const result = await m.services.media.mount(spectrum, 'speccy.tap');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ZX Spectrum');
  });

  it('survives the stash and restore a model switch goes through', () => {
    const m = machine();
    m.services.tape.mount(tapeBytes(), 'test.tap');
    const state = m.services.tape.stashState();
    expect(state).not.toBeNull();

    const fresh = machine();
    fresh.services.tape.restoreStash(state!, 'test.tap');
    expect(fresh.services.tape.loaded).toBe(true);
    expect(fresh.services.tape.name).toBe('test.tap');
  });
});
