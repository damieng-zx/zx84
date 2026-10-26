/**
 * zx84's native BBC Micro snapshot (`.bbcstate`): the container's checks, and
 * that a restore is exact — with a disc transfer, the cassette and the timers
 * all in flight when the state is taken.
 *
 * The firmware here is synthetic (assembled below) so the test always runs:
 * it sets up a Mode 1 screen it keeps writing to, a free-running System VIA
 * timer interrupt, the SN76489, the cassette (motor on, ACIA receiving) and
 * a disc read that never ends (each multi-sector read restarts from its NMI
 * handler when it completes). A second case boots the real MOS 1.20 and BASIC
 * when they are to hand (`ZX84_ROM_DIR` or mcp/.cache).
 */

import { describe, it, expect } from 'vitest';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { BBC_STATE_SPEC } from '@/machines/bbc/snapshots/bbc-state.ts';
import { decodeNativeState } from '@/machines/shared/native-state.ts';
import { parseSsd, SSD_TRACK_BYTES } from '@/media/floppy/ssd.ts';
import type { CswBlock } from '@/media/tape/tap.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';
import {
  Asm, OP, expectExactFromFile, expectRefusedUntouched, fingerprint, romImage, trace,
} from './native-state-helpers.ts';

const EXT = '.bbcstate';

/** Mode 1's CRTC registers R0-R13, as the MOS sets them. */
const MODE1_CRTC = [0x7F, 0x50, 0x62, 0x28, 0x26, 0x00, 0x20, 0x22, 0x01, 0x07, 0x67, 0x08, 0x06, 0x00];

type Disc = '1770' | '8271';

/** Synthetic OS: everything in flight at once. Zero page: $70 timer ticks,
 *  $71 loop count, $72/$73 screen pointer, $76 disc bytes, $77 disc commands,
 *  $7A the last byte the ACIA received, $7B the ADC's last result. */
