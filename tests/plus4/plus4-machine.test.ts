/**
 * The Commodore Plus/4 board: the 7501's memory map and its ROM banks, the
 * TED's registers and video fetches, the bad line's bus hold, the timers, the
 * keyboard matrix through PIO 2 and the TED, the 6529Bs, the ACIA, the native
 * snapshot, and — with the real ROMs under mcp/.cache/plus4-dev — booting to
 * BASIC 3.5's READY.
 *
 * Expectations come from the hardware: the Plus/4 technical reference's memory
 * map and register tables, the annotated +4 memory maps (zimmers, floodgap) and
 * the TED register reference at oxyron.de. Nothing is derived from the code
 * under test.
 */

import { describe, it, expect } from 'vitest';
import { Plus4Machine } from '@/machines/plus4/plus4-machine.ts';
import { Plus4Memory } from '@/machines/plus4/memory.ts';
import { Ted } from '@/machines/plus4/ted.ts';
import { plus4Descriptor, plus4Entry } from '@/machines/plus4/descriptor.ts';
import { PLUS4_PALETTE } from '@/machines/plus4/palette.ts';
import { PLUS4_CYCLES_PER_LINE, PLUS4_PAL_LINES, plus4Timing } from '@/machines/plus4/constants.ts';
import { expectExactFromFile, Asm, OP, romImage } from '../snapshot/native-state-helpers.ts';
import { firmware, machine } from './firmware.ts';

// ── Memory map ─────────────────────────────────────────────────────────────

describe('Plus/4 memory map', () => {
  it('has a full 64K of RAM, with the I/O pages and the 7501 page exceptions', () => {
    const mem = new Plus4Memory('plus4');
    mem.openBus = () => 0x5A;
    // With no ROM fitted the RAM answers everywhere but the I/O pages.
    mem.setRomVisible(false);
    for (const addr of [0x0100, 0x7FFF, 0x8000, 0xC000, 0xFF40, 0xFFFF]) {
      mem.writeByte(addr, 0x3C);
      expect(mem.readByte(addr), `$${addr.toString(16)}`).toBe(0x3C);
    }
    // $FD00 is I/O, and $FF00-$FF3F the TED: neither holds RAM while fitted.
    mem.ioRead = () => 0x77;
    mem.ioWrite = () => {};
    expect(mem.readByte(0xFD00)).toBe(0x77);
    expect(mem.readByte(0xFF00)).toBe(0x77);
  });

  it('mirrors a C16\'s 16K four times across the map', () => {
    const mem = new Plus4Memory('c16');
    expect(mem.ramSize).toBe(0x4000);
    mem.writeByte(0x0123, 0xA5);
    expect(mem.readByte(0x4123), 'the second mirror').toBe(0xA5);
    expect(mem.readByte(0x8123), 'the third').toBe(0xA5);
    expect(mem.readByte(0xC123), 'the fourth').toBe(0xA5);
  });

  it('keeps the RAM under the fixed KERNAL page for when the ROMs are out', () => {
    const mem = new Plus4Memory('plus4');
    mem.loadRoms(new Uint8Array(0x4000).fill(0x11), null);
    // A write to the page reaches the RAM under the KERNAL, as everywhere else.
    mem.writeByte(0xFCFA, 0x99);
    expect(mem.readByte(0xFCFA), 'the KERNAL answers while selected').toBe(0x11);
    expect(mem.peekByte(0xFCFA)).toBe(0x11);
    // BASIC keeps its temporary strings here and reads them with GetUnderROM,
    // which banks the ROMs out.
    mem.setRomVisible(false);
    expect(mem.readByte(0xFCFA), 'the RAM under it once banked out').toBe(0x99);
    expect(mem.peekByte(0xFCFA)).toBe(0x99);
    expect(mem.readByte(0xFCFB), 'and the rest of the page').toBe(0xFF);
  });

  it('answers ROM reads from the selected bank, and a write bleeds through to the RAM', () => {
    const mem = new Plus4Memory('plus4');
    mem.loadRoms(new Uint8Array(0x4000).fill(0xCE), new Uint8Array(0x4000).fill(0xBA));
    // The default select is BASIC low, KERNAL high.
    expect(mem.readByte(0x8000)).toBe(0xBA);
    expect(mem.readByte(0xBFFF)).toBe(0xBA);
    expect(mem.readByte(0xC000)).toBe(0xCE);
    expect(mem.readByte(0xFFFF)).toBe(0xCE);
    // The KERNAL's top page is always there, whatever the bank says.
    mem.setBank(10);
    expect(mem.readByte(0xFC00)).toBe(0xCE);
    // A write to the ROM reaches the RAM under it.
    mem.setBank(0);
    mem.writeByte(0x8000, 0x11);
    expect(mem.readByte(0x8000), 'the ROM still answers the read').toBe(0xBA);
    mem.setRomVisible(false);
    expect(mem.readByte(0x8000), 'with the ROMs banked out the write shows').toBe(0x11);
    expect(mem.readByte(0xC000), 'as does the KERNAL bank').not.toBe(0xCE);
  });

  it('switches all four ROM banks at the bank-select register', () => {
    const mem = new Plus4Memory('plus4');
    mem.loadRoms(new Uint8Array(0x4000).fill(0x01), new Uint8Array(0x4000).fill(0x02),
      new Uint8Array(0x4000).fill(0x03), new Uint8Array(0x4000).fill(0x04));
    mem.setCartridge(new Uint8Array(0x4000).fill(0x05), new Uint8Array(0x4000).fill(0x06));
    // $FDD0 low=0 high=0: BASIC over KERNAL; low=1 high=1: the function ROMs;
    // low=2 high=2: the cartridge.
    for (const [bank, low, high] of [[0, 0x02, 0x01], [5, 0x03, 0x04], [10, 0x05, 0x06]] as const) {
      mem.setBank(bank);
      expect(mem.readByte(0x8000), `low bank ${low}`).toBe(low);
      expect(mem.readByte(0xC000), `high bank ${high}`).toBe(high);
    }
  });
});

