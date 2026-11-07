/**
 * zx84's native Acorn Electron snapshot (`.elkstate`): the container's checks,
 * and that a restore is exact with a Plus 3 disc read, the Plus 1's ADC, the
 * cassette, the ULA's sound and interrupts all in flight.
 *
 * The firmware is synthetic (assembled below) so the test always runs; a
 * second case boots the real OS and BASIC when they are to hand
 * (`ZX84_ROM_DIR` or mcp/.cache).
 */

import { describe, it, expect } from 'vitest';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';
import { ELECTRON_STATE_SPEC } from '@/machines/electron/snapshots/electron-state.ts';
import { decodeNativeState } from '@/machines/shared/native-state.ts';
import { parseAdfs } from '@/media/floppy/adfs.ts';
import type { CswBlock } from '@/media/tape/tap.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';
import {
  Asm, OP, expectExactFromFile, expectRefusedUntouched, fingerprint, romImage, trace,
} from './native-state-helpers.ts';

const EXT = '.elkstate';
/** An 80-track single-sided ADFS (M) disc: 16 sectors of 256 bytes a track. */
const ADFS_M_BYTES = 80 * 16 * 256;

/** Synthetic OS. Zero page: $70 interrupts, $71 loop count, $72/$73 screen
 *  pointer, $76 disc bytes, $77 disc commands, $7A the tape byte, $7B the
 *  Plus 1 ADC's last result. */
function firmware(read = true): Uint8Array {
  const a = new Asm(0xC000);
  const sta = (v: number, addr: number): void => { a.b(OP.LDA_IMM, v).abs(OP.STA_ABS, addr); };
  a.label('reset').b(OP.SEI, OP.CLD, OP.LDX_IMM, 0xFF, OP.TXS);
  sta(0x00, 0xFE02);
  sta(0x18, 0xFE03);                      // screen at $3000
  sta(0x48, 0xFE07);                      // Mode 1, cassette in, motor on
  sta(0x0C, 0xFE00);                      // interrupts: RTC and display end
  a.b(OP.LDA_IMM, 0x00, OP.STA_ZP, 0x70, OP.STA_ZP, 0x71, OP.STA_ZP, 0x72, OP.STA_ZP, 0x76, OP.STA_ZP, 0x77);
  a.b(OP.LDA_IMM, 0x30, OP.STA_ZP, 0x73);
  sta(0x04, 0xFC70);                      // Plus 1 ADC: convert channel 0
  sta(0x21, 0xFCC0);                      // Plus 3: drive 0, out of reset
  if (read) a.abs(OP.JSR, 'startread');
  a.b(OP.CLI);

  a.label('loop').b(OP.LDY_IMM, 0x00, OP.LDA_ZP, 0x70, OP.EOR_ZP, 0x71, OP.STA_INDY, 0x72)
    .b(OP.INC_ZP, 0x72).br(OP.BNE, 'nohi')
    .b(OP.INC_ZP, 0x73, OP.LDA_ZP, 0x73, OP.CMP_IMM, 0x80).br(OP.BNE, 'nohi')
    .b(OP.LDA_IMM, 0x30, OP.STA_ZP, 0x73);
  a.label('nohi').b(OP.INC_ZP, 0x71, OP.LDA_ZP, 0x71, OP.AND_IMM, 0x3F).br(OP.BNE, 'loop');
  // Every 64th pass: the tape byte, a new sound pitch, and the ADC once its
  // conversion is done (/INTR low).
  a.abs(OP.LDA_ABS, 0xFE04).b(OP.STA_ZP, 0x7A);
  a.b(OP.LDA_ZP, 0x70).abs(OP.STA_ABS, 0xFE06);
  a.b(OP.LDA_ZP, 0x70).abs(OP.STA_ABS, 0xFC71);        // a byte to the Plus 1's printer (and its BUSY)
  a.abs(OP.LDA_ABS, 0xFC72).b(OP.AND_IMM, 0x40).br(OP.BNE, 'noadc');
  a.abs(OP.LDA_ABS, 0xFC70).b(OP.STA_ZP, 0x7B, OP.LDA_ZP, 0x70, OP.AND_IMM, 0x03, OP.ORA_IMM, 0x04)
    .abs(OP.STA_ABS, 0xFC70);
  a.label('noadc');
  // Every 256th pass, swap the ULA between sound and cassette input.
  a.b(OP.LDA_ZP, 0x71).br(OP.BNE, 'loop');
  a.b(OP.LDA_ZP, 0x70, OP.AND_IMM, 0x01).br(OP.BEQ, 'tapein');
  sta(0x4A, 0xFE07);
  a.abs(OP.JMP, 'loop');
  a.label('tapein');
  sta(0x48, 0xFE07);
  a.abs(OP.JMP, 'loop');

  a.label('startread');
  sta(0x00, 0xFCC5); sta(0x00, 0xFCC6); sta(0x90, 0xFCC4);    // READ SECTOR, multiple
  a.b(OP.RTS);

  a.label('irq').b(OP.PHA);
  sta(0x70, 0xFE05);                      // clear RTC, display end and high tone; ROM page 0
  a.b(OP.INC_ZP, 0x70, OP.PLA, OP.RTI);

  a.label('nmi').b(OP.PHA);
  a.abs(OP.LDA_ABS, 0xFCC4).b(OP.LSR_A).br(OP.BCC, 'done');
  a.abs(OP.LDA_ABS, 0xFCC7).abs(OP.STA_ABS, 0x0E00).b(OP.INC_ZP, 0x76, OP.PLA, OP.RTI);
  a.label('done').b(OP.INC_ZP, 0x77).abs(OP.JSR, 'startread').b(OP.PLA, OP.RTI);

  const rom = new Uint8Array(0x8000);         // BASIC (unused) then the OS
  rom.set(a.assemble(), 0x4000);
  const vec = (at: number, label: string): void => {
    rom[0x4000 + at] = a.addr(label) & 0xFF;
    rom[0x4000 + at + 1] = a.addr(label) >> 8;
  };
  vec(0x3FFA, 'nmi');
  vec(0x3FFC, 'reset');
  vec(0x3FFE, 'irq');
  return rom;
}

