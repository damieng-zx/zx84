/**
 * BBC Micro accuracy features: the 1 MHz bus stretching, sideways RAM, the
 * printer port, the RS423 port and the Model A.
 *
 * The synthetic blocks run hand-assembled 6502 from a tiny ROM (no copyrighted
 * firmware) and take their expected numbers from the hardware documentation
 * (Advanced User Guide): worked out by hand in the comments, not read back
 * from the code. The blocks that need the real MOS 1.20 and BASIC 2 (cached
 * under mcp/.cache as bbc-os12.rom / bbc-basic2.rom) are skipped without them.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { parseSsd, SSD_TRACK_BYTES } from '@/media/floppy/ssd.ts';

/** A machine whose OS ROM holds `code` at $C000 and starts there. */
function withCode(code: number[], model: 'bbc-a' | 'bbc-b' = 'bbc-b'): BbcMachine {
  const rom = new Uint8Array(0x8000);
  rom.set(code, 0);
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  const m = new BbcMachine(model, null);
  m.loadROM(rom);
  m.reset();
  return m;
}

/** Run `n` instructions through the machine's own stepper (the bus is held and
 *  the chips are clocked exactly as in a run). */
function steps(m: BbcMachine, n: number): void {
  for (let i = 0; i < n; i++) m.stepInstruction();
}