function firmware(disc: Disc, read = true): Uint8Array {
  const a = new Asm(0xC000);
  a.label('reset').b(OP.SEI, OP.CLD, OP.LDX_IMM, 0xFF, OP.TXS, OP.LDX_IMM, 0x00);
  a.label('crtc').abs(OP.STX_ABS, 0xFE00).abs(OP.LDA_ABSX, 'crtctab').abs(OP.STA_ABS, 0xFE01)
    .b(OP.INX, OP.CPX_IMM, MODE1_CRTC.length).br(OP.BNE, 'crtc');
  const sta = (v: number, addr: number): void => { a.b(OP.LDA_IMM, v).abs(OP.STA_ABS, addr); };
  sta(0xD8, 0xFE20);                      // video ULA: Mode 1
  sta(0xFF, 0xFE42);                      // System VIA DDRB: the IC32 latch
  sta(0xFF, 0xFE43);                      // DDRA: the slow data bus
  sta(0x04, 0xFE40);                      // IC32 C0 = 0
  sta(0x0D, 0xFE40);                      // IC32 C1 = 1 (Mode 0-2 wrap)
  sta(0x08, 0xFE40);                      // sound /WE high
  sta(0x40, 0xFE4B);                      // ACR: T1 free-running
  sta(0x0F, 0xFE44);
  sta(0x27, 0xFE45);                      // T1 = $270F, started
  sta(0x7F, 0xFE4E);
  sta(0xC0, 0xFE4E);                      // IER: T1
  sta(0x85, 0xFE10);                      // serial ULA: cassette, 1200 baud, motor on
  sta(0x03, 0xFE08);                      // ACIA master reset
  sta(0x15, 0xFE08);                      // ÷16, 8N1, no interrupts
  a.b(OP.LDA_IMM, 0x00, OP.STA_ZP, 0x70, OP.STA_ZP, 0x71, OP.STA_ZP, 0x72, OP.STA_ZP, 0x76, OP.STA_ZP, 0x77);
  a.b(OP.LDA_IMM, 0x30, OP.STA_ZP, 0x73);
  if (disc === '1770') {
    sta(0x28, 0xFE80);                    // drive 0, side 0, single density (DFS), out of reset
  } else {
    // WRITE SPECIAL REGISTER: mode = non-DMA, so each byte is an NMI.
    sta(0x7A, 0xFE80); sta(0x17, 0xFE81); sta(0xC1, 0xFE81);
  }
  if (read) a.abs(OP.JSR, 'startread');
  a.b(OP.CLI);

  a.label('loop').b(OP.LDY_IMM, 0x00, OP.LDA_ZP, 0x70, OP.EOR_ZP, 0x71, OP.STA_INDY, 0x72)
    .b(OP.INC_ZP, 0x72).br(OP.BNE, 'nohi')
    .b(OP.INC_ZP, 0x73, OP.LDA_ZP, 0x73, OP.CMP_IMM, 0x80).br(OP.BNE, 'nohi')
    .b(OP.LDA_IMM, 0x30, OP.STA_ZP, 0x73);
  a.label('nohi').b(OP.INC_ZP, 0x71, OP.LDA_ZP, 0x71, OP.AND_IMM, 0x3F).br(OP.BNE, 'loop');
  // Every 64th pass: a tone byte to the SN76489, and the ACIA's last byte.
  a.b(OP.LDA_ZP, 0x70, OP.AND_IMM, 0x0F, OP.ORA_IMM, 0x80).abs(OP.STA_ABS, 0xFE4F);
  sta(0x00, 0xFE40);                      // sound /WE low: the chip takes the byte
  sta(0x08, 0xFE40);
  a.abs(OP.LDA_ABS, 0xFE09).b(OP.STA_ZP, 0x7A);
  // The ADC: once a conversion has ended (/EOC low), read it and start a
  // 12-bit one on the next channel.
  a.abs(OP.LDA_ABS, 0xFEC0).br(OP.BMI, 'noadc');
  a.abs(OP.LDA_ABS, 0xFEC1).b(OP.STA_ZP, 0x7B, OP.LDA_ZP, 0x70, OP.AND_IMM, 0x03, OP.ORA_IMM, 0x08)
    .abs(OP.STA_ABS, 0xFEC0);
  a.label('noadc').abs(OP.JMP, 'loop');

  a.label('startread');
  if (disc === '1770') {
    sta(0x00, 0xFE85); sta(0x00, 0xFE86); sta(0x90, 0xFE84);   // READ SECTOR, multiple
  } else {
    // READ DATA, drive 0: track 0, sector 0, ten 256-byte sectors.
    sta(0x53, 0xFE80); sta(0x00, 0xFE81); sta(0x00, 0xFE81); sta(0x2A, 0xFE81);
  }
  a.b(OP.RTS);

  a.label('irq').b(OP.PHA);
  sta(0x7F, 0xFE4D);
  a.b(OP.INC_ZP, 0x70, OP.PLA, OP.RTI);

  a.label('nmi').b(OP.PHA);
  if (disc === '1770') {
    a.abs(OP.LDA_ABS, 0xFE84).b(OP.LSR_A).br(OP.BCC, 'done');  // BUSY clear: the command ended
    a.abs(OP.LDA_ABS, 0xFE87);
  } else {
    a.abs(OP.LDA_ABS, 0xFE80).b(OP.AND_IMM, 0x04).br(OP.BEQ, 'result');  // no DRQ: a result
    a.abs(OP.LDA_ABS, 0xFE84);
  }
  a.abs(OP.STA_ABS, 0x0E00).b(OP.INC_ZP, 0x76, OP.PLA, OP.RTI);
  if (disc === '8271') a.label('result').abs(OP.LDA_ABS, 0xFE81).abs(OP.JMP, 'done');
  a.label('done').b(OP.INC_ZP, 0x77).abs(OP.JSR, 'startread').b(OP.PLA, OP.RTI);
  a.label('crtctab').b(...MODE1_CRTC);

  const code = a.assemble();
  const rom = new Uint8Array(0x8000);
  rom.set(code, 0);
  const vec = (at: number, label: string): void => {
    rom[at] = a.addr(label) & 0xFF;
    rom[at + 1] = a.addr(label) >> 8;
  };
  vec(0x3FFA, 'nmi');
  vec(0x3FFC, 'reset');
  vec(0x3FFE, 'irq');
  return rom;
}