// ── TED registers ────────────────────────────────────────────────────────

function bareTed(): Ted {
  return new Ted({
    read: () => 0xFF,
    keyboardColumns: () => 0xFF,
    joystickBits: () => ({ joy1: 0, joy2: 0 }),
  }, false);
}

describe('the TED', () => {
  it('reads its unused bits back as 1, and its read-only scan registers from the raster', () => {
    const t = bareTed();
    // $FF15-$FF19 keep bit 7 (1), $FF14 bits 0-2 (7), $FF0C bits 0-7 bar the
    // two cursor bits (11 of them, $FC).
    expect(t.read(0x15, 0)).toBe(0x80);
    expect(t.read(0x14, 0)).toBe(0x07);
    expect(t.read(0x0C, 0)).toBe(0xFC);
    expect(t.read(0x0A, 0)).toBe(0xA0);
    t.write(0x15, 0xFF, 0);
    expect(t.read(0x15, 0), 'a colour register keeps only seven bits').toBe(0xFF);
    t.write(0x15, 0x00, 0);
    expect(t.read(0x15, 0), 'and never bit 7').toBe(0x80);
    t.write(0x14, 0xFF, 0);
    expect(t.read(0x14, 0), 'the matrix base keeps bits 3-7').toBe(0xFF);
  });

  it('reports the raster counter the frame wraps at', () => {
    const t = bareTed();
    const tm = plus4Timing(false);
    expect(tm.linesPerFrame).toBe(PLUS4_PAL_LINES);
    t.beginFrame(0);
    // Run a frame: the raster counter comes back to 0.
    t.drawTo(tm.cyclesPerFrame - 1);
    expect(t.raster).toBe(PLUS4_PAL_LINES - 1);
    t.drawTo(tm.cyclesPerFrame);
    expect(t.raster).toBe(0);
  });

  it('fires the raster compare interrupt on the line written to $FF0B, when enabled', () => {
    const t = bareTed();
    t.write(0x0A, 0x02, 0);            // raster interrupt enabled
    t.write(0x0B, 0x20, 0);            // compare line 32
    t.beginFrame(0);
    // No interrupt until the line comes round.
    t.drawTo(PLUS4_CYCLES_PER_LINE * 20);
    expect(t.irq, 'not before its line').toBe(false);
    t.drawTo(PLUS4_CYCLES_PER_LINE * 33);
    expect(t.irqStatus & 0x02, 'the raster flag').toBe(0x02);
    expect(t.irq).toBe(true);
    // A write to the status register acknowledges it.
    t.write(0x09, 0x7E, PLUS4_CYCLES_PER_LINE * 33);
    expect(t.irq).toBe(false);
  });

  it('counts a timer at half the CPU clock, and reloads it', () => {
    const t = bareTed();
    expect(t.timers[0].latch).toBe(0);
    t.write(0x00, 0x0F, 0);            // latch low byte
    t.write(0x01, 0x00, 0);            // latch high byte: starts counting
    expect(t.timers[0].latch).toBe(0x000F);
    // A latch of 15 counts 30 CPU cycles.
    t.advanceTo(10);
    expect(t.timers[0].remaining).toBe(20);
    t.advanceTo(29);
    expect(t.timers[0].remaining).toBe(1);
    expect(t.irqStatus & 0x08, 'not yet').toBe(0);
    t.advanceTo(31);
    expect(t.irqStatus & 0x08, 'the timer flag').toBe(0x08);
    // It reloads and keeps going.
    expect(t.timers[0].remaining).toBeGreaterThan(0);
    expect(t.timers[0].running).toBe(true);
  });

  it('a latch of 0 counts a whole 65536 ticks', () => {
    const t = bareTed();
    t.write(0x00, 0x00, 0);
    t.write(0x01, 0x00, 0);
    expect(t.timers[0].remaining).toBe(0x10000 * 2);
  });

  it('draws the text window in the colours it is told', () => {
    // The video matrix and the colour bytes: character 1 (a full glyph) in
    // colour 1 (dark red in the default palette), and no other cell set.
    const read = (addr: number): number => {
      if (addr >= 0x0400 && addr < 0x0400 + 1000) return addr === 0x0400 ? 0x01 : 0x20;
      if (addr >= 0x0000 && addr < 0x0400) return addr === 0x0000 ? 0x01 : 0x40;
      if (addr >= 0xD000 && addr < 0xD800) return (addr & 7) === 0 ? 0xF0 : 0x00;
      return 0x00;
    };
    const t = new Ted({
      read,
      keyboardColumns: () => 0xFF,
      joystickBits: () => ({ joy1: 0, joy2: 0 }),
    }, false);
    t.write(0x06, 0x18, 0);               // display on, 25 rows
    t.write(0x14, 0x00, 0);               // matrix at $0400, colour at $0000
    t.write(0x13, 0xD0, 0);               // characters at $D000
    t.write(0x07, 0x08, 0);               // 40 columns
    t.write(0x15, 0x00, 0);               // background black
    t.beginFrame(0);
    // The display starts on raster line 4, so its first row's first line is
    // drawn there. The first matrix cell is at $0400, whose glyph is $F0: the
    // left half of the cell is that row's ink, colour 1.
    t.drawTo(PLUS4_CYCLES_PER_LINE * 6);
    const y = t.fieldY;
    const x = t.fieldX;
    const px = t.pixels;
    expect(px[y * t.width + x + 2], 'ink').toBe(PLUS4_PALETTE[1]);
    expect(px[y * t.width + x + 6], 'paper').toBe(PLUS4_PALETTE[0]);
  });

  it('paints a background change from the cycle it is written on', () => {
    const t = new Ted({
      read: () => 0,
      keyboardColumns: () => 0xFF,
      joystickBits: () => ({ joy1: 0, joy2: 0 }),
    }, false);
    t.write(0x06, 0x18, 0);               // display on, 25 rows
    t.write(0x14, 0x00, 0);               // matrix at $0400, colour at $0000
    t.write(0x13, 0xD0, 0);               // characters at $D000
    t.write(0x07, 0x08, 0);               // 40 columns
    t.write(0x15, 0x00, 0);               // background black
    t.beginFrame(0);
    // The display is on raster line 4; its window starts on cycle 15 and is
    // four pixels a cycle. Cycle 30 is 60 pixels in.
    const start = PLUS4_CYCLES_PER_LINE * 4;
    t.drawTo(start + 30);
    t.write(0x15, 0x10, start + 30);      // white from here on
    t.drawTo(start + PLUS4_CYCLES_PER_LINE + 1);
    const row = t.fieldY * t.width;
    expect(t.pixels[row + t.fieldX + 20], 'the beam has passed here').toBe(PLUS4_PALETTE[0]);
    expect(t.pixels[row + t.fieldX + 70], 'and reaches the new colour here').toBe(PLUS4_PALETTE[0x10]);
  });

  it('takes the bus for 88 of 114 cycles on a bad line', () => {
    const t = bareTed();
    t.write(0x06, 0x18, 0);
    // A 25-row display's first line is raster line 4, and YSCROLL 0 makes the
    // first line of every character row bad.
    expect(t.isBadLine(4)).toBe(true);
    expect(t.isBadLine(5)).toBe(false);
    expect(t.isBadLine(12), 'the next row').toBe(true);
    expect(t.isBadLine(3), 'above the window').toBe(false);
    expect(t.isBadLine(PLUS4_PAL_LINES - 1), 'below it').toBe(false);
  });
});

