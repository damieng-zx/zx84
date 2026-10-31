/**
 * ZX80/ZX81 add-ons: the ZX Printer (port 0xFB), the Chroma 81 colour
 * interface (port 0x7FEF and its RAM at 0xC000), the ZON X-81 AY sound
 * interface (ports 0xCF / 0x0F) and the vertical-sync (MIC) line.
 *
 * Expectations come from the devices' documentation, and for the printer
 * from the ROM's own character set (the printout of COPY and LPRINT must be
 * the font bytes of the characters shown, row for row).
 */

import { describe, it, expect } from 'vitest';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import { ZxPrinter } from '@/machines/zx8x/zx-printer.ts';
import { Chroma81, CHROMA_PALETTE } from '@/machines/zx8x/chroma81.ts';
import { boot, enterPrint42, haveZx81Rom, QUOTE, runUntil, type } from './rom-harness.ts';

/** A blank-ROM ZX81 with some add-ons fitted, reset. */
function bare(settings: Record<string, boolean>): Zx8xMachine {
  const m = new Zx8xMachine('zx81');
  m.prepare({ get: <T>(key: string, fallback: T): T => (key in settings ? settings[key] as T : fallback) });
  m.loadROM(new Uint8Array(0x2000));
  m.reset();
  return m;
}

/** Run Z80 code placed at $4100 until it HALTs. */
function run(m: Zx8xMachine, code: number[]): void {
  code.forEach((b, i) => m.memory.writeByte(0x4100 + i, b));
  m.cpu.pc = 0x4100;
  m.cpu.sp = 0x43f0;
  m.cpu.iff1 = false;
  runUntil(m, () => m.cpu.halted, 20);
}

describe('ZX Printer (port 0xFB)', () => {
  it('reports a printer present on bit 6 and runs the stylus latch from motor start', () => {
    const p = new ZxPrinter();
    // Bits 1-5 float, bit 6 low = connected. Nothing latched yet.
    expect(p.read(0) & 0xc1).toBe(0x00);
    p.write(0x00, 0);                                // bit 2 low: motor runs
    p.advance(120_000);
    const status = p.read(120_000);
    expect(status & 0x01).toBe(0x01);                // encoder latched
    expect(status & 0x40).toBe(0);
    // The latch stays set until the computer next writes to the printer.
    expect(p.read(120_001) & 0x01).toBe(0x01);
    p.write(0x00, 120_002);
    expect(p.read(120_003) & 0x01).toBe(0x00);
  });

  it('does not advance while the motor is stopped (bit 2 high)', () => {
    const p = new ZxPrinter();
    p.write(0x04, 0);
    p.advance(2_000_000);
    expect(p.read(2_000_000) & 0x81).toBe(0);
    expect(p.rowCount).toBe(0);
  });

  it('starts a new pixel row each sweep and burns dots only while the stylus is powered', () => {
    const p = new ZxPrinter();
    p.write(0x00, 0);
    // Run a whole sweep with the stylus off: a row of paper, nothing burnt.
    let t = 0;
    const step = (n: number): void => { t += n; p.advance(t); };
    step(300_000);
    expect(p.rowCount).toBeGreaterThanOrEqual(1);
    expect(Array.from(p.paperRows().subarray(0, 32)).every(b => b === 0)).toBe(true);
    // Power the stylus for the rest of the next sweep: that row is all burnt.
    const rows = p.rowCount;
    p.write(0x80, t);                                // stylus on, motor running
    step(300_000);
    const paper = p.paperRows();
    const burnt = (row: number): number => paper.subarray(row * 32, row * 32 + 32).reduce((n, b) => n + b.toString(2).replace(/0/g, '').length, 0);
    expect(burnt(rows)).toBeGreaterThan(200);        // most of a 256-dot row
    expect(burnt(rows - 1)).toBe(0);                 // the earlier row stayed clean
  });

  it.skipIf(!haveZx81Rom)('LPRINT through the real ROM burns the ROM font bytes of the line', () => {
    const m = boot({ 'zx81-zx-printer': true });
    type(m, [['ShiftLeft', 'KeyS'], QUOTE, 'KeyA', 'KeyB', QUOTE, 'Enter']);   // LPRINT "AB"
    runUntil(m, () => m.printer.rowCount >= 8, 600);
    for (let f = 0; f < 100; f++) m.tick();
    expect(m.printer.rowCount).toBe(8);
    const paper = m.printer.paperRows();
    // Characters A and B are codes $26 and $27; the ROM font starts at $1E00.
    for (let row = 0; row < 8; row++) {
      expect(paper[row * 32]).toBe(m.memory.readByte(0x1e00 + 0x26 * 8 + row));
      expect(paper[row * 32 + 1]).toBe(m.memory.readByte(0x1e00 + 0x27 * 8 + row));
      expect(paper.subarray(row * 32 + 2, row * 32 + 32).every(b => b === 0)).toBe(true);
    }
    // And the known 8x8 shape of an A: .###.. / #...#. etc (rows 1-6 of $3C,$42,$42,$7E,$42,$42).
    expect(Array.from({ length: 8 }, (_, r) => paper[r * 32])).toEqual([0x00, 0x3c, 0x42, 0x42, 0x7e, 0x42, 0x42, 0x00]);
  });

  it.skipIf(!haveZx81Rom)('COPY prints the 22 lines of the screen as 176 pixel rows matching the display', () => {
    const m = boot({ 'zx81-zx-printer': true });
    enterPrint42(m);
    type(m, ['KeyR', 'Enter']);                      // RUN: 42 at the top left
    type(m, ['KeyZ', 'Enter']);                      // COPY
    runUntil(m, () => m.printer.rowCount >= 176 && m.cpu.pc < 0x0800, 2000);
    for (let f = 0; f < 100; f++) m.tick();
    expect(m.printer.rowCount).toBe(176);
    const paper = m.printer.paperRows();
    const screen = m.screenExportBytes();            // 32 bytes x 192 rows of the picture
    for (let row = 0; row < 176; row++) {
      expect(Array.from(paper.subarray(row * 32, row * 32 + 32))).toEqual(Array.from(screen.subarray(row * 32, row * 32 + 32)));
    }
    expect(paper[1 * 32]).toBe(0x08);                // row 1 of a '4'
  });
});