/** A single-sided 80-track disc whose bytes are all different-ish. */
function discBytes(): Uint8Array {
  const data = new Uint8Array(SSD_TRACK_BYTES * 80);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 8)) & 0xFF;
  return data;
}

/** A recording of random FSK bits: 1200 Hz half-cycles for 0, 2400 Hz for 1. */
function tape(): CswBlock {
  const pulses: number[] = [];
  let seed = 12345;
  for (let bit = 0; bit < 6000; bit++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    if (seed & 0x10000) pulses.push(729, 729, 729, 729);
    else pulses.push(1458, 1458);
  }
  return { kind: 'csw', pulses: Uint32Array.from(pulses) };
}

function machine(disc: Disc, withTape: boolean): BbcMachine {
  const m = new BbcMachine('bbc-b', null);
  m.setDiskSystem(disc === '1770' ? '1770' : 'acorn');
  m.loadROM(firmware(disc));
  m.reset();
  m.setSpeedMultiplier(0);
  m.services.disks.insert('a', parseSsd(discBytes(), false), 'disc.ssd');
  if (withTape) m.cassette.mount([tape()], 'tape.csw');
  return m;
}

describe('BBC snapshot container', () => {
  it('names the model and says whether the media is inside', async () => {
    const m = machine('1770', false);
    try {
      for (let f = 0; f < 3; f++) m.tick();
      const file = await decodeNativeState(BBC_STATE_SPEC, await m.services.snapshots.save(EXT));
      expect(file.info.model).toBe('bbc-b');
      expect(file.info.media).toBe(true);
      const sync = await decodeNativeState(BBC_STATE_SPEC, m.services.snapshots.saveSync());
      expect(sync.info.media).toBe(false);
      expect(m.services.snapshots.formats()).toEqual([{ ext: EXT, canSave: true }]);
      expect(m.services.media.accepts().some(t => t.ext === EXT)).toBe(true);
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-bbcstate');
    } finally {
      m.destroy();
    }
  });

  it('refuses a damaged file and leaves the machine as it was', async () => {
    const m = machine('1770', false);
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

  it('refuses a state saved with another disc interface fitted', async () => {
    const m = machine('1770', false);
    const other = machine('8271', false);
    try {
      for (let f = 0; f < 5; f++) m.tick();
      other.tick();
      // Refused before anything changes; the shared service then puts the
      // machine's own state back, which redraws the same picture from it, so
      // the machine (not the picture) is compared.
      const before = fingerprint(other, false);
      const r = await other.services.snapshots.apply(await m.services.snapshots.save(EXT), `x${EXT}`);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/1770 interface.*8271 interface/);
      expect(fingerprint(other, false)).toBe(before);
    } finally {
      m.destroy();
      other.destroy();
    }
  });
});

describe('BBC snapshot is exact', () => {
  it.each(['high', 'mid', 'low'] as const)('with a 1770 read, the tape and the timers in flight (%s accuracy)', async (accuracy) => {
    const m = machine('1770', true);
    const fresh = machine('1770', false);
    m.videoAccuracy = accuracy;
    fresh.videoAccuracy = accuracy;
    try {
      // A stick held off-centre and a fire button down, as the host drives them.
      m.joystickAnalog('x', 0.37, 0);
      m.joystickAnalog('y', -0.8, 1);
      m.joystickPress('fire', true, 1);
      for (let f = 0; f < 37; f++) m.tick();
      // The firmware is doing what the test is about.
      expect(m.memory.ram[0x76] + m.memory.ram[0x77], 'disc bytes have been read').toBeGreaterThan(0);
      expect(m.disc!.isExecuting, 'a transfer is in flight').toBe(true);
      expect(m.cassette.running, 'the tape is moving').toBe(true);
      expect(m.memory.ram[0x70], 'the timer interrupt runs').toBeGreaterThan(0);
      expect(m.memory.ram[0x7B], 'the ADC has converted a held stick').not.toBe(0);
      await expectExactFromFile(m, fresh, EXT, 40);
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });

  it('with an 8271 read in flight', async () => {
    const m = machine('8271', false);
    const fresh = machine('8271', false);
    try {
      for (let f = 0; f < 23; f++) m.tick();
      expect(m.memory.ram[0x76] + m.memory.ram[0x77], 'disc bytes have been read').toBeGreaterThan(0);
      expect(m.disc!.isExecuting, 'a transfer is in flight').toBe(true);
      await expectExactFromFile(m, fresh, EXT, 40);
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });

  it('carries the disc a guest has written', async () => {
    const m = machine('1770', false);
    const fresh = machine('1770', false);
    try {
      for (let f = 0; f < 5; f++) m.tick();
      m.disc!.getDiskImage(0)!.tracks[3]![0]!.sectors[4].data.fill(0x5A);
      const r = await fresh.services.snapshots.apply(await m.services.snapshots.save(EXT), `x${EXT}`);
      expect(r.ok).toBe(true);
      expect(fresh.disc!.getDiskImage(0)!.tracks[3]![0]!.sectors[4].data.every(b => b === 0x5A)).toBe(true);
      expect(fresh.services.disks.drives[0].mediaName).toBe('disc.ssd');
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });

  it('resumes after a browser refresh, with the disc remounted and no SHIFT+BREAK', async () => {
    // The disc sits idle (a transfer in flight cannot find its track in a
    // drive that is empty when the refresh copy is restored).
    const m = new BbcMachine('bbc-b', null);
    m.loadROM(firmware('1770', false));
    m.reset();
    m.setSpeedMultiplier(0);
    m.services.disks.insert('a', parseSsd(discBytes(), false), 'disc.ssd');
    // A refreshed page builds an empty machine, restores, then remounts.
    const fresh = new BbcMachine('bbc-b', null);
    fresh.loadROM(firmware('1770', false));
    fresh.reset();
    fresh.setSpeedMultiplier(0);
    try {
      for (let f = 0; f < 29; f++) m.tick();
      const sync = m.services.snapshots.saveSync();
      const original = trace(m, 30);
      expect(await fresh.services.snapshots.restoreSync(sync)).toBe(true);
      const mounted = await fresh.services.media.mount(discBytes(), 'disc.ssd', 'a');
      expect(mounted.ok).toBe(true);
      expect(fresh.keyboard.isPressed(0, 0), 'SHIFT is not held for a boot').toBe(false);
      const restored = trace(fresh, 30);
      expect(restored).toEqual(original);
    } finally {
      m.destroy();
      fresh.destroy();
    }
  });
});

const OS = romImage('bbc-os12.rom');
const BASIC = romImage('bbc-basic2.rom');

describe.skipIf(!OS || !BASIC)('BBC snapshot on MOS 1.20 and BASIC', () => {
  function booted(): BbcMachine {
    const rom = new Uint8Array(0x8000);
    rom.set(OS!, 0);
    rom.set(BASIC!, 0x4000);
    const m = new BbcMachine('bbc-b', null);
    m.setDiskSystem('none');
    m.loadROM(rom);
    m.reset();
    m.setSpeedMultiplier(0);
    for (let f = 0; f < 150; f++) m.tick();
    return m;
  }

  function type(m: BbcMachine, text: string): void {
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
  });
});