describe('1 MHz bus cycle stretching', () => {
  it('holds a load from the 1 MHz bus 2 cycles when in phase with the 1 MHz clock, 3 when out', () => {
    // LDA $FE40 is 4 cycles with the read on the 4th. From cycle 0 that read
    // begins on cycle 3 (odd: half a 1 MHz cycle out of phase): wait one cycle
    // for the edge, then the 1 MHz cycle of 2 -> held 2 extra, 6 cycles, which
    // ends on an even (in-phase) cycle. The next LDA starts on cycle 6 and
    // reads on cycle 9: odd again, again 6.
    const m = withCode([0xAD, 0x40, 0xFE, 0xAD, 0x40, 0xFE, 0xAD, 0x40, 0xFE]);
    steps(m, 1);
    expect(m.cpu.tStates).toBe(6);
    steps(m, 2);
    expect(m.cpu.tStates).toBe(18);
    m.destroy();
  });

  it('holds a load that begins in phase just 1 extra cycle', () => {
    // NOP (2) puts the next LDA $FE40 on cycle 2: its read is on cycle 5
    // (odd)... start with a 1-cycle-shifting instruction instead: LDA zp is 3
    // cycles, so the LDA $FE40 that follows starts on cycle 3 and reads on
    // cycle 6 (even: in phase) -> held 1 extra, 5 cycles.
    const m = withCode([0xA5, 0x00, 0xAD, 0x40, 0xFE]);
    steps(m, 1);
    expect(m.cpu.tStates).toBe(3);
    steps(m, 1);
    expect(m.cpu.tStates).toBe(8);               // 3 + 4 + 1
    m.destroy();
  });

  it('settles a LDA / DEX / BNE loop on the 1 MHz bus at 10 cycles an iteration', () => {
    // LDX #N; loop: LDA $FE40 / DEX / BNE loop. After LDX #N (2) the first LDA
    // starts on cycle 2, reads on 5 (odd): 6 cycles -> 8; DEX -> 10; BNE taken
    // (3) -> 13. The next LDA starts on 13, reads on 16 (even): 5 cycles -> 18;
    // DEX, BNE taken -> 23: odd again, 5 more... every later iteration is
    // 5 + 2 + 3 = 10 cycles, ending on an odd cycle.
    const m = withCode([0xA2, 0x20, 0xAD, 0x40, 0xFE, 0xCA, 0xD0, 0xFA]);
    steps(m, 1);                                  // LDX
    steps(m, 3);                                  // first iteration
    expect(m.cpu.tStates).toBe(13);
    steps(m, 3 * 4);                              // four more
    expect(m.cpu.tStates).toBe(13 + 4 * 10);
    m.destroy();
  });

  it('leaves RAM, ROM and zero-page accesses at the 2 MHz count', () => {
    // LDA $0200 (4) + STA $0201 (4) + LDA $8000 (4) + LDA ($70),Y (5, no carry)
    const m = withCode([0xAD, 0x00, 0x02, 0x8D, 0x01, 0x02, 0xAD, 0x00, 0x80, 0xB1, 0x70]);
    m.memory.ram[0x70] = 0x00; m.memory.ram[0x71] = 0x03;
    steps(m, 4);
    expect(m.cpu.tStates).toBe(4 + 4 + 4 + 5);
    m.destroy();
  });

  it('holds a store to the 1 MHz bus the same way (write on the last cycle)', () => {
    // STA $FE60: 4 cycles, write on cycle 4 = begins on cycle 3 (odd) -> 6.
    const m = withCode([0x8D, 0x60, 0xFE]);
    steps(m, 1);
    expect(m.cpu.tStates).toBe(6);
    m.destroy();
  });

  it('charges a read-modify-write on the bus for its read and both writes', () => {
    // INC $FE60 is 6 cycles: read on cycle 4 (begins on 3: odd, held 2, ends
    // on 6), the 6502's write-back of the old value on cycle 5 (begins on 6:
    // even, held 1, ends on 8) and the final write on cycle 6 (begins on 8:
    // even, held 1, ends on 10). Ten cycles in all.
    const m = withCode([0xEE, 0x60, 0xFE]);
    steps(m, 1);
    expect(m.cpu.tStates).toBe(10);
    m.destroy();
  });

  it('counts the extra cycle of an indexed read that crosses a page before the read', () => {
    // LDX #$FF; LDA $FD41,X reads $FE40 (crossed): 5 cycles, the read on the
    // 5th. From cycle 2 it begins on cycle 6 (even): held 1 -> 6 cycles. With
    // no crossing (LDX #$00; LDA $FE40,X) it is 4 cycles, read on the 4th,
    // beginning on 5 (odd): held 2 -> 6 cycles as well; tell them apart by an
    // odd start: put a zero-page load first.
    const crossed = withCode([0xA5, 0x00, 0xA2, 0xFF, 0xBD, 0x41, 0xFD]);
    steps(crossed, 2);
    expect(crossed.cpu.tStates).toBe(5);          // 3 + 2
    steps(crossed, 1);
    // starts on 5; the read is on the 5th cycle = cycle 9 (odd) -> held 2; 5 + 5 + 2
    expect(crossed.cpu.tStates).toBe(12);
    const plain = withCode([0xA5, 0x00, 0xA2, 0x00, 0xBD, 0x40, 0xFE]);
    steps(plain, 3);
    // starts on 5; the read is on the 4th cycle = cycle 8 (even) -> held 1; 5 + 4 + 1
    expect(plain.cpu.tStates).toBe(10);
    crossed.destroy();
    plain.destroy();
  });

  it('clocks the VIAs by the stretched time (a 1 MHz timer sees the extra cycles)', () => {
    // Timer 1 counts the 1 MHz clock: 6 cycles of 2 MHz are 3 timer counts.
    const m = withCode([0xAD, 0x40, 0xFE]);
    m.sysVia.write(4, 0x00); m.sysVia.write(5, 0x10);      // T1 = $1000
    steps(m, 1);
    expect(m.cpu.tStates).toBe(6);
    expect(m.sysVia.t1Counter).toBe(0x1000 - 3);
    m.destroy();
  });
});