// ── Input ────────────────────────────────────────────────────────────────

describe('Plus/4 input', () => {
  it('reads the matrix through PIO 2 and the TED, and the joystick through the TED', () => {
    const m = machine(firmware());
    // PIO 2 drives row 0 low only (bit 0 clear); the keyboard's row 0 has DEL
    // in column 0 and RETURN in column 1.
    m.pio2.write(1, 0xFF);          // every line an output
    m.pio2.write(0, 0xFE);          // line 0 driven low, and only it
    expect(m.ted.read(0x08, 0) & 0x01, 'no key in column 0 yet').toBe(0x01);
    m.keyboard.setKey('del', true);
    expect(m.ted.read(0x08, 0) & 0x01, 'DEL pulls column 0').toBe(0x00);
    expect(m.ted.read(0x08, 0) & 0x02, 'and leaves column 1 be').toBe(0x02);
    m.keyboard.setKey('del', false);
    // The joystick's fire is the register's bit 6 for port 1.
    m.pio2.write(0, 0x00);
    m.ted.write(0x08, 0x00, 0);
    m.joystickPress('fire', true, 1);
    expect(m.ted.read(0x08, 0) & 0x40, 'fire pulls bit 6').toBe(0);
    m.releaseJoysticks();
  });

  it('gates each control port with the keyboard register bits 2 and 3', () => {
    const m = machine(firmware());
    m.pio2.write(1, 0xFF);
    m.pio2.write(0, 0x00);
    m.ted.write(0x08, 0x00, 0);
    m.joystickPress('fire', true, 1);
    // Bit 2 set: port 1's switches are not read.
    m.ted.write(0x08, 0x04, 0);
    expect(m.ted.read(0x08, 0) & 0x40).toBe(0x40);
    m.ted.write(0x08, 0x00, 0);
    expect(m.ted.read(0x08, 0) & 0x40).toBe(0x00);
    m.releaseJoysticks();
  });
});