describe('Chroma 81 (port 0x7FEF, RAM at 0xC000)', () => {
  const rgb = (m: Zx8xMachine, x: number, y: number): number[] => {
    const at = (y * m.frameWidth + x) * 4;
    return Array.from(m.pixels.subarray(at, at + 3));
  };
  const rgbOf = (c: number): number[] => [CHROMA_PALETTE[c] & 0xff, (CHROMA_PALETTE[c] >> 8) & 0xff, (CHROMA_PALETTE[c] >> 16) & 0xff];

  it('tells a program colour is available by reading bit 5 low', () => {
    expect(bare({ 'zx81-chroma81': true }).cpu.portInHandler!(0x7fef) & 0x20).toBe(0);
    // Without the interface the port is just the keyboard (bit 5 high).
    expect(bare({}).cpu.portInHandler!(0x7fef) & 0x20).toBe(0x20);
  });

  it('palette: full level when bright, 69% when dull; black and bright black are the same', () => {
    // IGRB: bit 3 bright, bit 2 green, bit 1 red, bit 0 blue.
    expect(rgbOf(0b1010)).toEqual([255, 0, 0]);
    expect(rgbOf(0b0110)).toEqual([176, 176, 0]);      // 0.69 x 255 = 176
    expect(rgbOf(0b1001)).toEqual([0, 0, 255]);
    expect(rgbOf(0b0000)).toEqual([0, 0, 0]);
    expect(rgbOf(0b1000)).toEqual([0, 0, 0]);
    expect(rgbOf(0b1111)).toEqual([255, 255, 255]);
  });

  it('control register: border, mode and enable bits; reset clears the colour RAM', () => {
    const c = new Chroma81();
    c.write(0b00111010);                                // E, M, bright red border
    expect(c.colourOn).toBe(true);
    expect(c.attributeMode).toBe(true);
    expect(c.border).toBe(CHROMA_PALETTE[0b1010]);
    c.write(0b11000000);                                // the reserved bits are not stored
    expect(c.colourOn).toBe(false);
    expect(c.control).toBe(0);
    c.ram[5] = 0x77;
    c.reset();
    expect(c.ram[5]).toBe(0);
  });

  it('its RAM answers data reads and writes at $C000-$FFFF only when fitted', () => {
    const fitted = bare({ 'zx81-chroma81': true });
    fitted.cpu.write8(0xc123, 0x5a);
    expect(fitted.cpu.read8(0xc123)).toBe(0x5a);
    expect(fitted.memory.readByte(0x4123)).toBe(0);     // not the $4000 echo
    const plain = bare({});
    plain.cpu.write8(0xc123, 0x5a);
    expect(plain.memory.readByte(0x4123)).toBe(0x5a);   // stock: A15 is not decoded
  });

  describe.skipIf(!haveZx81Rom)('on the real ROM screen (skipped without zx81-v2.rom)', () => {
    /** "42" at the top left; '4' (code $20) has font row 1 = $08, so x = 4 is
     *  ink and x = 0 paper on that line. */
    const screenWith42 = (): Zx8xMachine => {
      const m = boot({ 'zx81-chroma81': true });
      enterPrint42(m);
      type(m, ['KeyR', 'Enter']);
      return m;
    };
    const INK = 32 + 4, PAPER = 32 + 0, LINE1 = 24 + 1;

    it('character code mode: ink and paper come from the table entry of the character and line', () => {
      const m = screenWith42();
      expect(m.memory.readByte(0x1e00 + 0x20 * 8 + 1)).toBe(0x08);
      // Line 1 of '4': dull-blue paper (0001), bright-green ink (1100).
      m.cpu.write8(0xc000 + 0x20 * 8 + 1, 0x1c);
      m.cpu.portOutHandler!(0x7fef, 0b00100010);         // colour on, mode 0, dull red border
      m.tick();
      expect(rgb(m, INK, LINE1)).toEqual([0, 255, 0]);
      expect(rgb(m, PAPER, LINE1)).toEqual([0, 0, 176]);
      // The '2' next to it has an all-zero table entry: black on black.
      expect(rgb(m, 32 + 8 + 2, 24 + 2)).toEqual([0, 0, 0]);
      expect(rgb(m, 5, 5)).toEqual([176, 0, 0]);        // the border
    });

    it('character code mode: an inverse character uses its own table entry ($C200 on)', () => {
      const m = screenWith42();
      // Make the '4' at the top left inverse (bit 7 set in the display file).
      const cell = m.cpu.read8(0x400c) | (m.cpu.read8(0x400d) << 8);
      m.cpu.write8(cell + 1, m.cpu.read8(cell + 1) | 0x80);
      m.cpu.write8(0xc000 + 0x20 * 8 + 1, 0x1c);        // the normal '4' entry (must not be used)
      m.cpu.write8(0xc200 + 0x20 * 8 + 1, 0x2a);        // inverse '4': dull red paper, bright red ink
      m.cpu.portOutHandler!(0x7fef, 0b00100000);
      m.tick();
      // Inverted: the set pixel (x = 4) is paper, a clear pixel (x = 0) ink.
      expect(rgb(m, INK, LINE1)).toEqual([176, 0, 0]);
      expect(rgb(m, PAPER, LINE1)).toEqual([255, 0, 0]);
    });

    it('attribute file mode: each display-file byte is coloured by the byte at its address | $C000', () => {
      const m = screenWith42();
      const cell = (m.cpu.read8(0x400c) | (m.cpu.read8(0x400d) << 8)) + 1;   // the '4'
      m.cpu.write8(0xc000 | cell, 0x2b);                // dull red paper (0010), bright magenta ink (1011)
      m.cpu.write8(0xc000 + 0x20 * 8 + 1, 0x77);        // the mode 0 table must be ignored
      m.cpu.portOutHandler!(0x7fef, 0b00110000);         // colour on, mode 1, black border
      m.tick();
      expect(rgb(m, INK, LINE1)).toEqual([255, 0, 255]);
      expect(rgb(m, PAPER, LINE1)).toEqual([176, 0, 0]);
      // Every line of that one cell takes the one attribute.
      expect(rgb(m, PAPER, 24 + 6)).toEqual([176, 0, 0]);
    });

    it('colour off leaves the monochrome picture: black on white, white border', () => {
      const m = screenWith42();
      m.cpu.write8(0xc000 + 0x20 * 8 + 1, 0x1c);        // table filled, but colour not enabled
      m.tick();
      expect(rgb(m, INK, LINE1)).toEqual([0, 0, 0]);
      expect(rgb(m, PAPER, LINE1)).toEqual([255, 255, 255]);
      expect(rgb(m, 5, 5)).toEqual([255, 255, 255]);
    });
  });
});

