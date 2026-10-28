/**
 * The Commodore 64 board: the PLA's memory map, the VIC-II's raster
 * interrupt and bad-line hold, the read-modify-write acknowledge programs
 * use on $D019, the native snapshot, and — with the real ROMs under
 * mcp/.cache — booting to BASIC, typing a program and a tape round trip
 * through the KERNAL's own SAVE and LOAD.
 *
 * Expectations come from the hardware: the PLA table in the C64 Programmer's
 * Reference Guide (LORAM/HIRAM/CHAREN on 6510 port bits 0-2), the VIC-II
 * article by Christian Bauer (bad lines $30-$F7 matching YSCROLL hold the
 * CPU for the c-accesses of cycles 15-54), and the NMOS 6502's dummy write
 * on read-modify-write instructions.
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { VicII } from '@/machines/c64/vic-ii.ts';
import { C64Memory } from '@/machines/c64/memory.ts';
import { Asm, OP, expectExactFromFile, romImage } from '../snapshot/native-state-helpers.ts';

const INC_ABS = 0xEE;
const LDA_ABS = OP.LDA_ABS;

/** A KERNAL-shaped firmware: set up a raster interrupt at line 100 (and,
 *  with `cia`, CIA 1 timer A at 60 Hz), then loop writing the SID and the
 *  border. The handler counts interrupts in $03, notes the raster line in
 *  $02 and acknowledges the VIC-II with INC $D019. */
function firmware(cia: boolean): Uint8Array {
  const a = new Asm(0xE000);
  a.label('reset').b(OP.SEI, OP.CLD, OP.LDX_IMM, 0xFF, OP.TXS);
  // The port's data first, as the KERNAL does: making bits 0-2 outputs while
  // the latch still holds 0 would bank the ROM out from under the CPU.
  a.b(OP.LDA_IMM, 0x37, OP.STA_ZP, 0x01, OP.LDA_IMM, 0x2F, OP.STA_ZP, 0x00);
  a.b(OP.LDA_IMM, 0x7F).abs(OP.STA_ABS, 0xDC0D);
  a.b(OP.LDA_IMM, 0x1B).abs(OP.STA_ABS, 0xD011);
  a.b(OP.LDA_IMM, 100).abs(OP.STA_ABS, 0xD012);
  // Clear what was flagged before (line 0 matched the power-on compare of 0).
  a.b(OP.LDA_IMM, 0xFF).abs(OP.STA_ABS, 0xD019);
  a.b(OP.LDA_IMM, 0x01).abs(OP.STA_ABS, 0xD01A);
  if (cia) {
    a.b(OP.LDA_IMM, 0x25).abs(OP.STA_ABS, 0xDC04).b(OP.LDA_IMM, 0x40).abs(OP.STA_ABS, 0xDC05);
    a.b(OP.LDA_IMM, 0x81).abs(OP.STA_ABS, 0xDC0D).b(OP.LDA_IMM, 0x11).abs(OP.STA_ABS, 0xDC0E);
    a.b(OP.LDA_IMM, 0x0F).abs(OP.STA_ABS, 0xD418).b(OP.LDA_IMM, 0x11).abs(OP.STA_ABS, 0xD412);
  }
  a.b(OP.CLI);
  a.label('loop').b(OP.INC_ZP, 0x04, OP.LDA_ZP, 0x04).abs(OP.STA_ABS, 0xD40F).abs(OP.STA_ABS, 0xD020);
  a.abs(OP.JMP, 'loop');
  a.label('irq').b(OP.PHA);
  if (cia) a.abs(LDA_ABS, 0xDC0D);
  a.abs(LDA_ABS, 0xD012).b(OP.STA_ZP, 0x02, OP.INC_ZP, 0x03);
  a.abs(INC_ABS, 0xD019);
  a.b(OP.PLA, OP.RTI);
  const code = a.assemble();
  const kernal = new Uint8Array(0x2000);
  kernal.set(code, 0);
  kernal[0x1FFC] = a.addr('reset') & 0xFF; kernal[0x1FFD] = a.addr('reset') >> 8;
  kernal[0x1FFE] = a.addr('irq') & 0xFF; kernal[0x1FFF] = a.addr('irq') >> 8;
  kernal[0x1FFA] = a.addr('irq') & 0xFF; kernal[0x1FFB] = a.addr('irq') >> 8;
  const rom = new Uint8Array(0x5000);
  rom.set(kernal, 0x2000);
  return rom;
}