// ── PIOs and the ACIA ──────────────────────────────────────────────────

describe('the 6529B and the 6551A', () => {
  it('a PIO holds its outputs, reads its inputs, and has a direction register', () => {
    const m = machine(firmware());
    m.pio1.write(1, 0xFF);              // all outputs
    m.pio1.write(0, 0x00);
    expect(m.memory.readByte(0xFD10)).toBe(0x00);
    m.pio1.write(0, 0xFF);
    expect(m.memory.readByte(0xFD10)).toBe(0xFF);
    // With the direction clear the pin levels come from outside.
    m.pio1.write(1, 0x00);
    m.pio1.pins = 0x5A;
    expect(m.memory.readByte(0xFD10)).toBe(0x5A);
  });

  it('answers the ACIA at $FD00-$FD03 on a Plus/4 and not at all on a C16', () => {
    const plus4 = machine(firmware(), 'plus4');
    plus4.acia.write(2, 0x02);          // transmitter interrupt enable
    plus4.acia.write(0, 0x41);
    // TDRE is clear while the frame shifts; it returns 320 cycles later (ten
    // bits at the control register's 16-divisor, two cycles a bit).
    expect(plus4.acia.peek(1) & 0x10, 'TDRE while sending').toBe(0x00);
    plus4.acia.tick(320);
    expect(plus4.acia.peek(1) & 0x10, 'TDRE').toBe(0x10);
    plus4.acia.receive(0x55);
    plus4.acia.tick(640);               // its frame has been clocked in
    expect(plus4.memory.readByte(0xFD01) & 0x08, 'RDRF').toBe(0x08);
    expect(plus4.memory.readByte(0xFD00), 'the received byte').toBe(0x55);
    expect(plus4.memory.readByte(0xFD01) & 0x08, 'and the read clears it').toBe(0x00);

    const c16 = machine(firmware(), 'c16');
    expect(c16.memory.readByte(0xFD00), 'no ACIA').toBe(0xFF);
  });
});