describe('sideways RAM', () => {
  /** Select bank `n` as the MOS does (ROMSEL, $FE30). */
  const select = (m: BbcMachine, n: number): void => m.memory.writeByte(0xFE30, n);

  it('ignores writes to a ROM socket and takes them in one fitted with RAM', () => {
    const m = withCode([0xEA]);
    m.memory.setRamBanks(0x00F0);                   // banks 4-7
    select(m, 4);
    m.memory.writeByte(0x8000, 0x5A);
    m.memory.writeByte(0xBFFF, 0xA5);
    expect(m.memory.readByte(0x8000)).toBe(0x5A);
    expect(m.memory.readByte(0xBFFF)).toBe(0xA5);
    select(m, 8);                                   // a ROM socket: ignores the write
    m.memory.writeByte(0x8000, 0x77);
    expect(m.memory.readByte(0x8000)).toBe(0x00);
    select(m, 4);
    expect(m.memory.readByte(0x8000)).toBe(0x5A);   // still there
    m.destroy();
  });

  it('keeps each bank separate and decodes the latch at every address of $FE30-$FE3F', () => {
    const m = withCode([0xEA]);
    m.memory.setRamBanks(0x0FF0);
    m.memory.writeByte(0xFE35, 6);                  // any address of the block
    m.memory.writeByte(0x8123, 0x66);
    m.memory.writeByte(0xFE3F, 7);
    m.memory.writeByte(0x8123, 0x77);
    m.memory.writeByte(0xFE30, 6);
    expect(m.memory.readByte(0x8123)).toBe(0x66);
    m.memory.writeByte(0xFE30, 7);
    expect(m.memory.readByte(0x8123)).toBe(0x77);
    m.destroy();
  });

  it('ignores the upper bits of the ROM select (the Model B latches four)', () => {
    const m = withCode([0xEA]);
    m.memory.setRamBanks(0x0010);
    m.memory.writeByte(0xFE30, 0x84);               // bank 4 whatever bit 7 says
    m.memory.writeByte(0x9000, 0x42);
    m.memory.writeByte(0xFE30, 0x04);
    expect(m.memory.readByte(0x9000)).toBe(0x42);
    m.destroy();
  });

  it('keeps its contents across BREAK, which only restores the ROM select', () => {
    const m = withCode([0xEA]);
    m.memory.setRamBanks(0x0010);
    m.memory.writeByte(0xFE30, 4);
    m.memory.writeByte(0x8000, 0x99);
    m.reset();
    expect(m.memory.romsel).toBe(0x0F);
    m.memory.writeByte(0xFE30, 4);
    expect(m.memory.readByte(0x8000)).toBe(0x99);
    m.destroy();
  });

  it('runs code written into a RAM bank from the bank', () => {
    // The CPU writes LDA #$37 / STA $0070 / RTS... into bank 5, then JSRs to it.
    const m = withCode([
      0xA9, 0x05, 0x8D, 0x30, 0xFE,               // LDA #5 : STA $FE30
      0xA9, 0xA9, 0x8D, 0x00, 0x80,               // LDA #$A9 : STA $8000   (LDA #imm)
      0xA9, 0x37, 0x8D, 0x01, 0x80,               // LDA #$37 : STA $8001
      0xA9, 0x85, 0x8D, 0x02, 0x80,               // LDA #$85 : STA $8002   (STA zp)
      0xA9, 0x70, 0x8D, 0x03, 0x80,               // LDA #$70 : STA $8003
      0xA9, 0x60, 0x8D, 0x04, 0x80,               // LDA #$60 : STA $8004   (RTS)
      0x20, 0x00, 0x80,                           // JSR $8000
      0x4C, 0x21, 0xC0,                           // spin
    ]);
    m.memory.setRamBanks(0x0020);
    steps(m, 15);
    expect(m.memory.ram[0x70]).toBe(0x37);
    m.destroy();
  });

  it('turns a socket back to ROM empty, and lets a loaded image fill a RAM bank', () => {
    const m = withCode([0xEA]);
    m.memory.setRamBanks(0x0010);
    m.loadSidewaysRom(4, Uint8Array.from([1, 2, 3]));
    m.memory.writeByte(0xFE30, 4);
    expect(m.memory.readByte(0x8002)).toBe(3);
    m.memory.writeByte(0x8002, 9);
    expect(m.memory.readByte(0x8002)).toBe(9);
    m.memory.setRamBanks(0);
    expect(m.memory.readByte(0x8002)).toBe(0);
    m.destroy();
  });
});

describe('Model A', () => {
  it('mirrors its 16K of RAM at $4000-$7FFF (address line A14 is not decoded)', () => {
    const m = withCode([0xEA], 'bbc-a');
    m.memory.writeByte(0x0123, 0xAB);
    expect(m.memory.readByte(0x4123)).toBe(0xAB);
    m.memory.writeByte(0x7FFF, 0xCD);
    expect(m.memory.readByte(0x3FFF)).toBe(0xCD);
    // The array the video and the debugger read agrees.
    expect(m.memory.ram[0x4123]).toBe(0xAB);
    m.destroy();
  });

  it('does not mirror on the Model B', () => {
    const m = withCode([0xEA], 'bbc-b');
    m.memory.writeByte(0x0123, 0xAB);
    expect(m.memory.readByte(0x4123)).toBe(0x00);
    m.destroy();
  });

  it('leaves the User VIA and analogue port unfitted (they float high, take no writes)', () => {
    const m = withCode([0xEA], 'bbc-a');
    m.memory.writeByte(0xFE62, 0xFF);
    expect(m.memory.readByte(0xFE62)).toBe(0xFF);
    expect(m.memory.readByte(0xFEC0)).toBe(0xFF);
    expect(m.userVia.ddrb).toBe(0);
    m.destroy();
  });
});