function machine(rom: Uint8Array): C64Machine {
  const m = new C64Machine('c64', null);
  m.loadROM(rom);
  m.reset();
  return m;
}

describe('C64 PLA', () => {
  it('maps BASIC, KERNAL, I/O and the character ROM from the port bits', () => {
    const mem = new C64Memory();
    mem.basic.fill(0xBA);
    mem.kernal.fill(0xEE);
    mem.chargen.fill(0xC6);
    mem.ioRead = () => 0x10;
    mem.ram[0xA000] = 0x0A; mem.ram[0xD000] = 0x0D; mem.ram[0xE000] = 0x0E;
    mem.writeByte(0, 0x2F);
    const view = (port: number): number[] => {
      mem.writeByte(1, port);
      return [mem.readByte(0xA000), mem.readByte(0xD000), mem.readByte(0xE000)];
    };
    expect(view(0x37), 'LORAM HIRAM CHAREN').toEqual([0xBA, 0x10, 0xEE]);
    expect(view(0x36), 'HIRAM CHAREN').toEqual([0x0A, 0x10, 0xEE]);
    expect(view(0x35), 'LORAM CHAREN').toEqual([0x0A, 0x10, 0x0E]);
    expect(view(0x33), 'LORAM HIRAM').toEqual([0xBA, 0xC6, 0xEE]);
    expect(view(0x34), 'CHAREN alone').toEqual([0x0A, 0x0D, 0x0E]);
    expect(view(0x30), 'all low').toEqual([0x0A, 0x0D, 0x0E]);
  });

  it('writes under the ROMs to RAM', () => {
    const mem = new C64Memory();
    mem.writeByte(0, 0x2F);
    mem.writeByte(1, 0x37);
    mem.writeByte(0xA123, 0x55);
    mem.writeByte(0xE123, 0x66);
    expect([mem.ram[0xA123], mem.ram[0xE123]]).toEqual([0x55, 0x66]);
  });

  it('shows the character ROM to the VIC-II in banks 0 and 2 only', () => {
    const mem = new C64Memory();
    mem.chargen[0] = 0x3C;
    mem.ram[0x5000] = 0x99;
    mem.ram[0x9000] = 0x77;
    mem.setVicBank(0);
    expect(mem.vicRead(0x1000)).toBe(0x3C);
    mem.setVicBank(1);
    expect(mem.vicRead(0x1000)).toBe(0x99);
    mem.setVicBank(2);
    expect(mem.vicRead(0x1000)).toBe(0x3C);
    mem.ram[0x9000] = 0x77;
  });

  it('reads the cassette sense on port bit 4', () => {
    const mem = new C64Memory();
    mem.cassetteSense = false;
    expect(mem.readByte(1) & 0x10).toBe(0x10);
    mem.cassetteSense = true;
    expect(mem.readByte(1) & 0x10).toBe(0);
  });
});

describe('C64 VIC-II', () => {
  it('holds the CPU over the c-accesses of a bad line and not on other lines', () => {
    const vic = new VicII(new C64Memory());
    vic.write(0xD011, 0x1B, 0);                 // DEN, 25 rows, YSCROLL 3
    vic.startLine(0x30, 0);                     // DEN seen on line $30
    const t = 1000 * 63;
    vic.startLine(0x33, t);                     // $33 & 7 = 3: a bad line
    for (let bauer = 15; bauer <= 54; bauer++) {
      expect(vic.stealEnd(t + bauer - 1), `cycle ${bauer}`).toBeGreaterThanOrEqual(t + 54);
    }
    expect(vic.stealEnd(t + 5), 'before BA goes low').toBe(t + 5);
    vic.startLine(0x34, t + 63);
    expect(vic.stealEnd(t + 63 + 20), 'not a bad line').toBe(t + 63 + 20);
  });

  it('interrupts at the compare line once a frame when acknowledged by INC $D019', () => {
    const m = machine(firmware(false));
    for (let f = 0; f < 6; f++) m.tick();
    expect(m.memory.ram[0x02], 'raster line at the handler').toBe(100);
    // A single write of INC's result ($F2) would leave the raster flag set
    // and the interrupt would fire again after every RTI; the dummy write of
    // the value read ($F1) is what clears it.
    expect(m.memory.ram[0x03]).toBe(6);
  });
});