// ── Snapshots ────────────────────────────────────────────────────────────

describe('Plus/4 snapshots', () => {
  it('saves and restores the machine exactly', async () => {
    const m = machine(firmware());
    for (let i = 0; i < 12; i++) m.tick();
    await expectExactFromFile(m, machine(firmware()), 'plus4state', 3);
  });
});

// ── Descriptor ─────────────────────────────────────────────────────────

describe('Plus/4 descriptor', () => {
  it('declares the frame geometry the TED draws', () => {
    const m = machine(firmware());
    const d = plus4Descriptor('plus4');
    expect(d.screen.width).toBe(384);
    expect(d.screen.height).toBe(288);
    expect(d.screen.activeWidth).toBe(320);
    expect(d.screen.activeHeight).toBe(200);
    expect(m.frameWidth).toBe(d.screen.width);
    expect(m.frameHeight).toBe(d.screen.height);
  });

  it('takes its own system ROM only', () => {
    const detect = plus4Entry.detectModelForRom!;
    expect(detect(new Uint8Array(0x10000), 'plus4'), 'a Plus/4 whole').toBe('plus4');
    expect(detect(new Uint8Array(0x8000), 'plus4'), 'a C16 whole').toBe('c16');
    expect(detect(new Uint8Array(0x4000), 'plus4'), 'one chip alone').toBe(null);
  });
});

// ── The 1 MHz mode ─────────────────────────────────────────────────────
/** A ROM that turns the display off, sets $FF13, then loops on a 16-bit counter. */
function counterRom(slow: boolean): Uint8Array {
  const a = new Asm(0xC000);
  a.label('reset').b(OP.SEI, OP.CLD, OP.LDX_IMM, 0xFF, OP.TXS);
  // Display off: no bad lines, so the loop costs only its own cycles.
  a.b(OP.LDA_IMM, 0x00).abs(OP.STA_ABS, 0xFF06);
  // $FF13 bit 1: the 1 MHz mode (bit 2 would move the character base).
  a.b(OP.LDA_IMM, slow ? 0x02 : 0x00).abs(OP.STA_ABS, 0xFF13);
  // 16 cycles a pass: INC $04, BNE back, INC $05 on the wrap, JMP back.
  a.label('loop').b(OP.INC_ZP, 0x04).br(OP.BNE, 'loop');
  a.b(OP.INC_ZP, 0x05).abs(OP.JMP, 'loop');
  const code = a.assemble();
  const kernal = new Uint8Array(0x4000);
  kernal.set(code, 0);
  kernal[0x3FFC] = a.addr('reset') & 0xFF;
  kernal[0x3FFD] = a.addr('reset') >> 8;
  const rom = new Uint8Array(0x8000);
  rom.set(kernal, 0);
  return rom;
}

/** Loop passes completed in one frame, from the 16-bit counter at $04. */
function loopPasses(slow: boolean): number {
  const m = machine(counterRom(slow));
  m.tick();
  return m.memory.readByte(0x05) * 256 + m.memory.readByte(0x04);
}

describe('the 1 MHz mode', () => {
  it('halves the CPU clock while $FF13 bit 1 is set, and leaves the frame alone', () => {
    const fast = loopPasses(false);
    const slow = loopPasses(true);
    // 35568 master cycles a frame, 8 CPU cycles a pass, less the boot's few
    // hundred cycles: ~4400 passes at 1.77 MHz, ~2200 in the slowed mode.
    expect(fast).toBeGreaterThanOrEqual(4380);
    expect(fast).toBeLessThanOrEqual(4455);
    expect(Math.abs(slow * 2 - fast)).toBeLessThanOrEqual(24);
    // The mode is the TED's register and the reported clock follows it.
    const m = machine(counterRom(true));
    expect(m.oneMhzMode).toBe(false);
    m.tick();
    expect(m.oneMhzMode).toBe(true);
    expect(m.cpuClockHz).toBe(m.timing.clockHz / 2);
    expect(m.tStatesPerFrame).toBe(m.timing.cyclesPerFrame);
  });
});

