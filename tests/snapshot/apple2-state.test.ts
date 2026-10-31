/**
 * zx84's native Apple II snapshot (`.a2state`): the container's checks, and
 * that a restore is exact on the ][+, //e and Enhanced //e with the Disk ][
 * reading, the Mockingboard's timer interrupt and AY, the language card, the
 * game port and the soft switches all in use when the state is taken.
 *
 * The firmware is synthetic (assembled below, no Apple ROM needed): it keeps
 * drawing into hi-res memory while it reads the data register of a spinning
 * disk, steps the head, flips PAGE2, writes the language card's RAM, starts
 * the paddle timers, toggles the speaker, the cassette output and an
 * annunciator, and programs the Mockingboard; on the //e it also writes the
 * auxiliary RAM.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import { APPLE2_STATE_SPEC } from '@/machines/apple2/snapshots/apple2-state.ts';
import { decodeNativeState } from '@/machines/shared/native-state.ts';
import type { Apple2Model } from '@/machines/apple2/models.ts';
import {
  Asm, OP, expectExactFromFile, expectRefusedUntouched, fingerprint, trace,
} from './native-state-helpers.ts';

const EXT = '.a2state';

/** Zero page: $70 timer interrupts, $71 loop count, $72/$73 hi-res pointer,
 *  $74 the last disk byte, $75 disk bytes, $76 a paddle timer, $77 the keyboard. */
function firmware(iie: boolean): Uint8Array {
  const a = new Asm(0xD000);
  const sta = (v: number, addr: number): void => { a.b(OP.LDA_IMM, v).abs(OP.STA_ABS, addr); };
  const touch = (addr: number): void => { a.abs(OP.LDA_ABS, addr); };
  a.label('reset').b(OP.SEI, OP.CLD, OP.LDX_IMM, 0xFF, OP.TXS);
  // Mockingboard in slot 4: VIA 1's T1 free-running, interrupting; port A/B to the AY.
  sta(0x40, 0xC40B);
  sta(0x00, 0xC404); sta(0x30, 0xC405);
  sta(0x7F, 0xC40E); sta(0xC0, 0xC40E);
  sta(0xFF, 0xC403); sta(0x07, 0xC402); sta(0x04, 0xC400);
  // Disk ][ in slot 6: motor on, drive 1, read mode.
  touch(0xC0E9); touch(0xC0EA); touch(0xC0EE); touch(0xC0EC);
  a.b(OP.LDA_IMM, 0x00, OP.STA_ZP, 0x70, OP.STA_ZP, 0x71, OP.STA_ZP, 0x72, OP.STA_ZP, 0x75);
  a.b(OP.LDA_IMM, 0x20, OP.STA_ZP, 0x73);
  touch(0xC050); touch(0xC052); touch(0xC057);          // full-screen hi-res
  touch(0xC081); touch(0xC081);                         // language card: read ROM, write RAM
  a.b(OP.CLI);

  a.label('loop').abs(OP.LDA_ABS, 0xC0EC).br(OP.BPL, 'nodisk')
    .b(OP.STA_ZP, 0x74, OP.INC_ZP, 0x75);
  a.label('nodisk').b(OP.LDY_IMM, 0x00, OP.LDA_ZP, 0x70, OP.EOR_ZP, 0x71, OP.STA_INDY, 0x72)
    .b(OP.INC_ZP, 0x72).br(OP.BNE, 'nohi')
    .b(OP.INC_ZP, 0x73, OP.LDA_ZP, 0x73, OP.CMP_IMM, 0x40).br(OP.BNE, 'nohi')
    .b(OP.LDA_IMM, 0x20, OP.STA_ZP, 0x73);
  a.label('nohi').b(OP.INC_ZP, 0x71, OP.LDA_ZP, 0x71, OP.AND_IMM, 0x3F).br(OP.BNE, 'loop');

  // Every 64th pass.
  touch(0xC030);                                        // speaker
  touch(0xC020);                                        // cassette output
  a.abs(OP.LDA_ABS, 0xC064).b(OP.STA_ZP, 0x76);         // paddle 0's timer
  touch(0xC070);                                        // restart the timers
  touch(0xC059);                                        // AN0 on
  a.b(OP.LDA_ZP, 0x70).abs(OP.STA_ABS, 0xE000);         // language-card RAM
  a.b(OP.LDA_ZP, 0x70, OP.AND_IMM, 0x01).br(OP.BEQ, 'page1');
  touch(0xC055);
  a.abs(OP.JMP, 'paged');
  a.label('page1');
  touch(0xC054);
  a.label('paged');
  // AY register 0 (tone A) from the tick count: latch the address, then write.
  sta(0x00, 0xC401); sta(0x07, 0xC400); sta(0x04, 0xC400);
  a.b(OP.LDA_ZP, 0x70).abs(OP.STA_ABS, 0xC401);
  sta(0x06, 0xC400); sta(0x04, 0xC400);
  a.abs(OP.LDA_ABS, 0xC000).b(OP.STA_ZP, 0x77);
  if (iie) {
    // Auxiliary RAM: RAMWRT on, a byte to aux $4000, RAMWRT off.
    a.abs(OP.STA_ABS, 0xC005).b(OP.LDA_ZP, 0x70).abs(OP.STA_ABS, 0x4000).abs(OP.STA_ABS, 0xC004);
  }
  // Every 256th pass: move the head, one stepper magnet at a time.
  a.b(OP.LDA_ZP, 0x71).br(OP.BNE, 'loop');
  touch(0xC0E0); touch(0xC0E2); touch(0xC0E4); touch(0xC0E6);
  a.b(OP.LDA_ZP, 0x70, OP.AND_IMM, 0x03, 0x0A /* ASL A */, 0xAA /* TAX */).abs(OP.LDA_ABSX, 0xC0E1);
  a.abs(OP.JMP, 'loop');

  a.label('irq').b(OP.PHA);
  a.abs(OP.LDA_ABS, 0xC404);                            // clears T1's flag
  a.b(OP.INC_ZP, 0x70, OP.PLA, OP.RTI);

  const code = a.assemble();
  const base = iie ? 0x1000 : 0;                        // the //e's ROM has $C000-$CFFF first
  const rom = new Uint8Array(base + 0x3000);
  if (iie) rom.fill(0xFF, 0, 0x1000);
  rom.set(code, base);
  const vec = (at: number, label: string): void => {
    rom[base + at] = a.addr(label) & 0xFF;
    rom[base + at + 1] = a.addr(label) >> 8;
  };
  vec(0x2FFA, 'irq');
  vec(0x2FFC, 'reset');
  vec(0x2FFE, 'irq');
  return rom;
}