const CACHE = resolve(__dirname, '../mcp/.cache');
const haveRoms = ['bbc-os12.rom', 'bbc-basic2.rom'].every(r => existsSync(resolve(CACHE, r)));

describe('the printer port (User VIA port A, CA2 strobe, CA1 acknowledge)', () => {
  /** A machine that does nothing, to drive the User VIA by hand like the MOS. */
  function idle(): BbcMachine {
    return withCode([0x4C, 0x00, 0xC0]);
  }
  const via = (m: BbcMachine, reg: number, v: number): void => m.memory.writeByte(0xFE60 + reg, v);

  it('takes the byte on port A as /STROBE (CA2) is pulled low by hand and acknowledges it on CA1', () => {
    const m = idle();
    via(m, 3, 0xFF);                    // DDRA: all outputs
    via(m, 14, 0x82);                   // IER: CA1 interrupt enabled
    via(m, 12, 0x0E);                   // PCR: CA2 manual output high, CA1 falling edge
    via(m, 1, 0x48);                    // data 'H' on the lines
    expect(m.printer.length).toBe(0);   // nothing yet: /STROBE has not fallen
    via(m, 12, 0x0C);                   // CA2 low: the strobe
    expect(Array.from(m.printer.bytes)).toEqual([0x48]);
    via(m, 12, 0x0E);                   // CA2 high again
    expect(Array.from(m.printer.bytes)).toEqual([0x48]);   // a rising edge prints nothing
    expect(m.userVia.irq).toBe(false);  // the printer has not acknowledged yet
    for (let i = 0; i < 400; i++) m.stepInstruction();   // well over 100 us
    expect(m.userVia.irq).toBe(true);   // /ACKNOWLEDGE fell on CA1
    expect(m.userVia.read(13) & 0x02).toBe(0x02);        // IFR bit 1 = CA1
    m.destroy();
  });

  it('strobes by itself in handshake mode and releases /STROBE on the acknowledge', () => {
    const m = idle();
    via(m, 3, 0xFF);
    via(m, 12, 0x08);                   // PCR: CA2 handshake output (100), CA1 falling edge
    via(m, 1, 0x41);                    // writing port A strobes: 'A'
    via(m, 1, 0x42);                    // CA2 is still low, waiting for the acknowledge: no new falling edge
    expect(Array.from(m.printer.bytes)).toEqual([0x41]);
    for (let i = 0; i < 400; i++) m.stepInstruction();
    via(m, 1, 0x43);                    // after the acknowledge CA2 was released, so this strobes
    expect(Array.from(m.printer.bytes)).toEqual([0x41, 0x43]);
    m.destroy();
  });

  it('pulses /STROBE once per write in pulse mode', () => {
    const m = idle();
    via(m, 3, 0xFF);
    via(m, 12, 0x0A);                   // PCR: CA2 pulse output (101)
    via(m, 1, 0x31);
    via(m, 1, 0x32);
    expect(Array.from(m.printer.bytes)).toEqual([0x31, 0x32]);
    m.destroy();
  });

  it('reads pins that are not driven as high (a printer port with DDRA partly clear)', () => {
    const m = idle();
    via(m, 3, 0x0F);                    // only the low nibble is an output
    via(m, 12, 0x0E);
    via(m, 1, 0xA5);
    via(m, 12, 0x0C);
    expect(Array.from(m.printer.bytes)).toEqual([0xF5]);   // low nibble 5, undriven bits float high
    m.destroy();
  });

  it('exports CR, LF and CR LF as line breaks, in a file named for the machine', () => {
    const m = idle();
    via(m, 3, 0xFF);
    for (const b of [0x41, 0x0D, 0x42, 0x0D, 0x0A, 0x43, 0x0A, 0x44]) {
      via(m, 12, 0x0E); via(m, 1, b); via(m, 12, 0x0C);
    }
    const out = m.services.printer!.capturedText()!;
    expect(out.filename).toBe('bbc-printer.txt');
    expect(new TextDecoder().decode(out.data)).toBe('A\nB\nC\nD');
    m.services.printer!.clearCapture();
    expect(m.services.printer!.capturedText()).toBeNull();
    m.destroy();
  });

  it('is absent on the Model A, which has no User VIA', () => {
    const a = withCode([0xEA], 'bbc-a');
    expect(a.services.printer).toBeNull();
    expect(a.descriptor.ui.saveMenu).not.toContain('printer-txt');
    const b = withCode([0xEA], 'bbc-b');
    expect(b.descriptor.ui.saveMenu).toContain('printer-txt');
    a.destroy();
    b.destroy();
  });
});