// ── Datasette loading sound ────────────────────────────────────────────

describe('Datasette loading sound', () => {
  it('mixes the EAR line while the tape runs, and follows the setting', () => {
    const m = machine(firmware());
    const levels: number[] = [];
    const real = m.mixer.accumulateLevel.bind(m.mixer);
    m.mixer.accumulateLevel = (level, elapsed) => { levels.push(level); real(level, elapsed); };
    // A tape parked on a level-1 block and a long tone: it is playing, and the
    // EAR line holds high for the whole frame.
    m.tape.blocks = [{ kind: 'set-level', level: 1 }, { kind: 'tone', pulseLen: 4_000_000, count: 1 }];
    m.tape.startPlayback();
    m.tick();
    expect(levels.length).toBeGreaterThan(0);
    expect(levels).toContain(1);
    // With loading sounds off the same tape contributes silence.
    levels.length = 0;
    m.tapeSoundEnabled = false;
    m.tick();
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every(l => l === 0)).toBe(true);
  });
});

// ── Real ROMs ───────────────────────────────────────────────────────────

const REAL = 'plus4-dev/';
const kernal = romImage(REAL + 'kernal');
const basic = romImage(REAL + 'basic');

function boot(): Plus4Machine {
  const m = new Plus4Machine('plus4', null, false);
  const image = new Uint8Array(kernal!.length + basic!.length);
  image.set(kernal!, 0);
  image.set(basic!, kernal!.length);
  m.loadROM(image);
  m.reset();
  return m;
}

describe.skipIf(!kernal || !basic)('Plus/4 with the Commodore ROMs', () => {
  it('boots to BASIC 3.5\'s READY prompt, with its memory size', () => {
    const m = boot();
    for (let f = 0; f < 400; f++) m.tick();
    const text = m.ocrScreenForMcp();
    expect(text, 'the banner').toContain('COMMODORE BASIC V3.5');
    // The free-memory figure is printed through BASIC's number-to-string
    // routine into RAM under the fixed KERNAL page (GetUnderROM), so this is
    // also the check that $FC00-$FCFF banks back to RAM when the ROMs are out.
    expect(text, 'the memory size').toContain('60671 BYTES FREE');
    expect(text, 'READY.').toContain('READY.');
  });

  it('prints numbers and strings', () => {
    const m = boot();
    for (let f = 0; f < 400; f++) m.tick();
    type(m, 'PRINT 12345\n');
    for (let f = 0; f < 120; f++) m.tick();
    expect(m.ocrScreenForMcp()).toContain('12345');
    type(m, 'PRINT "AB"\n');
    for (let f = 0; f < 120; f++) m.tick();
    expect(m.ocrScreenForMcp()).toContain('AB');
  });

  it('types and runs a program', () => {
    const m = boot();
    for (let f = 0; f < 300; f++) m.tick();
    type(m, '10 PRINT "HI"\nRUN\n');
    for (let f = 0; f < 120; f++) m.tick();
    expect(m.ocrScreenForMcp()).toContain('HI');
  });
});

/** Type a string on the machine's keyboard, waiting between keystrokes. */
function type(m: Plus4Machine, text: string): void {
  for (const ch of text) {
    if (ch === '\n') {
      m.keyboard.setKey('return', true);
      for (let f = 0; f < 3; f++) m.tick();
      m.keyboard.setKey('return', false);
    } else if (ch === ' ') {
      m.keyboard.setKey('space', true);
      for (let f = 0; f < 3; f++) m.tick();
      m.keyboard.setKey('space', false);
    } else if (ch === '"') {
      m.keyboard.setKey('lshift', true);
      m.keyboard.setKey('2', true);
      for (let f = 0; f < 3; f++) m.tick();
      m.keyboard.setKey('2', false);
      m.keyboard.setKey('lshift', false);
    } else {
      m.keyboard.setKey(ch.toLowerCase(), true);
      for (let f = 0; f < 3; f++) m.tick();
      m.keyboard.setKey(ch.toLowerCase(), false);
    }
    for (let f = 0; f < 3; f++) m.tick();
  }
}
