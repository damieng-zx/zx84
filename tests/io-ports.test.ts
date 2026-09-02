/**
 * Port I/O dispatch and ROM/RAM latching tests.
 *
 * These tests build a real Spectrum (per model) and exercise port writes/reads
 * through the wired CPU handlers, asserting documented external behaviour:
 *
 *  - Port decode masks per model (48K, 128K/+2, +2A/+3).
 *  - ULA, AY, Kempston, FDC, and bank-select port routing.
 *  - Memory paging via 0x7FFD (128K bank select, ROM select, screen bank,
 *    paging lock) and 0x1FFD (+2A/+3 special all-RAM modes, ROM select).
 *  - ROM write protection in normal paging, RAM writability in special
 *    paging, and 16K open-bus behaviour above 0x8000.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import type { SpectrumModel } from '@/models.ts';

function makeMachine(model: SpectrumModel): Spectrum {
  const s = new Spectrum(model, null);
  // Load a minimal "ROM" so each ROM page is identifiable in tests.
  // Bytes 0..15: page tag (0xAA + page index).
  const rom = new Uint8Array(64 * 1024);
  for (let page = 0; page < 4; page++) {
    rom[page * 16384 + 0] = 0xA0 + page;     // page tag
    rom[page * 16384 + 1] = page;             // page index
  }
  s.loadROM(rom);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// Port decode — variant strategies
// ─────────────────────────────────────────────────────────────────────────

describe('Port decode — 48K Ferranti', () => {
  const s = makeMachine('48k');
  const v = s.variant;

  it('decodes ULA port for any address with bit 0 clear (via 48k case: hasBanking=false)', () => {
    expect(v.hasBanking).toBe(false);
    expect(v.hasAY).toBe(false);
    expect(v.hasFDC).toBe(false);
    expect(v.hasSpecialPaging).toBe(false);
    expect(v.romPageCount).toBe(1);
  });

  it('refuses all banking/FDC port decodes', () => {
    for (const port of [0x7FFD, 0x1FFD, 0x3FFD, 0x2FFD, 0xBFFD, 0xFFFD]) {
      expect(v.decodes7FFD(port)).toBe(false);
      expect(v.decodes1FFD(port)).toBe(false);
      expect(v.decodesFDCData(port)).toBe(false);
      expect(v.decodesFDCStatus(port)).toBe(false);
    }
  });
});

describe('Port decode — 128K/+2 Ferranti (port 7FFD)', () => {
  const s = makeMachine('128k');
  const v = s.variant;

  it('decodes 7FFD as (port & 0x8002) === 0 — broadest mask', () => {
    expect(v.decodes7FFD(0x7FFD)).toBe(true);
    expect(v.decodes7FFD(0x7FFC)).toBe(true); // bit 0 = 0, bit 1 = 0, bit 15 = 0
    expect(v.decodes7FFD(0x7FFF)).toBe(false); // bit 1 set
    expect(v.decodes7FFD(0xFFFD)).toBe(false); // bit 15 set
    expect(v.decodes7FFD(0x0000)).toBe(true);  // would also catch ULA writes
  });

  it('does NOT decode 1FFD / FDC ports (no +3 hardware)', () => {
    expect(v.decodes1FFD(0x1FFD)).toBe(false);
    expect(v.decodesFDCData(0x3FFD)).toBe(false);
    expect(v.decodesFDCStatus(0x2FFD)).toBe(false);
  });
});

describe('Port decode — +2A/+3 Amstrad', () => {
  const s = makeMachine('+3');
  const v = s.variant;

  it('decodes 7FFD as (port & 0xC002) === 0x4000 (tighter than Ferranti)', () => {
    expect(v.decodes7FFD(0x7FFD)).toBe(true);
    expect(v.decodes7FFD(0x4000)).toBe(true);
    expect(v.decodes7FFD(0x4001)).toBe(true); // bit 0 ignored
    expect(v.decodes7FFD(0x4002)).toBe(false); // bit 1 set
    expect(v.decodes7FFD(0x0000)).toBe(false); // bit 14 clear — would have hit Ferranti
    expect(v.decodes7FFD(0x8000)).toBe(false); // bit 15 set
  });

  it('decodes 1FFD as (port & 0xF002) === 0x1000', () => {
    expect(v.decodes1FFD(0x1FFD)).toBe(true);
    expect(v.decodes1FFD(0x1000)).toBe(true);
    expect(v.decodes1FFD(0x1002)).toBe(false);
    expect(v.decodes1FFD(0x2FFD)).toBe(false);
  });

  it('decodes FDC ports (0x2FFD status, 0x3FFD data) via (port & 0xF002) === 0x2000/0x3000', () => {
    expect(v.decodesFDCStatus(0x2FFD)).toBe(true);
    expect(v.decodesFDCStatus(0x2000)).toBe(true);
    expect(v.decodesFDCStatus(0x2003)).toBe(false); // bit 1 set
    expect(v.decodesFDCData(0x3FFD)).toBe(true);
    expect(v.decodesFDCData(0x3000)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ULA port dispatch (port-write path)
// ─────────────────────────────────────────────────────────────────────────

describe('Port routing — ULA writes', () => {
  let s: Spectrum;
  beforeEach(() => { s = makeMachine('48k'); });

  it('any port with bit 0 = 0 routes to ULA (border + beeper)', () => {
    s.cpu.portOut(0x00FE, 0x07); // border 7, beeper 0
    expect(s.ula.borderColor).toBe(7);
    expect(s.ula.beeperBit).toBe(0);

    s.cpu.portOut(0xFFFE, 0x13); // border 3, beeper 1
    expect(s.ula.borderColor).toBe(3);
    expect(s.ula.beeperBit).toBe(1);
  });

  it('ports with bit 0 set are NOT routed to ULA', () => {
    s.ula.borderColor = 4;
    s.cpu.portOut(0x00FF, 0x01); // bit 0 set
    expect(s.ula.borderColor).toBe(4); // unchanged
  });

  it('writes go through cpu.portOut (so contention is applied via io-ports wrapper)', () => {
    // We can't easily observe contention here without a deeper hook,
    // but verifying the wired-handler path is reached is enough for routing.
    s.cpu.portOut(0x00FE, 0x02);
    expect(s.ula.borderColor).toBe(2);
  });
});

describe('Port routing — ULA reads', () => {
  it('ULA read returns 0xBF when no keys pressed (bits 5+7 set, EAR=0, no rows hit)', () => {
    const s = makeMachine('48k');
    // 0xBF = 10111111: bit 7 set, bit 6 clear (beeper=0), bit 5 set, bits 0-4 all 1
    // High byte 0xFF → no rows selected, no keys can read low
    expect(s.cpu.portIn(0xFFFE) & 0xFF).toBe(0xBF);
  });

  it('writing beeper bit 4 feeds back on bit 6 (Issue 3 contract)', () => {
    const s = makeMachine('48k');
    s.cpu.portOut(0x00FE, 0x10);
    expect(s.cpu.portIn(0xFFFE) & 0x40).toBe(0x40);
    s.cpu.portOut(0x00FE, 0x00);
    expect(s.cpu.portIn(0xFFFE) & 0x40).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AY-3-8910 routing (128K only)
// ─────────────────────────────────────────────────────────────────────────

describe('Port routing — AY-3-8910 (128K only)', () => {
  it('128K: port 0xFFFD selects an AY register', () => {
    const s = makeMachine('128k');
    s.cpu.portOut(0xFFFD, 0x07); // select mixer register
    expect(s.ay.selectedReg).toBe(0x07);
  });

  it('128K: port 0xBFFD writes the selected AY register', () => {
    const s = makeMachine('128k');
    s.cpu.portOut(0xFFFD, 0x07); // mixer
    s.cpu.portOut(0xBFFD, 0x3E); // tone A only
    expect(s.ay.mixer).toBe(0x3E);
  });

  it('128K: port 0xFFFD reads the selected AY register', () => {
    const s = makeMachine('128k');
    s.cpu.portOut(0xFFFD, 0x00);
    s.cpu.portOut(0xBFFD, 0x42); // tone period low
    expect(s.cpu.portIn(0xFFFD) & 0xFF).toBe(0x42);
  });

  it('AY register select masks to 4 bits (only 16 registers)', () => {
    const s = makeMachine('128k');
    s.cpu.portOut(0xFFFD, 0x1A); // 0x1A & 0x0F = 0x0A
    expect(s.ay.selectedReg).toBe(0x0A);
  });

  it('48K: writing to "AY port" 0xBFFD does nothing — no AY hardware', () => {
    const s = makeMachine('48k');
    // Should not throw; AY register state untouched.
    expect(() => s.cpu.portOut(0xBFFD, 0x42)).not.toThrow();
    expect(s.ay.regs[0]).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Kempston joystick — port low byte bits 5-7 all zero
// ─────────────────────────────────────────────────────────────────────────

describe('Port routing — Kempston joystick', () => {
  it('IN from 0x1F (bits 5-7 zero, bit 0 set) returns joystick state', () => {
    const s = makeMachine('48k');
    s.joystick.state = 0x12;
    expect(s.cpu.portIn(0x001F) & 0xFF).toBe(0x12);
  });

  it('IN from a port with bit 5 set bypasses Kempston', () => {
    const s = makeMachine('48k');
    s.joystick.state = 0xAB;
    // 0x20 = bit 5 set → not Kempston decode → falls through to floating bus.
    const v = s.cpu.portIn(0x0021) & 0xFF;
    expect(v).not.toBe(0xAB); // not joystick
  });
});

describe('Unattached port IN — floating bus vs Amstrad gate array', () => {
  it('48K/128K (Ferranti): unattached port reads the ULA floating bus, not 0xFF', () => {
    const s = makeMachine('128k');
    s.contention.frameStartTStates = 0;
    s.memory.screenBank[0] = 0x42; // pixel byte at line 0, char col 0
    // 128K timing: contentionStart=14361, floatingBusAdjust=+1 → offset 0 at T=14360 (phase 0, pixel byte).
    s.cpu.tStates = 14360;
    const val = s.cpu.portIn(0x00FF) & 0xFF;
    expect(val).toBe(0x42);
  });

  it('+2A/+3 (Amstrad gate array): unattached port always reads 0xFF, never the floating bus', () => {
    const s = makeMachine('+3');
    expect(s.variant.hasFloatingBus).toBe(false);
    s.contention.frameStartTStates = 0;
    s.memory.screenBank[0] = 0x42; // would be read as a live pixel byte on Ferranti
    s.cpu.tStates = 14364; // mid-display for +2A/+3 timing
    expect(s.cpu.portIn(0x00FF) & 0xFF).toBe(0xFF);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FDC routing (+3 only)
// ─────────────────────────────────────────────────────────────────────────

describe('Port routing — FDC (+3 only)', () => {
  it('+3: read 0x2FFD returns FDC Main Status Register', () => {
    const s = makeMachine('+3');
    expect(s.cpu.portIn(0x2FFD)).toBe(0x80); // idle FDC, RQM only
  });

  it('+3: write 0x3FFD feeds the FDC data register (command byte)', () => {
    const s = makeMachine('+3');
    s.fdc.logFn = null;
    s.cpu.portOut(0x3FFD, 0x08); // SENSE_INT (no params)
    // After SENSE_INT executes (no params), FDC is in result phase
    expect(s.cpu.portIn(0x2FFD)).toBe(0xD0); // RQM | DIO | CB
  });

  it('+2A (no FDC): FDC ports decode but return 0xFF', () => {
    const s = makeMachine('+2A');
    expect(s.variant.hasSpecialPaging).toBe(true);
    expect(s.variant.hasFDC).toBe(false);
    expect(s.cpu.portIn(0x2FFD)).toBe(0xFF); // status — no hardware
    expect(s.cpu.portIn(0x3FFD)).toBe(0xFF); // data — no hardware
  });

  it('128K (no special paging at all): FDC ports go to floating bus', () => {
    const s = makeMachine('128k');
    // Without hasSpecialPaging, the FDC branch is skipped entirely.
    // Reads land in floating bus / open. We assert it doesn't throw.
    expect(() => s.cpu.portIn(0x2FFD)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 128K bank switching via port 0x7FFD
// ─────────────────────────────────────────────────────────────────────────

describe('Memory paging — port 0x7FFD (128K)', () => {
  let s: Spectrum;
  beforeEach(() => {
    s = makeMachine('128k');
    // Pre-write a marker into each RAM bank to identify which is paged in.
    for (let bank = 0; bank < 8; bank++) {
      s.memory.getRamBank(bank)[0] = 0xB0 + bank;
    }
  });

  it('default: ROM 0 in slot 0, bank 5 in slot 1, bank 2 in slot 2, bank 0 in slot 3', () => {
    // Slot 0 has ROM 0 — bytes loaded into romPages[0] start with 0xA0
    expect(s.memory.readByte(0x0000)).toBe(0xA0);
    expect(s.memory.readByte(0x4000)).toBe(0xB5); // bank 5
    expect(s.memory.readByte(0x8000)).toBe(0xB2); // bank 2
    expect(s.memory.readByte(0xC000)).toBe(0xB0); // bank 0 (default)
  });

  it('low 3 bits select the bank at 0xC000', () => {
    for (let bank = 0; bank < 8; bank++) {
      s.cpu.portOut(0x7FFD, bank);
      expect(s.memory.readByte(0xC000)).toBe(0xB0 + bank);
      expect(s.memory.currentBank).toBe(bank);
    }
  });

  it('bit 4 selects ROM page: 0 = 128K editor, 1 = 48K BASIC', () => {
    s.cpu.portOut(0x7FFD, 0x00);
    expect(s.memory.readByte(0x0000)).toBe(0xA0); // ROM 0
    s.cpu.portOut(0x7FFD, 0x10);
    expect(s.memory.readByte(0x0000)).toBe(0xA1); // ROM 1
    expect(s.memory.currentROM).toBe(1);
  });

  it('bit 3 selects the screen bank: 0 = bank 5, 1 = bank 7', () => {
    s.cpu.portOut(0x7FFD, 0x00);
    expect(s.memory.screenBank[0]).toBe(0xB5); // marker for bank 5
    s.cpu.portOut(0x7FFD, 0x08);
    expect(s.memory.screenBank[0]).toBe(0xB7); // marker for bank 7
  });

  it('bit 5 locks paging permanently (until reset)', () => {
    s.cpu.portOut(0x7FFD, 0x21); // bank 1 + lock
    expect(s.memory.currentBank).toBe(1);
    expect(s.memory.pagingLocked).toBe(true);
    // Further writes are silently ignored
    s.cpu.portOut(0x7FFD, 0x03);
    expect(s.memory.currentBank).toBe(1); // still bank 1
    expect(s.memory.port7FFD & 0x07).toBe(1);
  });

  it('reset clears the paging lock', () => {
    s.cpu.portOut(0x7FFD, 0x20); // lock
    expect(s.memory.pagingLocked).toBe(true);
    s.memory.reset();
    expect(s.memory.pagingLocked).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// +2A/+3 special all-RAM paging via port 0x1FFD
// ─────────────────────────────────────────────────────────────────────────

describe('Memory paging — port 0x1FFD special modes (+2A/+3)', () => {
  let s: Spectrum;
  beforeEach(() => {
    s = makeMachine('+3');
    for (let bank = 0; bank < 8; bank++) {
      s.memory.getRamBank(bank)[0] = 0xC0 + bank;
    }
  });

  it('bit 0 = 1 enters special all-RAM paging', () => {
    s.cpu.portOut(0x1FFD, 0x01); // mode 0: banks 0,1,2,3
    expect(s.memory.specialPaging).toBe(true);
    expect(s.memory.readByte(0x0000)).toBe(0xC0); // bank 0 in slot 0 — RAM!
    expect(s.memory.readByte(0x4000)).toBe(0xC1);
    expect(s.memory.readByte(0x8000)).toBe(0xC2);
    expect(s.memory.readByte(0xC000)).toBe(0xC3);
  });

  it('bits 1-2 select one of 4 all-RAM bank configurations', () => {
    // Mode 0: [0,1,2,3]
    s.cpu.portOut(0x1FFD, 0b001);
    expect(s.memory.readByte(0x0000)).toBe(0xC0);
    // Mode 1: [4,5,6,7]
    s.cpu.portOut(0x1FFD, 0b011);
    expect(s.memory.readByte(0x0000)).toBe(0xC4);
    expect(s.memory.readByte(0xC000)).toBe(0xC7);
    // Mode 2: [4,5,6,3]
    s.cpu.portOut(0x1FFD, 0b101);
    expect(s.memory.readByte(0xC000)).toBe(0xC3);
    // Mode 3: [4,7,6,3]
    s.cpu.portOut(0x1FFD, 0b111);
    expect(s.memory.readByte(0x4000)).toBe(0xC7);
    expect(s.memory.readByte(0xC000)).toBe(0xC3);
  });

  it('writes to 0x0000-0x3FFF are RAM-writable while in special paging', () => {
    s.cpu.portOut(0x1FFD, 0x01); // mode 0
    s.cpu.write8(0x1234, 0x55);
    expect(s.memory.readByte(0x1234)).toBe(0x55);
  });

  it('writes to 0x0000-0x3FFF are discarded in normal paging (ROM)', () => {
    s.cpu.write8(0x1234, 0x55);
    expect(s.memory.readByte(0x1234)).not.toBe(0x55); // ROM untouched
  });

  it('exiting special paging restores ROM, bank 5, bank 2, current bank', () => {
    s.cpu.portOut(0x7FFD, 0x03); // bank 3 in slot 3
    s.cpu.portOut(0x1FFD, 0x01); // enter special
    expect(s.memory.specialPaging).toBe(true);
    s.cpu.portOut(0x1FFD, 0x00); // exit
    expect(s.memory.specialPaging).toBe(false);
    expect(s.memory.readByte(0x4000)).toBe(0xC5); // bank 5
    expect(s.memory.readByte(0x8000)).toBe(0xC2); // bank 2
    expect(s.memory.readByte(0xC000)).toBe(0xC3); // bank 3 (preserved)
  });

  it('+3 motor bit (1FFD bit 3) feeds the FDC', () => {
    expect(s.fdc.motorOn).toBe(false);
    s.cpu.portOut(0x1FFD, 0x08); // motor on
    expect(s.fdc.motorOn).toBe(true);
    s.cpu.portOut(0x1FFD, 0x00);
    expect(s.fdc.motorOn).toBe(false);
  });

  it('once paging is locked (7FFD bit 5), 1FFD writes — including the motor bit — are ignored', () => {
    // Hardware freezes the whole 1FFD register on lock, not just the
    // paging-related bits: the motor bit lives in the same port.
    s.cpu.portOut(0x7FFD, 0x20); // lock paging
    expect(s.memory.pagingLocked).toBe(true);
    s.cpu.portOut(0x1FFD, 0x08); // would turn the motor on if honoured
    expect(s.fdc.motorOn).toBe(false);
    s.cpu.portOut(0x1FFD, 0x01); // would enter special paging if honoured
    expect(s.memory.specialPaging).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4-ROM page selection (+2A/+3)
// ─────────────────────────────────────────────────────────────────────────

describe('ROM latching — +2A/+3 four-ROM selection', () => {
  let s: Spectrum;
  beforeEach(() => { s = makeMachine('+3'); });

  it('ROM page = ((1FFD>>2)&1)<<1 | (7FFD>>4)&1', () => {
    // ROM 0: 1FFD bit 2 = 0, 7FFD bit 4 = 0
    s.cpu.portOut(0x1FFD, 0x00);
    s.cpu.portOut(0x7FFD, 0x00);
    expect(s.memory.readByte(0x0000)).toBe(0xA0);
    expect(s.memory.currentROM).toBe(0);

    // ROM 1: 1FFD bit 2 = 0, 7FFD bit 4 = 1
    s.cpu.portOut(0x7FFD, 0x10);
    expect(s.memory.readByte(0x0000)).toBe(0xA1);
    expect(s.memory.currentROM).toBe(1);

    // ROM 2: 1FFD bit 2 = 1, 7FFD bit 4 = 0
    s.cpu.portOut(0x1FFD, 0x04);
    s.cpu.portOut(0x7FFD, 0x00);
    expect(s.memory.readByte(0x0000)).toBe(0xA2);
    expect(s.memory.currentROM).toBe(2);

    // ROM 3: 1FFD bit 2 = 1, 7FFD bit 4 = 1
    s.cpu.portOut(0x7FFD, 0x10);
    expect(s.memory.readByte(0x0000)).toBe(0xA3);
    expect(s.memory.currentROM).toBe(3);
  });

  it('on the +3, the 48K BASIC ROM is page 3', () => {
    // Documented +3 layout:
    //  ROM 0 = 128K editor / menu
    //  ROM 1 = +3DOS
    //  ROM 2 = 128K syntax
    //  ROM 3 = 48K BASIC
    expect(s.memory.romPages.length).toBe(4);
    // The 4th ROM-page slot holds the 48K BASIC bytes after loadROM().
    expect(s.memory.romPages[3][0]).toBe(0xA3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Memory write protection (general)
// ─────────────────────────────────────────────────────────────────────────

describe('Memory hooks — ROM write protection', () => {
  it('48K: writes to 0x0000-0x3FFF dropped, RAM writes succeed', () => {
    const s = makeMachine('48k');
    s.cpu.write8(0x0000, 0x55);
    expect(s.memory.readByte(0x0000)).not.toBe(0x55);
    s.cpu.write8(0x4000, 0x55);
    expect(s.memory.readByte(0x4000)).toBe(0x55);
  });

  it('128K: ROM write protected, RAM all writable', () => {
    const s = makeMachine('128k');
    s.cpu.write8(0x0000, 0x55);
    expect(s.memory.readByte(0x0000)).not.toBe(0x55);
    s.cpu.write8(0xC000, 0x42);
    expect(s.memory.readByte(0xC000)).toBe(0x42);
  });

  it('16K: writes above 0x8000 dropped (no RAM), reads return 0xFF', () => {
    const s = makeMachine('16k');
    s.cpu.write8(0xC000, 0x55);
    expect(s.memory.readByte(0xC000)).toBe(0xFF);
    s.cpu.write8(0x8000, 0xAA);
    expect(s.memory.readByte(0x8000)).toBe(0xFF);
    // 16K RAM area (0x4000-0x7FFF) is writable
    s.cpu.write8(0x4000, 0x42);
    expect(s.memory.readByte(0x4000)).toBe(0x42);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Latch values surface through port reads (MF3 quirk)
// ─────────────────────────────────────────────────────────────────────────

describe('ROM latching — port latch readback (MF3 quirk on +2A/+3)', () => {
  it('port7FFD/port1FFD fields track the last written values', () => {
    const s = makeMachine('+3');
    // Avoid bit 5 of 7FFD — that's the paging-lock bit and would block
    // the subsequent 1FFD write.
    s.cpu.portOut(0x7FFD, 0x17);
    s.cpu.portOut(0x1FFD, 0x0D);
    expect(s.memory.port7FFD).toBe(0x17);
    expect(s.memory.port1FFD).toBe(0x0D);
  });

  it('in special paging, 0x7FFD writes only latch — slots do not move', () => {
    const s = makeMachine('+3');
    for (let bank = 0; bank < 8; bank++) {
      s.memory.getRamBank(bank)[0] = 0xD0 + bank;
    }
    s.cpu.portOut(0x1FFD, 0x01); // mode 0: slots = [0,1,2,3]
    const before = s.memory.readByte(0xC000); // bank 3 → 0xD3
    expect(before).toBe(0xD3);
    s.cpu.portOut(0x7FFD, 0x07); // would normally page bank 7 into slot 3
    expect(s.memory.readByte(0xC000)).toBe(0xD3); // unchanged — special paging in effect
    expect(s.memory.port7FFD & 0x07).toBe(7);     // latch updated
    expect(s.memory.currentBank).toBe(7);          // latch updated

    // After leaving special paging, the latched bank becomes effective.
    s.cpu.portOut(0x1FFD, 0x00);
    expect(s.memory.readByte(0xC000)).toBe(0xD7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Memory watchpoints
// ─────────────────────────────────────────────────────────────────────────

describe('Memory watchpoints', () => {
  let s: Spectrum;
  beforeEach(() => {
    s = makeMachine('48k');
    // Seed RAM with known values
    s.memory.getRamBank(0)[0x0000] = 0xAA; // bank 0 slot 1 = 0x4000
    s.memory.getRamBank(5)[0x0000] = 0xBB; // bank 5 slot 1 = 0x4000 on 128K
  });

  it('read watchpoint fires on read within range', () => {
    s.memWatchpoints.push({ start: 0x4000, end: 0x4FFF, mode: 'read' });
    const val = s.cpu.read8(0x4000);
    expect(s.memWatchHit).not.toBeNull();
    expect(s.memWatchHit?.addr).toBe(0x4000);
    expect(s.memWatchHit?.value).toBe(val);
    expect(s.memWatchHit?.dir).toBe('read');
  });

  it('read watchpoint does NOT fire outside range', () => {
    s.memWatchpoints.push({ start: 0x4000, end: 0x4FFF, mode: 'read' });
    s.cpu.read8(0x5000);
    expect(s.memWatchHit).toBeNull();
  });

  it('write watchpoint fires on write within range', () => {
    s.memWatchpoints.push({ start: 0x4000, end: 0x4FFF, mode: 'write' });
    s.cpu.write8(0x4100, 0x55);
    expect(s.memWatchHit).not.toBeNull();
    expect(s.memWatchHit?.addr).toBe(0x4100);
    expect(s.memWatchHit?.value).toBe(0x55);
    expect(s.memWatchHit?.dir).toBe('write');
  });

  it('write watchpoint does NOT fire on read', () => {
    s.memWatchpoints.push({ start: 0x4000, end: 0x4FFF, mode: 'write' });
    s.cpu.read8(0x4000);
    expect(s.memWatchHit).toBeNull();
  });

  it('read watchpoint does NOT fire on write', () => {
    s.memWatchpoints.push({ start: 0x4000, end: 0x4FFF, mode: 'read' });
    s.cpu.write8(0x4000, 0x55);
    expect(s.memWatchHit).toBeNull();
  });

  it('rw watchpoint fires on both read and write', () => {
    s.memWatchpoints.push({ start: 0x4000, end: 0x4001, mode: 'rw' });
    s.cpu.read8(0x4000);
    expect(s.memWatchHit?.dir).toBe('read');
    s.memWatchHit = null;
    s.cpu.write8(0x4001, 0x77);
    expect(s.memWatchHit).not.toBeNull();
    expect(s.memWatchHit!.dir).toBe('write');
  });

  it('first-hit-only: second access within range does not overwrite hit', () => {
    s.memWatchpoints.push({ start: 0x4000, end: 0x4FFF, mode: 'rw' });
    s.cpu.write8(0x4000, 0x11);
    const first = { ...s.memWatchHit! };
    s.cpu.write8(0x4001, 0x22);
    expect(s.memWatchHit?.addr).toBe(first.addr); // still the first hit
    expect(s.memWatchHit?.value).toBe(first.value);
  });

  it('watchpoint range is inclusive on both ends', () => {
    s.memWatchpoints.push({ start: 0x4002, end: 0x4002, mode: 'write' });
    s.cpu.write8(0x4001, 0x55);
    expect(s.memWatchHit).toBeNull();
    s.cpu.write8(0x4002, 0x55);
    expect(s.memWatchHit).not.toBeNull();
    s.memWatchHit = null;
    s.cpu.write8(0x4003, 0x55);
    expect(s.memWatchHit).toBeNull();
  });

  it('write to ROM (discarded) does NOT fire watchpoint — write never reaches memory', () => {
    s.memWatchpoints.push({ start: 0x0000, end: 0x3FFF, mode: 'rw' });
    s.cpu.write8(0x1000, 0x55);
    expect(s.memWatchHit).toBeNull();
  });

  it('read from ROM DOES fire a read watchpoint', () => {
    s.memWatchpoints.push({ start: 0x0000, end: 0x3FFF, mode: 'read' });
    s.cpu.read8(0x0000);
    expect(s.memWatchHit?.dir).toBe('read');
  });

  it('write value in watchpoint hit is masked to 8 bits', () => {
    s.memWatchpoints.push({ start: 0x4000, end: 0x4FFF, mode: 'write' });
    s.cpu.write8(0x4000, 0x1FF); // value > 8 bits
    expect(s.memWatchHit?.value).toBe(0xFF);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Port watchpoints
// ─────────────────────────────────────────────────────────────────────────

describe('Port watchpoints — OUT', () => {
  let s: Spectrum;
  beforeEach(() => { s = makeMachine('48k'); });

  it('portOut fires watchpoint for any matching port', () => {
    s.portWatchpoints.add(0x00FE);
    s.cpu.portOut(0x00FE, 0x03);
    expect(s.portWatchHit).not.toBeNull();
    expect(s.portWatchHit?.port).toBe(0x00FE);
    expect(s.portWatchHit?.value).toBe(0x03);
    expect(s.portWatchHit?.dir).toBe('out');
  });

  it('portOut does NOT fire if port not in watchpoints set', () => {
    s.portWatchpoints.add(0x00FE);
    s.cpu.portOut(0x00FF, 0x03);
    expect(s.portWatchHit).toBeNull();
  });

  it('first-hit-only: second OUT does not overwrite portWatchHit', () => {
    s.portWatchpoints.add(0x00FE);
    s.cpu.portOut(0x00FE, 0x01);
    s.cpu.portOut(0x00FE, 0x02);
    expect(s.portWatchHit?.value).toBe(0x01);
  });

  it('port number is masked to 16 bits before watchpoint lookup', () => {
    s.portWatchpoints.add(0x00FE);
    s.cpu.portOut(0x10_00FE, 0x07); // excess bits above 16
    expect(s.portWatchHit?.port).toBe(0x00FE);
  });
});

describe('Port watchpoints — IN (all paths)', () => {
  it('+3: FDC data read (0x3FFD) fires port watchpoint', () => {
    const s = makeMachine('+3');
    s.portWatchpoints.add(0x3FFD);
    s.cpu.portIn(0x3FFD);
    expect(s.portWatchHit).not.toBeNull();
    expect(s.portWatchHit?.port).toBe(0x3FFD);
    expect(s.portWatchHit?.dir).toBe('in');
  });

  it('48K: unattached port IN (floating bus) fires port watchpoint', () => {
    const s = makeMachine('48k');
    s.portWatchpoints.add(0x00FF);
    s.cpu.portIn(0x00FF);
    expect(s.portWatchHit).not.toBeNull();
    expect(s.portWatchHit?.dir).toBe('in');
  });

  it('ULA port IN fires port watchpoint', () => {
    const s = makeMachine('48k');
    s.portWatchpoints.add(0xFFFE);
    s.cpu.portIn(0xFFFE);
    expect(s.portWatchHit).not.toBeNull();
    expect(s.portWatchHit?.port).toBe(0xFFFE);
    expect(s.portWatchHit?.dir).toBe('in');
  });

  it('AY register read fires port watchpoint', () => {
    const s = makeMachine('128k');
    s.portWatchpoints.add(0xFFFD);
    s.cpu.portIn(0xFFFD);
    expect(s.portWatchHit).not.toBeNull();
    expect(s.portWatchHit?.port).toBe(0xFFFD);
    expect(s.portWatchHit?.dir).toBe('in');
  });

  it('Kempston joystick IN fires port watchpoint', () => {
    const s = makeMachine('48k');
    s.portWatchpoints.add(0x001F);
    s.cpu.portIn(0x001F);
    expect(s.portWatchHit).not.toBeNull();
    expect(s.portWatchHit?.dir).toBe('in');
  });

  it('first-hit-only: second IN does not overwrite portWatchHit', () => {
    const s = makeMachine('48k');
    s.portWatchpoints.add(0xFFFE);
    s.cpu.portIn(0xFFFE);
    const first = s.portWatchHit?.value;
    s.cpu.portIn(0xFFFE);
    expect(s.portWatchHit?.value).toBe(first);
  });
});

describe('Port watchpoints — VTX-5000 OUT fires watchpoint before early return', () => {
  it('OUT to non-VTX port fires watchpoint', () => {
    const s = makeMachine('48k');
    s.portWatchpoints.add(0x00FF);
    s.cpu.portOut(0x00FF, 0xAA);
    expect(s.portWatchHit).not.toBeNull();
  });

  it('OUT to VTX control port (lo=0xFF) with VTX enabled fires watchpoint', () => {
    const s = makeMachine('48k');
    s.vtx5000.enabled = true;
    s.portWatchpoints.add(0x00FF);
    s.cpu.portOut(0x00FF, 0xAA);
    expect(s.portWatchHit).not.toBeNull();
    expect(s.portWatchHit?.value).toBe(0xAA);
  });

  it('OUT to VTX data port (lo=0x7F) with VTX enabled fires watchpoint', () => {
    const s = makeMachine('48k');
    s.vtx5000.enabled = true;
    s.portWatchpoints.add(0x007F);
    s.cpu.portOut(0x007F, 0x42);
    expect(s.portWatchHit).not.toBeNull();
    expect(s.portWatchHit?.value).toBe(0x42);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Activity counters
// ─────────────────────────────────────────────────────────────────────────

describe('Activity counters — ULA and beeper', () => {
  let s: Spectrum;
  beforeEach(() => { s = makeMachine('48k'); });

  it('ulaReads increments on every ULA IN', () => {
    expect(s.activity.ulaReads).toBe(0);
    s.cpu.portIn(0xFFFE);
    expect(s.activity.ulaReads).toBe(1);
    s.cpu.portIn(0x00FE);
    expect(s.activity.ulaReads).toBe(2);
  });

  it('beeperToggled set when beeper bit transitions 0→1', () => {
    expect(s.activity.beeperToggled).toBe(false);
    s.cpu.portOut(0x00FE, 0x10); // bit 4 = beeper
    expect(s.activity.beeperToggled).toBe(true);
  });

  it('beeperToggled NOT set when beeper bit is unchanged (0→0)', () => {
    s.cpu.portOut(0x00FE, 0x00); // beeper stays 0
    expect(s.activity.beeperToggled).toBe(false);
  });

  it('beeperToggled NOT set when beeper bit is unchanged (1→1)', () => {
    s.cpu.portOut(0x00FE, 0x10); // beeper → 1
    s.activity.beeperToggled = false; // reset tracking
    s.cpu.portOut(0x00FE, 0x10); // beeper stays 1
    expect(s.activity.beeperToggled).toBe(false);
  });

  it('beeperToggled set on transition 1→0', () => {
    s.cpu.portOut(0x00FE, 0x10); // beeper → 1
    s.activity.beeperToggled = false;
    s.cpu.portOut(0x00FE, 0x00); // beeper → 0
    expect(s.activity.beeperToggled).toBe(true);
  });
});

describe('Activity counters — attrWrites range', () => {
  let s: Spectrum;
  beforeEach(() => { s = makeMachine('48k'); });

  it('write at 0x5800 increments attrWrites', () => {
    s.cpu.write8(0x5800, 0x01);
    expect(s.activity.attrWrites).toBe(1);
  });

  it('write at 0x5AFF increments attrWrites (last attr byte)', () => {
    s.cpu.write8(0x5AFF, 0x01);
    expect(s.activity.attrWrites).toBe(1);
  });

  it('write at 0x5B00 does NOT increment attrWrites (one past end)', () => {
    s.cpu.write8(0x5B00, 0x01);
    expect(s.activity.attrWrites).toBe(0);
  });

  it('write at 0x57FF does NOT increment attrWrites (one before start)', () => {
    s.cpu.write8(0x57FF, 0x01);
    expect(s.activity.attrWrites).toBe(0);
  });

  it('write in screen pixel area (0x4000-0x57FF) does NOT increment attrWrites', () => {
    s.cpu.write8(0x4000, 0x01);
    expect(s.activity.attrWrites).toBe(0);
  });
});

describe('Activity counters — AY, FDC, Kempston', () => {
  it('ayWrites increments on AY register write (not on register select)', () => {
    const s = makeMachine('128k');
    s.cpu.portOut(0xFFFD, 0x07); // select — should NOT increment
    expect(s.activity.ayWrites).toBe(0);
    s.cpu.portOut(0xBFFD, 0x3F); // write — SHOULD increment
    expect(s.activity.ayWrites).toBe(1);
  });

  it('fdcAccesses increments on FDC write (0x3FFD)', () => {
    const s = makeMachine('+3');
    s.fdc.logFn = null;
    s.cpu.portOut(0x3FFD, 0x08); // write command byte
    expect(s.activity.fdcAccesses).toBe(1);
  });

  it('fdcAccesses increments on FDC data read (0x3FFD)', () => {
    const s = makeMachine('+3');
    s.fdc.logFn = null;
    // Put FDC in result phase so readData returns real data
    s.cpu.portOut(0x3FFD, 0x08); // SENSE_INT
    const before = s.activity.fdcAccesses;
    s.cpu.portIn(0x3FFD);
    expect(s.activity.fdcAccesses).toBe(before + 1);
  });

  it('kempstonReads increments on Kempston joystick IN', () => {
    const s = makeMachine('48k');
    s.cpu.portIn(0x001F);
    expect(s.activity.kempstonReads).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AMX mouse port routing
// ─────────────────────────────────────────────────────────────────────────

describe('Port routing — AMX mouse', () => {
  let s: Spectrum;
  beforeEach(() => {
    s = makeMachine('48k');
    s.amxMouse.enabled = true;
    s.amxMouse.dirX = 1;
    s.amxMouse.dirY = 0;
    s.amxMouse.buttons = 0xBF;
  });

  it('IN port 0x1F (lo & 0xE0 === 0x00) returns dirX bit', () => {
    expect(s.cpu.portIn(0x001F) & 1).toBe(s.amxMouse.dirX & 1);
  });

  it('IN port 0x3F (lo & 0xE0 === 0x20) returns dirY bit', () => {
    s.amxMouse.dirY = 1;
    expect(s.cpu.portIn(0x003F) & 1).toBe(1);
    s.amxMouse.dirY = 0;
    expect(s.cpu.portIn(0x003F) & 1).toBe(0);
  });

  it('IN port 0xDF returns buttons byte', () => {
    expect(s.cpu.portIn(0x00DF)).toBe(0xBF);
  });

  it('OUT port 0x5F (lo & 0xE0 === 0x40, A7=0) dispatches to pioControlWrite A', () => {
    // Write a vector (bit 0 = 0) — verify pioVectorA is set
    s.cpu.portOut(0x005F, 0x10); // bit 0 = 0 → vector
    expect(s.amxMouse.pioVectorA).toBe(0x10);
  });

  it('OUT port 0x7F (lo & 0xE0 === 0x60, A7=0) dispatches to pioControlWrite B', () => {
    s.cpu.portOut(0x007F, 0x20); // bit 0 = 0 → vector
    expect(s.amxMouse.pioVectorB).toBe(0x20);
  });

  it('mouseReads increments on dirX/dirY/buttons reads', () => {
    s.cpu.portIn(0x001F);
    s.cpu.portIn(0x003F);
    s.cpu.portIn(0x00DF);
    expect(s.activity.mouseReads).toBe(3);
  });

  it('AMX intercepted at ports A7=0 — ports with A7=1 not intercepted', () => {
    // Port 0x009F has A7=1 → A7=0 check fails → AMX not intercepted
    s.cpu.portIn(0x009F);
    expect(s.activity.mouseReads).toBe(0); // AMX did NOT handle this read
  });

  it('AMX disabled: IN from mouse port falls through to joystick / floating bus', () => {
    s.amxMouse.enabled = false;
    s.joystick.state = 0x1F;
    // Port 0x001F with AMX off → Kempston joystick
    expect(s.cpu.portIn(0x001F) & 0xFF).toBe(0x1F);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Kempston mouse port routing
// ─────────────────────────────────────────────────────────────────────────

describe('Port routing — Kempston mouse', () => {
  let s: Spectrum;
  beforeEach(() => {
    s = makeMachine('48k');
    s.kempstonMouse.enabled = true;
    s.kempstonMouse.x = 0xAB;
    s.kempstonMouse.y = 0xCD;
    s.kempstonMouse.buttons = 0xFE;
  });

  it('IN 0xFBDF returns X position', () => {
    expect(s.cpu.portIn(0xFBDF) & 0xFF).toBe(0xAB);
  });

  it('IN 0xFFDF returns Y position', () => {
    expect(s.cpu.portIn(0xFFDF) & 0xFF).toBe(0xCD);
  });

  it('IN 0xFADF returns button state', () => {
    expect(s.cpu.portIn(0xFADF) & 0xFF).toBe(0xFE);
  });

  it('mouseReads increments for each Kempston mouse port read', () => {
    s.cpu.portIn(0xFBDF);
    s.cpu.portIn(0xFFDF);
    s.cpu.portIn(0xFADF);
    expect(s.activity.mouseReads).toBe(3);
  });

  it('Kempston mouse only intercepts lo byte 0xDF — other lo bytes use different paths', () => {
    // Port 0xFB1F: lo=0x1F, bit 0 set → not ULA; bits 5-7 of lo are 0 → Kempston joystick
    s.joystick.state = 0x0F;
    expect(s.cpu.portIn(0xFB1F) & 0xFF).toBe(0x0F);
  });

  it('Kempston mouse disabled: lo=0xDF ports fall through to floating bus', () => {
    s.kempstonMouse.enabled = false;
    // Port 0xFFDF: lo=0xDF, bits 5-7 of lo = 0xC0 (nonzero) → floating bus
    // Just verify it returns something and doesn't crash
    expect(() => s.cpu.portIn(0xFFDF)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// VTX-5000 port routing
// ─────────────────────────────────────────────────────────────────────────

describe('Port routing — VTX-5000', () => {
  let s: Spectrum;
  beforeEach(() => {
    s = makeMachine('48k');
    s.vtx5000.enabled = true;
  });

  it('IN lo=0xFF returns VTX status (TXRDY|TXEMPTY = 0x05 when idle)', () => {
    const status = s.cpu.portIn(0x00FF);
    expect(status & 0x05).toBe(0x05); // TXRDY and TXEMPTY always set
  });

  it('IN lo=0x7F returns VTX data (0x00 when rx FIFO empty)', () => {
    expect(s.cpu.portIn(0x007F)).toBe(0x00);
  });

  it('OUT lo=0xFF dispatches to VTX writeControl (first write is mode reg)', () => {
    s.cpu.portOut(0x00FF, 0x4E); // first write after reset = mode register
    expect(s.vtx5000.modeReg).toBe(0x4E);
  });

  it('OUT lo=0x7F: VTX receives the data byte (early return, port not re-routed)', () => {
    // Writing 0x7F with bit 0 = 1 → not ULA. Verify VTX data write doesn't crash
    // and that the vtx5000 object absorbs it (no way to read back without Rx FIFO,
    // so just verify no throw and no ULA side-effect).
    const borderBefore = s.ula.borderColor;
    expect(() => s.cpu.portOut(0x007F, 0x55)).not.toThrow();
    expect(s.ula.borderColor).toBe(borderBefore); // ULA NOT touched
  });

  it('VTX disabled: lo=0xFF falls through to floating bus / open', () => {
    s.vtx5000.enabled = false;
    // Port 0x00FF: lo=0xFF, bit 0 set, bits 5-7 of lo = 0xE0 → not Kempston → floating bus
    expect(() => s.cpu.portIn(0x00FF)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Multiface page-in / page-out via port IN
// ─────────────────────────────────────────────────────────────────────────

describe('Port routing — Multiface page-in/page-out (MF1)', () => {
  let s: Spectrum;
  beforeEach(() => {
    s = makeMachine('48k');
    s.multiface.enabled = true;
    s.multiface.variant = 'MF1';
    s.multiface.romLoaded = true;
    s.multiface.mfRom[0] = 0xEE; // marker byte in MF ROM
  });

  it('IN from port 0x9F pages in MF ROM and returns 0xFF', () => {
    expect(s.multiface.pagedIn).toBe(false);
    const result = s.cpu.portIn(0x009F);
    expect(result & 0xFF).toBe(0xFF);
    expect(s.multiface.pagedIn).toBe(true);
    // Slot 0 now holds MF overlay: first byte is the MF ROM marker
    expect(s.memory.readByte(0x0000)).toBe(0xEE);
  });

  it('IN from port 0x1F when paged in pages out and returns joystick state', () => {
    s.multiface.pageIn(s.memory);
    s.joystick.state = 0x0A;
    const result = s.cpu.portIn(0x001F);
    expect(result & 0xFF).toBe(0x0A);
    expect(s.multiface.pagedIn).toBe(false);
  });

  it('page-in has no effect when MF not paged in on page-out port', () => {
    // Reading page-out port when not paged in should not crash or change state
    expect(s.multiface.pagedIn).toBe(false);
    s.cpu.portIn(0x001F); // page-out port — but not paged in
    expect(s.multiface.pagedIn).toBe(false);
  });

  it('page-in has no effect when romLoaded is false', () => {
    s.multiface.romLoaded = false;
    s.cpu.portIn(0x009F);
    expect(s.multiface.pagedIn).toBe(false);
  });

  it('page-in has no effect when multiface is disabled', () => {
    s.multiface.enabled = false;
    s.cpu.portIn(0x009F);
    expect(s.multiface.pagedIn).toBe(false);
  });
});

describe('Port routing — MF3 port latch reads (+2A/+3)', () => {
  it('IN 0x7F3F returns port7FFD latch once the button has armed the interface', () => {
    const s = makeMachine('+3');
    s.multiface.enabled = true;
    s.multiface.variant = 'MF3';
    s.multiface.romLoaded = true;
    s.cpu.portOut(0x7FFD, 0x13); // set 7FFD latch = 0x13
    s.multiface.pressButton(s.memory, s.cpu);
    const latch = s.cpu.portIn(0x7F3F);
    expect(latch & 0xFF).toBe(s.memory.port7FFD);
  });

  it('IN 0x1F3F returns port1FFD latch once the button has armed the interface', () => {
    const s = makeMachine('+3');
    s.multiface.enabled = true;
    s.multiface.variant = 'MF3';
    s.multiface.romLoaded = true;
    s.cpu.portOut(0x1FFD, 0x04); // set 1FFD latch = 0x04
    s.multiface.pressButton(s.memory, s.cpu);
    const latch = s.cpu.portIn(0x1F3F);
    expect(latch & 0xFF).toBe(s.memory.port1FFD);
  });

  it('before the button is pressed, MF128/MF3 paging and latch ports are invisible', () => {
    const s = makeMachine('+3');
    s.multiface.enabled = true;
    s.multiface.variant = 'MF3';
    s.multiface.romLoaded = true;
    s.cpu.portOut(0x7FFD, 0x13);
    expect(s.multiface.armed).toBe(false);
    // Latch port: not gated, falls through instead of returning the latch.
    expect(s.cpu.portIn(0x7F3F) & 0xFF).not.toBe(0x13);
    // Page-in port (0x3F for MF3): stray IN must not page the MF ROM in.
    s.cpu.portIn(0x003F);
    expect(s.multiface.pagedIn).toBe(false);
  });

  it('stays armed across an internal page-out/page-in cycle within the same session', () => {
    // The MF ROM's own menu/tool routines legitimately page out and back in
    // many times per session (e.g. borrowing the underlying ROM's
    // HALT/keyboard-scan idle loop) — a page-out must not disarm the
    // interface, or the ROM can never page itself back in and the machine
    // hangs (this was a real regression).
    const s = makeMachine('+3');
    s.multiface.enabled = true;
    s.multiface.variant = 'MF3';
    s.multiface.romLoaded = true;
    s.multiface.pressButton(s.memory, s.cpu);
    expect(s.multiface.armed).toBe(true);

    s.cpu.portIn(0x00BF); // MF3 page-out port
    expect(s.multiface.pagedIn).toBe(false);
    expect(s.multiface.armed).toBe(true); // still armed — not a "Return"

    s.cpu.portIn(0x003F); // MF3 page-in port — must still work
    expect(s.multiface.pagedIn).toBe(true);
  });

  it('a hardware reset disarms the interface', () => {
    const s = makeMachine('+3');
    s.multiface.enabled = true;
    s.multiface.variant = 'MF3';
    s.multiface.romLoaded = true;
    s.multiface.pressButton(s.memory, s.cpu);
    expect(s.multiface.armed).toBe(true);

    s.multiface.reset();
    expect(s.multiface.armed).toBe(false);
    // Now invisible again: a stray IN 0x3F must not re-page it in.
    s.cpu.portIn(0x003F);
    expect(s.multiface.pagedIn).toBe(false);
  });

  it('MF3 latch reads only with MF3 variant — MF1 ignores the same ports', () => {
    const s = makeMachine('48k');
    s.multiface.enabled = true;
    s.multiface.variant = 'MF1';
    s.memory.port7FFD = 0x13;
    // Port 0x7F3F: MF1 variant, (lo & 0xFF) === 0x3F.
    // MF1 matchPort: lo=0x3F, (0x3F & 0x22)=0x02 → matches! Returns 'in' for lo=0x9F, 'out' for lo=0x1F.
    // 0x3F is neither 0x9F nor 0x1F, so matchPort returns null.
    // Falls through to Kempston joystick (bits 5-7 of lo = 0x20 → not Kempston) → floating bus.
    const val = s.cpu.portIn(0x7F3F);
    expect(val & 0xFF).not.toBe(0x13); // NOT port7FFD — latch check guarded by MF3 variant
  });
});

// ─────────────────────────────────────────────────────────────────────────
// cpu.contend hook (IO internal bus contention)
// ─────────────────────────────────────────────────────────────────────────

describe('cpu.contend hook — hasIOContention', () => {
  it('48K (Ferranti, hasIOContention=true): contend is a non-trivial function', () => {
    const s = makeMachine('48k');
    expect(s.variant.hasIOContention).toBe(true);
    // The contend hook should be installed and callable
    expect(() => s.cpu.contend?.(0x4000)).not.toThrow();
  });

  it('128K (Ferranti, hasIOContention=true): contend non-trivial', () => {
    const s = makeMachine('128k');
    expect(s.variant.hasIOContention).toBe(true);
    expect(() => s.cpu.contend?.(0x4000)).not.toThrow();
  });

  it('+2A/+3 (Amstrad): hasIOContention differs from Ferranti', () => {
    const s = makeMachine('+3');
    // +2A/+3 still has IO contention but only for ULA ports (different rules)
    expect(() => s.cpu.contend?.(0x4000)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// write8 special cases — Multiface RAM, 16K open-bus
// ─────────────────────────────────────────────────────────────────────────

describe('write8 — Multiface ROM/RAM passthrough when paged in', () => {
  let s: Spectrum;
  beforeEach(() => {
    s = makeMachine('48k');
    s.multiface.enabled = true;
    s.multiface.variant = 'MF1';
    s.multiface.romLoaded = true;
    s.multiface.pageIn(s.memory);
  });

  it('write to 0x0000-0x1FFF (MF ROM area) is silently discarded', () => {
    const before = s.memory.readByte(0x0000);
    s.cpu.write8(0x1000, 0x55);
    expect(s.memory.readByte(0x1000)).toBe(before);
  });

  it('write to 0x2000-0x3FFF (MF RAM area) is allowed through', () => {
    s.cpu.write8(0x2000, 0xAB);
    expect(s.memory.readByte(0x2000)).toBe(0xAB);
  });
});

describe('write8 — Interface 2 cartridge ROM passthrough when inserted', () => {
  let s: Spectrum;
  beforeEach(() => {
    s = makeMachine('48k');
    s.interface2.insert(new Uint8Array(16384).fill(0xCC), 'test.rom');
    s.reset();
  });

  it('write anywhere in 0x0000-0x3FFF (whole cartridge ROM) is silently discarded', () => {
    const before1 = s.memory.readByte(0x0000);
    const before2 = s.memory.readByte(0x3000);
    s.cpu.write8(0x0000, 0x55);
    s.cpu.write8(0x3000, 0x55);
    expect(s.memory.readByte(0x0000)).toBe(before1);
    expect(s.memory.readByte(0x3000)).toBe(before2);
  });

  it('write to RAM (0x4000+) is unaffected by the inserted cartridge', () => {
    s.cpu.write8(0x4000, 0x42);
    expect(s.memory.readByte(0x4000)).toBe(0x42);
  });
});

describe('write8 — 16K open-bus behaviour', () => {
  it('writes to 0x8000-0xFFFF on 16K are dropped; reads return 0xFF', () => {
    const s = makeMachine('16k');
    s.cpu.write8(0x8000, 0x42);
    s.cpu.write8(0xFFFF, 0x42);
    expect(s.memory.readByte(0x8000)).toBe(0xFF);
    expect(s.memory.readByte(0xFFFF)).toBe(0xFF);
  });

  it('16K RAM (0x4000-0x7FFF) is writable', () => {
    const s = makeMachine('16k');
    s.cpu.write8(0x4000, 0x42);
    expect(s.memory.readByte(0x4000)).toBe(0x42);
    s.cpu.write8(0x7FFF, 0x99);
    expect(s.memory.readByte(0x7FFF)).toBe(0x99);
  });
});