describe('the RS423 port (6850 ACIA behind the serial ULA)', () => {
  const ACIA_STATUS = 0xFE08, ACIA_DATA = 0xFE09, SERIAL_ULA = 0xFE10;

  it('sends what the ACIA transmits to the download buffer when the ULA selects RS423', () => {
    const m = withCode([0x4C, 0x00, 0xC0]);
    m.memory.writeByte(ACIA_STATUS, 0x03);           // master reset
    m.memory.writeByte(ACIA_STATUS, 0x16);           // ÷64, 8N1
    m.memory.writeByte(SERIAL_ULA, 0x64);            // RS423, 9600 baud both ways
    m.memory.writeByte(ACIA_DATA, 0x41);
    // 9600 baud is 208 cycles a bit at 2 MHz; the byte starts on the next bit boundary.
    for (let i = 0; i < 1200; i++) m.stepInstruction();
    expect(Array.from(m.rs423.sent)).toEqual([0x41]);
    expect(m.services.tape.recordedBytes()).toBeNull();
    m.destroy();
  });

  it('keeps cassette output off the RS423 buffer', () => {
    const m = withCode([0x4C, 0x00, 0xC0]);
    m.memory.writeByte(ACIA_STATUS, 0x03);
    m.memory.writeByte(ACIA_STATUS, 0x15);
    m.memory.writeByte(SERIAL_ULA, 0x85);            // cassette, motor on
    m.memory.writeByte(ACIA_DATA, 0x41);
    for (let i = 0; i < 6000; i++) m.stepInstruction();
    expect(m.rs423.sent.length).toBe(0);
    m.destroy();
  });

  it('delivers host text with RDRF set, the data intact and the IRQ raised when enabled', () => {
    const m = withCode([0x4C, 0x00, 0xC0]);
    m.memory.writeByte(ACIA_STATUS, 0x03);
    m.memory.writeByte(ACIA_STATUS, 0x96);           // ÷64, 8N1, receive interrupt enabled
    m.memory.writeByte(SERIAL_ULA, 0x64);
    m.rs423.send([0x5A]);
    expect(m.memory.readByte(ACIA_STATUS) & 0x01).toBe(0);
    // One frame is 10 bits of 208 cycles = 2080 cycles; a JMP spin is 3 cycles.
    for (let i = 0; i < 300; i++) m.stepInstruction();       // ~900 cycles: mid-frame
    expect(m.memory.readByte(ACIA_STATUS) & 0x01).toBe(0);
    for (let i = 0; i < 600; i++) m.stepInstruction();       // ~2700 cycles: done
    expect(m.memory.readByte(ACIA_STATUS) & 0x81).toBe(0x81);   // RDRF and IRQ
    expect(m.cpu.irqLine).toBe(true);
    expect(m.memory.readByte(ACIA_DATA)).toBe(0x5A);
    expect(m.memory.readByte(ACIA_STATUS) & 0x81).toBe(0);
    expect(m.rs423.pending).toBe(0);
    m.destroy();
  });

  it('queues several bytes back to back and flags an overrun if one is not read', () => {
    const m = withCode([0x4C, 0x00, 0xC0]);
    m.memory.writeByte(ACIA_STATUS, 0x03);
    m.memory.writeByte(ACIA_STATUS, 0x16);
    m.memory.writeByte(SERIAL_ULA, 0x64);
    m.rs423.send([0x31, 0x32, 0x33]);
    for (let i = 0; i < 2400; i++) m.stepInstruction();      // ~7200 cycles: three 2080-cycle frames
    const status = m.memory.readByte(ACIA_STATUS);
    expect(status & 0x20, 'overrun: the 2nd and 3rd arrived with the 1st unread').toBe(0x20);
    expect(m.memory.readByte(ACIA_DATA)).toBe(0x31);         // the first byte is the one kept
    m.destroy();
  });

  it('holds host text while the cassette is selected', () => {
    const m = withCode([0x4C, 0x00, 0xC0]);
    m.memory.writeByte(ACIA_STATUS, 0x03);
    m.memory.writeByte(ACIA_STATUS, 0x16);
    m.memory.writeByte(SERIAL_ULA, 0x04);            // cassette selected
    m.rs423.send([0x31]);
    for (let i = 0; i < 1000; i++) m.stepInstruction();
    expect(m.memory.readByte(ACIA_STATUS) & 0x01).toBe(0);
    m.destroy();
  });
});