describe('ZON X-81 (AY-3-8912 on ports $CF and $0F)', () => {
  const program = [
    0x3e, 0x00, 0xd3, 0xcf, 0x3e, 0xfe, 0xd3, 0x0f,     // reg 0 (tone A low)  = $FE
    0x3e, 0x01, 0xd3, 0xcf, 0x3e, 0x00, 0xd3, 0x0f,     // reg 1 (tone A high) = 0
    0x3e, 0x07, 0xd3, 0xcf, 0x3e, 0x3e, 0xd3, 0x0f,     // reg 7 mixer: tone A on, the rest off
    0x3e, 0x08, 0xd3, 0xcf, 0x3e, 0x0f, 0xd3, 0x0f,     // reg 8 volume A = 15
    0x76,
  ];

  it('selects a register on $CF and writes it on $0F', () => {
    const m = bare({ 'zx8x-zonx': true });
    run(m, program);
    const regs = m.ay.getRegisters();
    expect(regs[0]).toBe(0xfe);
    expect(regs[1]).toBe(0);
    expect(regs[7]).toBe(0x3e);
    expect(regs[8]).toBe(15);
  });

  it('ignores the ports when not fitted, and other ports when fitted', () => {
    const plain = bare({});
    run(plain, program);
    expect(Array.from(plain.ay.getRegisters())).toEqual(new Array(14).fill(0));
    const m = bare({ 'zx8x-zonx': true });
    // $CE and $1F share most address bits with $CF/$0F but are not the device.
    run(m, [0x3e, 0x08, 0xd3, 0xce, 0x3e, 0x0f, 0xd3, 0x1f, 0x76]);
    expect(m.ay.getRegisters()[8]).toBe(0);
  });

  it('sounds the tone at the CPU clock / 2 / (16 x period): 1.625MHz / 4064 = 400Hz', () => {
    const m = bare({ 'zx8x-zonx': true });
    run(m, program);
    const samples: number[] = [];
    for (let i = 0; i < 48000; i++) samples.push(m.ay.generateSampleStereo().left);
    const mid = (Math.max(...samples) + Math.min(...samples)) / 2;
    let rises = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i - 1] <= mid && samples[i] > mid) rises++;
    expect(rises).toBeGreaterThanOrEqual(398);
    expect(rises).toBeLessThanOrEqual(402);
  });
});