describe('C64 snapshot', () => {
  it('restores exactly, with the raster, CIA and SID running', async () => {
    const rom = firmware(true);
    const m = machine(rom);
    for (let f = 0; f < 20; f++) m.tick();
    await expectExactFromFile(m, machine(rom), '.c64state', 10);
  });
});

// ── With the real ROMs ────────────────────────────────────────────────────

const basic = romImage('basic-901226-01.rom');
const kernal = romImage('kernal-901227-03.rom');
const chargen = romImage('chargen-901225-01.rom');

function realC64(): C64Machine {
  const rom = new Uint8Array(0x5000);
  rom.set(basic!, 0);
  rom.set(kernal!, 0x2000);
  rom.set(chargen!, 0x4000);
  const m = machine(rom);
  for (let f = 0; f < 150; f++) m.tick();
  return m;
}

function typeText(m: C64Machine, text: string): void {
  for (const ch of text) {
    const ev = ch === '\n'
      ? { code: 'Enter', key: 'Enter', shift: false, ctrl: false, alt: false }
      : { code: '', key: ch, shift: false, ctrl: false, alt: false };
    m.services.input.keyDown(ev);
    for (let f = 0; f < 3; f++) m.tick();
    m.services.input.keyUp(ev);
    for (let f = 0; f < (ch === '\n' ? 10 : 2); f++) m.tick();
  }
}

function runUntilReady(m: C64Machine, maxFrames: number): number {
  let frames = 0;
  while (!/READY\.$/.test(m.ocrScreenForMcp()) && frames < maxFrames) { m.tick(); frames++; }
  return frames;
}

describe.skipIf(!basic || !kernal || !chargen)('C64 with the Commodore ROMs', () => {
  it('starts BASIC V2 on a PAL machine', () => {
    const m = realC64();
    expect(m.ocrScreenForMcp()).toContain('38911 BASIC BYTES FREE');
    expect(m.memory.ram[0x02A6], 'the KERNAL measured a PAL VIC-II').toBe(1);
  });

  it('types and runs a program', () => {
    const m = realC64();
    typeText(m, '10 PRINT "A";2*3;"[OK]"\nRUN\n');
    for (let f = 0; f < 20; f++) m.tick();
    expect(m.ocrScreenForMcp()).toContain('A 6 [OK]');
  });

  it('starts a dropped program on a fresh machine, even with another running', async () => {
    const m = realC64();
    typeText(m, '10 GOTO 10\nRUN\n');
    // 10 PRINT "B" — link $080A, line 10, PRINT ($99), "B", end of line,
    // then the end-of-program link.
    const prg = Uint8Array.from([0x01, 0x08, 0x0A, 0x08, 0x0A, 0x00, 0x99, 0x22, 0x42, 0x22, 0x00, 0x00, 0x00]);
    const r = await m.services.media.mount(prg, 'b.prg');
    expect(r.ok, r.message).toBe(true);
    for (let f = 0; f < 200; f++) m.tick();
    expect(m.ocrScreenForMcp()).toMatch(/BYTES FREE\n\nREADY\.\nRUN\nB\n\nREADY\.$/);
  });

  it('loads back what it saved to tape, through the KERNAL both ways', { timeout: 60_000 }, async () => {
    const m = realC64();
    typeText(m, '10 PRINT "FROM TAPE"\nSAVE "T"\n');
    runUntilReady(m, 3000);
    const saved = m.services.tape.recordedBytes();
    expect(saved).not.toBeNull();

    const m2 = realC64();
    const r = await m2.services.media.mount(saved!.data, saved!.filename);
    expect(r.ok, r.message).toBe(true);
    expect(m2.services.tape.blocks[0].label).toBe('"T"');
    typeText(m2, 'LOAD\n');
    const screen = (): string => m2.ocrScreenForMcp();
    expect(runUntilReady(m2, 4000)).toBeLessThan(4000);
    expect(screen()).toContain('PRESS PLAY ON TAPE');
    expect(screen()).toContain('FOUND T');
    typeText(m2, 'RUN\n');
    for (let f = 0; f < 20; f++) m2.tick();
    expect(screen()).toMatch(/RUN\nFROM TAPE/);
  });
});