describe('native state carries the new hardware', () => {
  /** Run a state's bytes back through a machine, as the snapshot service does
   *  once the container is open. */
  function roundTrip(from: BbcMachine, into: BbcMachine, drop: string[] = []): void {
    const w = new StateWriter();
    from.saveState(w, false);
    let bytes = w.finish();
    if (drop.length > 0) bytes = dropSections(bytes, drop);
    into.loadState(new StateReader(bytes));
  }
  /** The state with the named sections cut out, as an older build wrote it. */
  function dropSections(bytes: Uint8Array, tags: string[]): Uint8Array {
    const out: number[] = [];
    let at = 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (at + 8 <= bytes.length) {
      const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
      const len = view.getUint32(at + 4, true);
      if (!tags.includes(tag)) for (let i = 0; i < 8 + len; i++) out.push(bytes[at + i]);
      at += 8 + len;
    }
    return Uint8Array.from(out);
  }

  it('restores sideways RAM contents and which sockets are RAM, and does not count them as firmware', () => {
    const a = withCode([0x4C, 0x00, 0xC0]);
    const b = withCode([0x4C, 0x00, 0xC0]);
    a.memory.setRamBanks(0x00F0);
    b.memory.setRamBanks(0x00F0);
    a.memory.writeByte(0xFE30, 6);
    a.memory.writeByte(0x9ABC, 0x6D);
    const crcBefore = a.stateRomCrcs();
    a.memory.writeByte(0x9ABD, 0x11);
    expect(a.stateRomCrcs(), 'RAM contents are not firmware').toEqual(crcBefore);
    roundTrip(a, b);
    b.memory.writeByte(0xFE30, 6);
    expect(b.memory.readByte(0x9ABC)).toBe(0x6D);
    expect(b.memory.readByte(0x9ABD)).toBe(0x11);
    a.destroy();
    b.destroy();
  });

  it('refuses a state saved with other sideways RAM, before changing anything', () => {
    const a = withCode([0x4C, 0x00, 0xC0]);
    const b = withCode([0x4C, 0x00, 0xC0]);
    a.memory.setRamBanks(0x00F0);
    for (let i = 0; i < 50; i++) b.stepInstruction();
    const pc = b.cpu.pc, t = b.cpu.tStates;
    expect(() => roundTrip(a, b)).toThrow(/sideways RAM in banks 4, 5, 6, 7.*none/);
    expect(b.cpu.tStates).toBe(t);
    expect(b.cpu.pc).toBe(pc);
    a.destroy();
    b.destroy();
  });

  it('still loads a state from before sideways RAM, the printer and RS423 existed', () => {
    const a = withCode([0x4C, 0x00, 0xC0]);
    const b = withCode([0x4C, 0x00, 0xC0]);
    for (let i = 0; i < 20; i++) a.stepInstruction();
    roundTrip(a, b, ['SWR ', 'PRNT', 'RS42']);
    expect(b.cpu.tStates).toBe(a.cpu.tStates);
    expect(b.memory.ramBanks).toBe(0);
    a.destroy();
    b.destroy();
  });

  it('resumes a printer acknowledge and an RS423 frame in flight exactly', () => {
    const a = withCode([0x4C, 0x00, 0xC0]);
    const b = withCode([0x4C, 0x00, 0xC0]);
    const w = (m: BbcMachine, reg: number, v: number): void => m.memory.writeByte(0xFE60 + reg, v);
    w(a, 3, 0xFF); w(a, 14, 0x82); w(a, 12, 0x0E); w(a, 1, 0x58); w(a, 12, 0x0C);   // strobed, ack pending
    a.memory.writeByte(0xFE08, 0x03); a.memory.writeByte(0xFE08, 0x96); a.memory.writeByte(0xFE10, 0x64);
    a.rs423.send([0xA7, 0x01]);
    for (let i = 0; i < 40; i++) a.stepInstruction();      // part-way through both
    roundTrip(a, b);
    for (let i = 0; i < 1200; i++) { a.stepInstruction(); b.stepInstruction(); }
    expect(b.cpu.tStates).toBe(a.cpu.tStates);
    expect(b.userVia.ifr).toBe(a.userVia.ifr);
    expect(b.userVia.irq).toBe(true);
    expect(b.memory.readByte(0xFE09)).toBe(0xA7);
    expect(a.memory.readByte(0xFE09)).toBe(0xA7);
    a.destroy();
    b.destroy();
  });
});