function diskBytes(): Uint8Array {
  const data = new Uint8Array(35 * 16 * 256);
  let seed = 4242;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    data[i] = seed >>> 24;
  }
  return data;
}

const IIE: readonly Apple2Model[] = ['apple2e', 'apple2e-enhanced'];

function bare(model: Apple2Model, mockingboard = true): Apple2Machine {
  const m = new Apple2Machine(model, null);
  m.prepare({ get: <T>(key: string, fallback: T): T => (key === 'apple2-mockingboard' ? mockingboard as T : fallback) });
  m.loadROM(firmware(IIE.includes(model)));
  m.reset();
  m.setSpeedMultiplier(0);
  return m;
}

function machine(model: Apple2Model, mockingboard = true): Apple2Machine {
  const m = bare(model, mockingboard);
  m.services.disks.mountImage('a', diskBytes(), 'disk.dsk');
  return m;
}

describe('Apple II snapshot container', () => {
  it('names the model and says whether the media is inside', async () => {
    const m = machine('apple2-plus');
    try {
      for (let f = 0; f < 3; f++) m.tick();
      const file = await decodeNativeState(APPLE2_STATE_SPEC, await m.services.snapshots.save(EXT));
      expect(file.info.model).toBe('apple2-plus');
      expect(file.info.media).toBe(true);
      const sync = await decodeNativeState(APPLE2_STATE_SPEC, m.services.snapshots.saveSync());
      expect(sync.info.media).toBe(false);
      expect(m.services.media.accepts().some(t => t.ext === EXT)).toBe(true);
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-a2state');
    } finally {
      m.destroy();
    }
  });

  it('refuses a damaged file and leaves the machine as it was', async () => {
    const m = machine('apple2-plus');
    try {
      for (let f = 0; f < 5; f++) m.tick();
      const file = await m.services.snapshots.save(EXT);
      for (let f = 0; f < 3; f++) m.tick();
      await expectRefusedUntouched(m, file, EXT);
      await expectRefusedUntouched(m, m.services.snapshots.saveSync(), EXT);
    } finally {
      m.destroy();
    }
  });

  it('refuses a state saved with other cards fitted', async () => {
    const m = machine('apple2-plus', true);
    const other = machine('apple2-plus', false);
    try {
      for (let f = 0; f < 5; f++) m.tick();
      other.tick();
      // Refused before anything changes; the shared service then puts the
      // machine's own state back (redrawing the same picture), so the
      // machine is compared.
      const before = fingerprint(other, false);
      const r = await other.services.snapshots.apply(await m.services.snapshots.save(EXT), `x${EXT}`);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Mockingboard/);
      expect(fingerprint(other, false)).toBe(before);
    } finally {
      m.destroy();
      other.destroy();
    }
  });
});