describe('vertical sync on the MIC line', () => {
  it('goes low from an IN of port $FE until the next OUT, and the recorder times it', () => {
    const m = bare({});
    const nops = (n: number): number[] => new Array(n).fill(0x00);
    // OUT, IN (sync on, but the line was already high: no edge is recorded
    // until it comes back), 10 NOPs, OUT, 4 NOPs, IN, 20 NOPs, OUT, 4 NOPs,
    // IN, 10 NOPs, OUT. The line is high 4 NOPs long twice and low for 20
    // then 10 NOPs: the lows differ by exactly the 10 extra NOPs (40T).
    run(m, [
      0xd3, 0xff, 0xdb, 0xfe, ...nops(10), 0xd3, 0xff,
      ...nops(4), 0xdb, 0xfe, ...nops(20), 0xd3, 0xff,
      ...nops(4), 0xdb, 0xfe, ...nops(10), 0xd3, 0xff, 0x76,
    ]);
    const pulses = Array.from(m.micRecorder.pulses());
    expect(pulses).toHaveLength(4);
    const [high1, low20, high2, low10] = pulses;
    expect(high1).toBe(high2);
    expect(low20 - low10).toBe(40);
    // An IN (11T) plus its NOPs and the OUT (11T) bracket a low: 11 + 4n
    // within the instruction-phase offsets of the I/O cycles (3T either way).
    expect(Math.abs(low10 - (11 + 40))).toBeLessThanOrEqual(4);
  });

  it('does not start sync from a read of another port', () => {
    const m = bare({});
    run(m, [0xd3, 0xff, 0xdb, 0xfb, 0xdb, 0xff, 0x76]);   // OUT, IN $FB, IN $FF
    expect(m.micRecorder.count).toBe(0);
    expect(m.micLevel).toBe(1);
  });
});