describe.skipIf(!haveRoms)('through the real MOS 1.20 and BASIC 2', { timeout: 30_000 }, () => {
  function boot(model: 'bbc-a' | 'bbc-b' = 'bbc-b', swr = 0): BbcMachine {
    const rom = new Uint8Array(0x8000);
    rom.set(readFileSync(resolve(CACHE, 'bbc-os12.rom')), 0);
    rom.set(readFileSync(resolve(CACHE, 'bbc-basic2.rom')), 0x4000);
    const m = new BbcMachine(model, null);
    m.loadROM(rom);
    m.memory.setRamBanks(swr);
    m.reset();
    for (let i = 0; i < 150; i++) m.tick();
    return m;
  }
  function typist(m: BbcMachine): (s: string) => void {
    return (s) => {
      for (const ch of s) {
        const ev = {
          code: ch === '\n' ? 'Enter' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '',
          key: ch === '\n' ? 'Enter' : ch, shift: false, ctrl: false, alt: false,
        };
        m.services.input.keyDown(ev);
        for (let i = 0; i < 3; i++) m.tick();
        m.services.input.keyUp(ev);
        for (let i = 0; i < 3; i++) m.tick();
      }
    };
  }
  const run = (m: BbcMachine, frames: number): void => { for (let i = 0; i < frames; i++) m.tick(); };

  it('Model B boots to "BBC Computer 32K" and Model A to "BBC Computer 16K"', () => {
    const b = boot('bbc-b');
    expect(b.ocrScreenForMcp()).toContain('BBC Computer 32K');
    const a = boot('bbc-a');
    expect(a.ocrScreenForMcp()).toContain('BBC Computer 16K');
    b.destroy();
    a.destroy();
  });

  it('Model A runs BASIC with HIMEM at &3C00, the top of 16K under the Mode 7 screen', () => {
    const a = boot('bbc-a');
    const type = typist(a);
    type('PRINT HIMEM\n');
    run(a, 20);
    expect(a.ocrScreenForMcp()).toContain('15360');
    a.destroy();
  });

  // A 24-byte routine POKEd in by a BASIC loop (the '#' of immediate mode is
  // not typeable here): SEI, page in bank 4, STA 42 to $8000, read it back to
  // $950, page BASIC back in, CLI, RTS.
  const SWR_LINES = [
    '10FORI%=0TO23:READA%:?(&900+I%)=A%:NEXT',
    '20DATA&78,&A9,4,&8D,&30,&FE,&A9,&2A,&8D,0,&80,&AD,0,&80,&8D,&50,9,&A9,15,&8D,&30,&FE,&58,&60',
    'RUN',
    'CALL&900',
    'PRINT?&950',
  ];
  function probeBank(swr: number): string {
    const m = boot('bbc-b', swr);
    const type = typist(m);
    for (const line of SWR_LINES) { type(line + '\n'); run(m, 30); }
    const screen = m.ocrScreenForMcp();
    m.destroy();
    return screen;
  }

  it('a sideways RAM bank takes a byte written to it and gives it back under MOS and BASIC', () => {
    expect(probeBank(0x00F0)).toMatch(/^ *42$/m);
  });

  it('the same routine reads back 0 where the socket is a ROM socket (writes ignored)', () => {
    expect(probeBank(0)).toMatch(/^ *0$/m);
  });

  it('prints through the OS to the parallel printer: *FX5,1 then VDU 2 / PRINT / VDU 3', () => {
    const m = boot();
    const type = typist(m);
    type('*FX5,1\n');
    run(m, 20);
    type('VDU2:PRINT "HELLO":VDU3\n');
    run(m, 120);
    // PRINT sends the text, CR and LF; the MOS ignores the LF for the printer by default (*FX6,10).
    expect(String.fromCharCode(...m.printer.bytes)).toBe('HELLO\r');
    expect(new TextDecoder().decode(m.services.printer!.capturedText()!.data)).toBe('HELLO\n');
    m.destroy();
  });

  it('sends printer output to RS423 with *FX5,2', () => {
    const m = boot();
    const type = typist(m);
    type('*FX5,2\n');
    run(m, 20);
    type('VDU2:PRINT "HELLO":VDU3\n');
    run(m, 200);
    expect(String.fromCharCode(...m.rs423.sent)).toBe('HELLO\r');
    expect(m.printer.length).toBe(0);
    m.destroy();
  });

  it('takes input from the host over RS423 after *FX2,1 (the MOS buffers it from the ACIA interrupt)', () => {
    const m = boot();
    const type = typist(m);
    for (const c of ['*FX7,7', '*FX8,7', '*FX2,1']) { type(c + '\n'); run(m, 30); }
    // Keyboard input is now off; the host types for the BBC.
    m.rs423.send(Array.from('PRINT 6*7\r', c => c.charCodeAt(0)));
    run(m, 120);
    expect(m.ocrScreenForMcp()).toMatch(/^ *42$/m);
    expect(m.rs423.pending).toBe(0);
    m.destroy();
  });
});

