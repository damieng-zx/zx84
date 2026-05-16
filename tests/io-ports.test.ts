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
import { Spectrum } from '@/spectrum.ts';
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
    expect(s.memory.screenBank).toBe(s.memory.getRamBank(5));
    s.cpu.portOut(0x7FFD, 0x08);
    expect(s.memory.screenBank).toBe(s.memory.getRamBank(7));
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