describe.each(['apple2-plus', 'apple2e', 'apple2e-enhanced'] as const)('Apple II snapshot is exact (%s)', (model) => {
  it.each(['high', 'mid', 'low'] as const)('with the disk, the Mockingboard and the game port in use (%s accuracy)', async (accuracy) => {
    const m = machine(model);
    const fresh = machine(model);
    m.videoAccuracy = accuracy;
    fresh.videoAccuracy = accuracy;
    try {
      // A stick held off-centre, as the host drives it.
      m.paddles.analog('x', 0.4, 0);
      m.paddles.press('down', true, 1);
      for (let f = 0; f < 33; f++) m.tick();
      expect(m.memory.ram[0x75], 'disk bytes have been read').toBeGreaterThan(0);
      expect(m.disk2.motorOn, 'the disk is turning').toBe(true);
      expect(m.memory.ram[0x70], 'the Mockingboard interrupts').toBeGreaterThan(0);
      expect(m.disk2.getUnitQuarterTrack(0), 'the head has moved').toBeGreaterThan(0);
      if (IIE.includes(model)) expect(m.mmu.aux[0x4000], 'aux RAM is written').not.toBe(0);
      await expectExactFromFile(m, fresh, EXT, 40);
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });
});

describe('Apple II snapshot media', () => {
  it('carries a disk a guest has written, in its bit tracks', async () => {
    const m = machine('apple2-plus');
    const fresh = bare('apple2-plus');
    try {
      m.tick();
      const disk = m.disk2.getDiskImage(0)!;
      disk.apple2.bits.tracks[5].data.fill(0x5A, 100, 200);
      const r = await fresh.services.snapshots.apply(await m.services.snapshots.save(EXT), `x${EXT}`);
      expect(r.ok).toBe(true);
      const restored = fresh.disk2.getDiskImage(0)!;
      expect(Array.from(restored.apple2.bits.tracks[5].data)).toEqual(Array.from(disk.apple2.bits.tracks[5].data));
      expect(restored.apple2.source).toBe('dsk');
      expect(fresh.services.disks.drives[0].mediaName).toBe('disk.dsk');
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });

  it('a state of another model asks for that model', async () => {
    const m = machine('apple2-plus');
    const other = machine('apple2e');
    try {
      m.tick();
      const asked: string[] = [];
      other.attachHost({
        setStatus() {}, persistMedia() {},
        requestModel: async (model) => { asked.push(model); return true; },
      });
      const r = await other.services.snapshots.apply(await m.services.snapshots.save(EXT), `x${EXT}`);
      expect(r).toMatchObject({ ok: true, needsReplay: true });
      expect(asked).toEqual(['apple2-plus']);
    } finally {
      m.destroy();
      other.destroy();
    }
  });

  it('resumes after a browser refresh, with the disk remounted and no reboot', async () => {
    const m = machine('apple2-plus');
    const fresh = bare('apple2-plus');
    try {
      for (let f = 0; f < 27; f++) m.tick();
      const sync = m.services.snapshots.saveSync();
      const original = trace(m, 30);
      expect(await fresh.services.snapshots.restoreSync(sync)).toBe(true);
      const mounted = await fresh.services.media.mount(diskBytes(), 'disk.dsk', 'a');
      expect(mounted.ok).toBe(true);
      expect(trace(fresh, 30)).toEqual(original);
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });
});