function discBytes(): Uint8Array {
  const data = new Uint8Array(ADFS_M_BYTES);
  for (let i = 0; i < data.length; i++) data[i] = (i * 13 + (i >> 9)) & 0xFF;
  return data;
}

function tape(): CswBlock {
  const pulses: number[] = [];
  let seed = 999;
  for (let bit = 0; bit < 6000; bit++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    if (seed & 0x10000) pulses.push(729, 729, 729, 729);
    else pulses.push(1458, 1458);
  }
  return { kind: 'csw', pulses: Uint32Array.from(pulses) };
}

function bare(read = true): ElectronMachine {
  const m = new ElectronMachine('electron', null);
  m.setExpansions(true, true, false);
  m.loadROM(firmware(read));
  m.reset();
  m.setSpeedMultiplier(0);
  return m;
}

function machine(withTape: boolean, read = true): ElectronMachine {
  const m = bare(read);
  m.services.disks.insert('a', parseAdfs(discBytes(), false), 'disc.adm');
  if (withTape) m.cassette.mount([tape()], 'tape.csw');
  return m;
}

describe('Electron snapshot container', () => {
  it('names the model and says whether the media is inside', async () => {
    const m = machine(false);
    try {
      for (let f = 0; f < 3; f++) m.tick();
      const file = await decodeNativeState(ELECTRON_STATE_SPEC, await m.services.snapshots.save(EXT));
      expect(file.info.model).toBe('electron');
      expect(file.info.media).toBe(true);
      const sync = await decodeNativeState(ELECTRON_STATE_SPEC, m.services.snapshots.saveSync());
      expect(sync.info.media).toBe(false);
      expect(m.services.media.accepts().some(t => t.ext === EXT)).toBe(true);
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-elkstate');
    } finally {
      m.destroy();
    }
  });

  it('refuses a damaged file and leaves the machine as it was', async () => {
    const m = machine(false);
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

  it('refuses a state saved with other expansions fitted', async () => {
    const m = machine(false);
    const other = new ElectronMachine('electron', null);
    other.loadROM(firmware());
    other.reset();
    other.setSpeedMultiplier(0);
    try {
      for (let f = 0; f < 5; f++) m.tick();
      other.tick();
      // Refused before anything changes; the shared service then puts the
      // machine's own state back (redrawing the same picture from it), so the
      // machine is compared.
      const before = fingerprint(other, false);
      const r = await other.services.snapshots.apply(await m.services.snapshots.save(EXT), `x${EXT}`);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/a Plus 1 and a Plus 3 \(ADFS\).*no Plus 1 and no Plus 3/);
      expect(fingerprint(other, false)).toBe(before);
    } finally {
      m.destroy();
      other.destroy();
    }
  });
});

describe('Electron snapshot is exact', () => {
  it('with a Plus 3 read, the Plus 1 ADC, the tape and the ULA in flight', async () => {
    const m = machine(true);
    const fresh = machine(false);
    try {
      m.joystickAnalog('x', -0.6, 0);
      m.joystickAnalog('y', 0.3, 0);
      m.joystickAnalog('x', 0.9, 1);
      m.joystickAnalog('y', 0.25, 1);
      m.joystickPress('fire', true, 0);
      for (let f = 0; f < 41; f++) m.tick();
      expect(m.memory.ram[0x76] + m.memory.ram[0x77], 'disc bytes have been read').toBeGreaterThan(0);
      expect(m.plus3.isExecuting, 'a transfer is in flight').toBe(true);
      expect(m.memory.ram[0x70], 'the ULA interrupts run').toBeGreaterThan(0);
      expect(m.memory.ram[0x7B], 'the ADC has converted a held stick').not.toBe(0x80);
      await expectExactFromFile(m, fresh, EXT, 40);
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });

  it('carries a Plus 1 cartridge', async () => {
    const m = machine(false);
    const fresh = machine(false);
    try {
      const cart = new Uint8Array(0x4000).fill(0xA5);
      m.insertCartridge(cart, 'game.rom');
      m.tick();
      const r = await fresh.services.snapshots.apply(await m.services.snapshots.save(EXT), `x${EXT}`);
      expect(r.ok).toBe(true);
      expect(fresh.cartridgeName).toBe('game.rom');
      expect(fresh.memory.expansion[2]?.[0x1234]).toBe(0xA5);
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });

  it('resumes after a browser refresh, with the disc remounted and no SHIFT+BREAK', async () => {
    const m = machine(false, false);
    const fresh = bare(false);
    try {
      for (let f = 0; f < 31; f++) m.tick();
      const sync = m.services.snapshots.saveSync();
      const original = trace(m, 30);
      expect(await fresh.services.snapshots.restoreSync(sync)).toBe(true);
      const mounted = await fresh.services.media.mount(discBytes(), 'disc.adm', 'a');
      expect(mounted.ok).toBe(true);
      expect(fresh.keyboard.isPressed(13, 3), 'SHIFT is not held for a boot').toBe(false);
      expect(trace(fresh, 30)).toEqual(original);
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });
});

const OS = romImage('electron-os.rom');
const BASIC = romImage('electron-basic.rom');

describe.skipIf(!OS || !BASIC)('Electron snapshot on the real OS and BASIC', () => {
  function booted(): ElectronMachine {
    const rom = new Uint8Array(0x8000);
    rom.set(BASIC!, 0);
    rom.set(OS!, 0x4000);
    const m = new ElectronMachine('electron', null);
    m.loadROM(rom);
    m.reset();
    m.setSpeedMultiplier(0);
    for (let f = 0; f < 200; f++) m.tick();
    return m;
  }

  function type(m: ElectronMachine, text: string): void {
    for (const ch of text) {
      const ev: HostKeyEvent = {
        code: ch === '\n' ? 'Enter' : /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /[0-9]/.test(ch) ? `Digit${ch}` : '',
        key: ch === '\n' ? 'Enter' : ch, shift: false, ctrl: false, alt: false,
      };
      m.services.input.keyDown(ev);
      for (let f = 0; f < 3; f++) m.tick();
      m.services.input.keyUp(ev);
      for (let f = 0; f < 3; f++) m.tick();
    }
  }

  it('a running BASIC program carries on identically', async () => {
    const m = booted();
    const fresh = booted();
    try {
      type(m, 'MODE 2\n');
      type(m, '10 GCOL 0,RND(7):DRAW RND(1279),RND(1023):SOUND 1,-15,RND(200),1:GOTO 10\nRUN\n');
      for (let f = 0; f < 25; f++) m.tick();
      await expectExactFromFile(m, fresh, EXT, 50);
    } finally {
      m.destroy();
      fresh.destroy();
    }
  }, 60_000);
});
