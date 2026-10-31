/**
 * zx84's native Apple I snapshot (`.a1state`): the container's checks, and
 * that a restore is exact with the terminal printing (its busy time running),
 * a key latched in the PIA and the Apple Cassette Interface reading a tape and
 * toggling its output.
 *
 * The firmware is a synthetic 256-byte PROM (assembled below), so no Woz
 * Monitor is needed.
 */

import { describe, it, expect } from 'vitest';
import { Apple1Machine } from '@/machines/apple1/apple1-machine.ts';
import { APPLE1_STATE_SPEC } from '@/machines/apple1/snapshots/apple1-state.ts';
import { decodeNativeState } from '@/machines/shared/native-state.ts';
import {
  Asm, OP, expectExactFromFile, expectRefusedUntouched, fingerprint, trace,
} from './native-state-helpers.ts';

const EXT = '.a1state';
const KBD = 0xD010, KBDCR = 0xD011, DSP = 0xD012, DSPCR = 0xD013;

/** Zero page: $00 characters printed, $01 the tape input, $02 the last key. */
function firmware(): Uint8Array {
  const a = new Asm(0xFF00);
  a.label('reset').b(OP.CLD, OP.LDX_IMM, 0xFF, OP.TXS);
  a.b(OP.LDY_IMM, 0x7F).abs(0x8C /* STY abs */, DSP);
  a.b(OP.LDA_IMM, 0xA7).abs(OP.STA_ABS, KBDCR).abs(OP.STA_ABS, DSPCR);
  a.label('loop').abs(0x2C /* BIT abs */, DSP).br(OP.BMI, 'nodsp');
  a.b(OP.LDA_ZP, 0x00, OP.AND_IMM, 0x3F, OP.ORA_IMM, 0x20).abs(OP.STA_ABS, DSP).b(OP.INC_ZP, 0x00);
  a.label('nodsp').abs(OP.LDA_ABS, 0xC081).b(OP.STA_ZP, 0x01);    // ACI: tape in, toggles the output
  a.abs(OP.LDA_ABS, KBDCR).br(OP.BPL, 'loop');
  a.abs(OP.LDA_ABS, KBD).b(OP.STA_ZP, 0x02).abs(OP.JMP, 'loop');
  const rom = new Uint8Array(0x100);
  rom.set(a.assemble(), 0);
  rom[0xFC] = a.addr('reset') & 0xFF;
  rom[0xFD] = a.addr('reset') >> 8;
  return rom;
}

/** An 8-bit mono WAVE of a square wave whose period changes as it goes. */
function wav(): Uint8Array {
  const rate = 22050;
  const samples = new Uint8Array(rate * 4);
  let level = 1;
  let left = 5;
  let period = 5;
  for (let i = 0; i < samples.length; i++) {
    samples[i] = level ? 0xE0 : 0x20;
    if (--left === 0) { level ^= 1; period = 4 + ((i >> 9) & 7); left = period; }
  }
  const out = new Uint8Array(44 + samples.length);
  const v = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); v.setUint32(4, 36 + samples.length, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20], 8);
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36); v.setUint32(40, samples.length, true);
  out.set(samples, 44);
  return out;
}

function machine(aci = true, ramKb = '8k'): Apple1Machine {
  const m = new Apple1Machine('apple1', null);
  m.prepare({
    get: <T>(key: string, fallback: T): T =>
      (key === 'apple1-aci' ? aci as T : key === 'apple1-ram' ? ramKb as T : fallback),
  });
  m.loadROM(firmware());
  m.reset();
  m.setSpeedMultiplier(0);
  return m;
}

describe('Apple I snapshot', () => {
  it('names the model and says whether the media is inside', async () => {
    const m = machine();
    try {
      m.tick();
      const file = await decodeNativeState(APPLE1_STATE_SPEC, await m.services.snapshots.save(EXT));
      expect(file.info.model).toBe('apple1');
      expect(file.info.media).toBe(true);
      expect(m.services.media.accepts().some(t => t.ext === EXT)).toBe(true);
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-a1state');
    } finally {
      m.destroy();
    }
  });

  it('refuses a damaged file and leaves the machine as it was', async () => {
    const m = machine();
    try {
      for (let f = 0; f < 5; f++) m.tick();
      const file = await m.services.snapshots.save(EXT);
      for (let f = 0; f < 3; f++) m.tick();
      await expectRefusedUntouched(m, file, EXT);
    } finally {
      m.destroy();
    }
  });

  it('refuses a state saved with other memory fitted', async () => {
    const m = machine(true, '8k');
    const other = machine(true, '16k');
    try {
      for (let f = 0; f < 5; f++) m.tick();
      other.tick();
      const before = fingerprint(other, false);
      const r = await other.services.snapshots.apply(await m.services.snapshots.save(EXT), `x${EXT}`);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/8K.*16K/);
      expect(fingerprint(other, false)).toBe(before);
    } finally {
      m.destroy();
      other.destroy();
    }
  });

  it('is exact with the terminal printing, a key latched and the tape playing', async () => {
    const m = machine();
    const fresh = machine();
    try {
      expect(m.services.tape!.mountWav(wav(), 'tape.wav')).toBe(true);
      m.services.tape!.play();
      for (let f = 0; f < 20; f++) m.tick();
      m.keyboard.press(0x41);
      for (let f = 0; f < 9; f++) m.tick();
      expect(m.memory.ram[0x00], 'characters have been printed').toBeGreaterThan(0);
      expect(m.memory.ram[0x02], 'the key was read').toBe(0xC1);
      expect(m.tapeRecorder.count, 'the cassette output has toggled').toBeGreaterThan(0);
      await expectExactFromFile(m, fresh, EXT, 40);
      expect(fresh.terminal.lines()).toEqual(m.terminal.lines());
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });

  it('resumes after a browser refresh', async () => {
    const m = machine();
    const fresh = machine();
    try {
      for (let f = 0; f < 23; f++) m.tick();
      const sync = m.services.snapshots.saveSync();
      const original = trace(m, 30);
      for (let f = 0; f < 4; f++) fresh.tick();
      expect(await fresh.services.snapshots.restoreSync(sync)).toBe(true);
      expect(trace(fresh, 30)).toEqual(original);
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });
});