// A third-party sideways-RAM utility, run for real. The ROM is not in the
// repository: point ZX84_BBC_RAMUTIL at a "RAMUtil" (Derek Walker, 1994) ROM
// image (16 KB) to run this (it also needs the cached 1770 DFS ROM).
const ramUtil = process.env.ZX84_BBC_RAMUTIL;
const haveUtil = haveRoms && !!ramUtil && existsSync(ramUtil)
  && existsSync(resolve(CACHE, 'bbc-dfs-226.rom'));

describe.skipIf(!haveUtil)('RAMUtil (BRLOAD) loading a disc file into sideways RAM', () => {
  /** A one-file DFS disc: ROMF, 16 KB of bytes (3i + 1) & 255. */
  function disc(): Uint8Array {
    const d = new Uint8Array(40 * SSD_TRACK_BYTES);
    d.set([...'SWRDISC '].map(c => c.charCodeAt(0)), 0);
    d.set([...'ROMF   $'].map(c => c.charCodeAt(0)), 8);
    d[0x105] = 8;
    d[0x106] = 400 >> 8; d[0x107] = 400 & 0xFF;
    d.set([0, 0x20, 0, 0x20, 0, 0x40, 0, 2], 0x108);    // load and exec $2000, length $4000, sector 2
    for (let i = 0; i < 0x4000; i++) d[512 + i] = (i * 3 + 1) & 0xFF;
    return d;
  }

  it('writes the file into the chosen RAM bank and nowhere else', () => {
    const rom = new Uint8Array(0x8000);
    rom.set(readFileSync(resolve(CACHE, 'bbc-os12.rom')), 0);
    rom.set(readFileSync(resolve(CACHE, 'bbc-basic2.rom')), 0x4000);
    const m = new BbcMachine('bbc-b', null);
    m.loadROM(rom);
    m.loadSidewaysRom(13, new Uint8Array(readFileSync(resolve(CACHE, 'bbc-dfs-226.rom'))));
    m.loadSidewaysRom(14, new Uint8Array(readFileSync(ramUtil!)));
    m.memory.setRamBanks(0x00F0);
    m.reset();
    m.services.disks.insert('a', parseSsd(disc(), false), 'x.ssd');
    for (let i = 0; i < 150; i++) m.tick();
    for (const [line, wait] of [['*BRLOAD', 100], ['ROMF', 400], ['6', 400]] as [string, number][]) {
      for (const ch of line + '\n') {
        const ev = {
          code: ch === '\n' ? 'Enter' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '',
          key: ch === '\n' ? 'Enter' : ch, shift: false, ctrl: false, alt: false,
        };
        m.services.input.keyDown(ev);
        for (let i = 0; i < 3; i++) m.tick();
        m.services.input.keyUp(ev);
        for (let i = 0; i < 3; i++) m.tick();
      }
      for (let i = 0; i < wait; i++) m.tick();
    }
    expect(m.ocrScreenForMcp()).toContain('Done');
    expect(Array.from(m.memory.roms[6].subarray(0, 6))).toEqual([1, 4, 7, 10, 13, 16]);
    expect(m.memory.roms[6][0x3FFF]).toBe(((0x3FFF * 3) + 1) & 0xFF);
    expect(m.memory.roms[5].every(b => b === 0)).toBe(true);
    expect(m.memory.roms[7].every(b => b === 0)).toBe(true);
    m.destroy();
  }, 30_000);
});
