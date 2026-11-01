/**
 * The Commodore VIC-20 board: the memory map and what the VIC can see of it,
 * the I/O decode, the keyboard matrix through VIA 2, the interrupt wiring of
 * the two VIAs, the VIC's text area, raster register and colour modes, the
 * native snapshot, and — with the real ROMs under mcp/.cache or
 * ZX84_ROM_DIR — booting to BASIC's READY.
 *
 * Expectations come from the hardware, not the code: the memory map and VIA
 * port assignments in the VIC-20 Programmer's Reference Guide, the KERNAL's
 * keyboard decode table (scan code = column × 8 + row, columns driven on
 * $9120, rows read on $9121), the VIC register layout ($9000-$900F) and the
 * colour-RAM / screen-address wiring (VIC A13 = CPU A15 inverted; colour RAM
 * addressed by the low ten bits of the screen address).
 */

import { describe, it, expect } from 'vitest';
import { Vic20Machine } from '@/machines/vic20/vic20-machine.ts';
import { Vic20Memory, VIC20_NO_EXPANSION } from '@/machines/vic20/memory.ts';
import { Vic } from '@/machines/vic20/vic.ts';
import { VIC20_PALETTE } from '@/machines/vic20/palette.ts';
import { VIC20_NTSC_TIMING, VIC20_PAL_TIMING } from '@/machines/vic20/constants.ts';
import { vic20Descriptor, vic20Entry } from '@/machines/vic20/descriptor.ts';
import { expectExactFromFile, expectRefusedUntouched, romImage } from '../snapshot/native-state-helpers.ts';
import { firmware, machine } from './firmware.ts';


// ── Memory map ─────────────────────────────────────────────────────────────

describe('VIC-20 memory map', () => {
  it('has RAM on the board at $0000-$03FF and $1000-$1FFF only', () => {
    const mem = new Vic20Memory();
    mem.openBus = () => 0x5A;
    for (const addr of [0x0000, 0x03FF, 0x1000, 0x1FFF]) {
      mem.writeByte(addr, 0x3C);
      expect(mem.readByte(addr), `$${addr.toString(16)}`).toBe(0x3C);
    }
    // Unexpanded: the 3K block, BLK1-3 and BLK5 are empty and read the bus.
    for (const addr of [0x0400, 0x0FFF, 0x2000, 0x5000, 0x7FFF, 0xA000, 0xBFFF]) {
      mem.writeByte(addr, 0x3C);
      expect(mem.readByte(addr), `$${addr.toString(16)} is empty`).toBe(0x5A);
    }
  });

  it('answers with expansion RAM where it is fitted', () => {
    const mem = new Vic20Memory();
    mem.openBus = () => 0x5A;
    mem.setExpansion({ ...VIC20_NO_EXPANSION, ram123: true, blk2: true });
    mem.writeByte(0x0400, 0x11);
    mem.writeByte(0x4000, 0x22);
    mem.writeByte(0x2000, 0x33);
    expect(mem.readByte(0x0400)).toBe(0x11);
    expect(mem.readByte(0x4000)).toBe(0x22);
    expect(mem.readByte(0x2000), 'BLK1 is still empty').toBe(0x5A);
  });

  it('maps the character ROM at $8000, BASIC at $C000 and the KERNAL at $E000, read only', () => {
    const mem = new Vic20Memory();
    const basic = new Uint8Array(0x2000).fill(0xBA);
    const kernal = new Uint8Array(0x2000).fill(0xCE);
    const chargen = new Uint8Array(0x1000).fill(0xC4);
    mem.loadRoms(basic, kernal, chargen);
    expect(mem.readByte(0x8000)).toBe(0xC4);
    expect(mem.readByte(0x8FFF)).toBe(0xC4);
    expect(mem.readByte(0xC000)).toBe(0xBA);
    expect(mem.readByte(0xDFFF)).toBe(0xBA);
    expect(mem.readByte(0xE000)).toBe(0xCE);
    expect(mem.readByte(0xFFFF)).toBe(0xCE);
    mem.writeByte(0xE000, 0);
    mem.writeByte(0x8000, 0);
    expect(mem.readByte(0xE000)).toBe(0xCE);
    expect(mem.readByte(0x8000)).toBe(0xC4);
  });

  it('keeps four bits of colour RAM; the top four read the bus', () => {
    const mem = new Vic20Memory();
    mem.openBus = () => 0xA5;
    mem.writeByte(0x9600, 0xFF);
    expect(mem.readByte(0x9600)).toBe(0xAF);
    mem.writeByte(0x97FF, 0x13);
    expect(mem.readByte(0x97FF)).toBe(0xA3);
    expect(mem.colorRam[0x3FF]).toBe(0x03);
  });

  it('shows the VIC the character ROM and the board RAM, not expansion RAM', () => {
    const mem = new Vic20Memory();
    mem.setExpansion({ ...VIC20_NO_EXPANSION, ram123: true });
    const chargen = new Uint8Array(0x1000);
    chargen[0x123] = 0x77;
    mem.loadRoms(null, null, chargen);
    mem.writeByte(0x1E00, 0x41);
    mem.writeByte(0x0200, 0x42);
    mem.writeByte(0x0400, 0x43);
    // VIC A13 is CPU A15 inverted.
    expect(mem.vicRead(0x0123), 'VIC $0123 is CPU $8123').toBe(0x77);
    expect(mem.vicRead(0x3E00), 'VIC $3E00 is CPU $1E00').toBe(0x41);
    expect(mem.vicRead(0x2200), 'VIC $2200 is CPU $0200').toBe(0x42);
    expect(mem.vicRead(0x2400), 'the 3K expansion is not on the VIC bus').toBe(0xFF);
  });
});

// ── I/O decode ─────────────────────────────────────────────────────────────

describe('VIC-20 I/O decode', () => {
  it('repeats the VIC every 16 bytes in $9000-$90FF', () => {
    const m = machine(firmware());
    m.memory.writeByte(0x9010, 0x55);
    expect(m.vic.regs[0]).toBe(0x55);
    m.memory.writeByte(0x90FF, 0x07);
    expect(m.vic.regs[15]).toBe(0x07);
  });

  it('selects VIA 1 with A4 and VIA 2 with A5, both at $9130', () => {
    const m = machine(firmware());
    m.memory.writeByte(0x9112, 0x11);                 // VIA 1 DDRB
    m.memory.writeByte(0x9122, 0x22);                 // VIA 2 DDRB
    expect(m.via1.ddrb).toBe(0x11);
    expect(m.via2.ddrb).toBe(0x22);
    m.memory.writeByte(0x9133, 0x5A);                 // both DDRAs
    expect(m.via1.ddra).toBe(0x5A);
    expect(m.via2.ddra).toBe(0x5A);
    m.memory.writeByte(0x9103, 0xFF);                 // neither
    expect(m.via1.ddra).toBe(0x5A);
    expect(m.via2.ddra).toBe(0x5A);
    expect(m.memory.readByte(0x9112)).toBe(0x11);
    expect(m.memory.readByte(0x9222)).toBe(0x22);     // repeated at $9200
  });
});

// ── Keyboard ───────────────────────────────────────────────────────────────

/** Scan as the KERNAL does: drive column `col` low on $9120, read $9121. */
function scan(m: Vic20Machine, col: number): number {
  m.memory.writeByte(0x9122, 0xFF);                   // port B all outputs
  m.memory.writeByte(0x9123, 0x00);                   // port A all inputs
  m.memory.writeByte(0x9120, ~(1 << col) & 0xFF);
  return m.memory.readByte(0x9121);
}

const key = (k: string, code = '') => ({ key: k, code, shift: false, ctrl: false, alt: false, meta: false });

describe('VIC-20 keyboard', () => {
  // From the KERNAL's decode table: scan codes 0-7 are 1 3 5 7 9 + £ DEL,
  // 17 is A, 32 is SPACE, 63 is F7.
  it.each([
    ['1', '1', '', 0, 0],
    ['A', 'a', '', 2, 1],
    ['SPACE', ' ', 'Space', 4, 0],
    ['DEL', 'Backspace', 'Backspace', 0, 7],
    ['F7', 'F7', 'F7', 7, 7],
    ['Q', 'q', '', 6, 0],
  ])('%s sits where the KERNAL table puts it', (_name, k, code, col, row) => {
    const m = machine(firmware());
    m.services.input.keyDown(key(k, code));
    expect(scan(m, col)).toBe(~(1 << row) & 0xFF);
    // Any other column sees nothing.
    expect(scan(m, (col + 1) & 7)).toBe(0xFF);
    m.services.input.keyUp(key(k, code));
    expect(scan(m, col)).toBe(0xFF);
  });

  it('sees the joystick right switch as column 7 driven', () => {
    const m = machine(firmware());
    m.services.input.keyDown(key('2'));               // column 7, row 0
    m.memory.writeByte(0x9122, 0x7F);                 // PB7 input, the rest outputs
    m.memory.writeByte(0x9120, 0xFF);                 // no column driven
    expect(m.memory.readByte(0x9121)).toBe(0xFF);
    m.joystickPress('right', true);
    expect(m.memory.readByte(0x9121) & 1, 'the 2 key shows through PB7').toBe(0);
    expect(m.memory.readByte(0x9120) & 0x80, 'PB7 reads low').toBe(0);
  });

  it('reads the other joystick switches on VIA 1 port A, active low', () => {
    const m = machine(firmware());
    m.memory.writeByte(0x9113, 0x00);
    const pa = () => m.memory.readByte(0x9111);
    expect(pa() & 0x3C).toBe(0x3C);
    m.joystickPress('up', true);
    expect(pa() & 0x3C).toBe(0x38);
    m.joystickPress('fire', true);
    expect(pa() & 0x3C).toBe(0x18);
    m.releaseJoysticks();
    expect(pa() & 0x3C).toBe(0x3C);
  });
});

// ── Interrupts ─────────────────────────────────────────────────────────────

describe('VIC-20 interrupts', () => {
  it('takes VIA 2 timer 1 on IRQ', () => {
    const m = machine(firmware());
    for (let f = 0; f < 10; f++) m.tick();
    expect(m.memory.ram[0x04], 'the main loop runs').toBeGreaterThan(0);
    // Ten PAL frames are 221,520 cycles; at $4826 + 2 a period that is 11 jiffies.
    expect(m.memory.ram[0x03]).toBeGreaterThanOrEqual(10);
    expect(m.memory.ram[0x03]).toBeLessThanOrEqual(12);
    expect(m.memory.ram[0x05], 'no NMI without RESTORE').toBe(0);
  });

  it('takes RESTORE (VIA 1 CA1) on NMI, once per press', () => {
    const m = machine(firmware());
    m.tick();
    m.services.input.keyDown(key('PageUp', 'PageUp'));
    m.tick();
    m.tick();
    expect(m.memory.ram[0x05]).toBe(1);
    m.services.input.keyUp(key('PageUp', 'PageUp'));
    m.tick();
    expect(m.memory.ram[0x05], 'release is the other edge').toBe(1);
  });
});

// ── VIC ────────────────────────────────────────────────────────────────────

/** A VIC set up as the KERNAL leaves it, on a memory with a known screen. */
function vicWith(regs: Partial<Record<number, number>>, timing = VIC20_PAL_TIMING) {
  const mem = new Vic20Memory();
  const chargen = new Uint8Array(0x1000);
  // Character 1: every row $F0. Character 2: every row $1B.
  chargen.fill(0xF0, 8, 16);
  chargen.fill(0x1B, 16, 24);
  mem.loadRoms(null, null, chargen);
  mem.ram.fill(0x20, 0x1E00, 0x2000);       // screen of code $20 (a blank row in this chargen)
  mem.colorRam.fill(0, 0, 0x400);
  const vic = new Vic(mem, timing);
  const defaults: Record<number, number> = {
    0: timing.defaultHOrigin, 1: timing.defaultVOrigin, 2: 0x96, 3: 0x2E, 5: 0xF0, 15: 0x1B,
  };
  for (const [r, v] of Object.entries({ ...defaults, ...regs })) vic.regs[Number(r)] = v!;
  return { mem, vic };
}

/** The colour of VIC pixel (x, y) of the visible window. */
function pixelAt(vic: Vic, x: number, y: number): number {
  return vic.pixels[y * vic.width + x * 2];
}

describe('VIC (6561)', () => {
  const t = VIC20_PAL_TIMING;
  // The KERNAL's text area: 12 cycles (48 pixels) and 38 line pairs (line 76) in.
  const textX = t.defaultHOrigin * 4 - t.firstPixel;
  const textY = t.defaultVOrigin * 2 - t.firstLine;

  it('draws a hi-res character in its colour on the background, border round it', () => {
    const { mem, vic } = vicWith({});
    mem.ram[0x1E00] = 1;                    // top-left: character 1 (rows of $F0)
    mem.colorRam[0x200] = 2;                // red, hi-res ($9600: screen VA9 set)
    vic.beginFrame(0);
    vic.drawTo(t.cyclesPerFrame);
    const red = VIC20_PALETTE[2], white = VIC20_PALETTE[1], cyan = VIC20_PALETTE[3];
    expect(pixelAt(vic, textX, textY)).toBe(red);
    expect(pixelAt(vic, textX + 3, textY)).toBe(red);
    expect(pixelAt(vic, textX + 4, textY)).toBe(white);
    expect(pixelAt(vic, textX + 7, textY + 7)).toBe(white);
    expect(pixelAt(vic, textX - 1, textY), 'left of the text is border').toBe(cyan);
    expect(pixelAt(vic, textX, textY - 1), 'above the text is border').toBe(cyan);
    expect(pixelAt(vic, textX + 22 * 8, textY), 'right of 22 columns is border').toBe(cyan);
    expect(pixelAt(vic, textX, textY + 23 * 8), 'below 23 rows is border').toBe(cyan);
  });

  it('swaps character and background colour in reverse mode', () => {
    const { mem, vic } = vicWith({ 15: 0x13 });  // bit 3 clear: reverse
    mem.ram[0x1E00] = 1;
    mem.colorRam[0x200] = 2;
    vic.beginFrame(0);
    vic.drawTo(t.cyclesPerFrame);
    expect(pixelAt(vic, textX, textY)).toBe(VIC20_PALETTE[1]);
    expect(pixelAt(vic, textX + 4, textY)).toBe(VIC20_PALETTE[2]);
  });

  it('draws multicolour characters as double-width background, border, colour and auxiliary', () => {
    // Pattern $1B is pairs 00 01 10 11.
    const { mem, vic } = vicWith({ 14: 0x70, 15: 0x6B });  // aux yellow; bg blue, border cyan
    mem.ram[0x1E00] = 2;
    mem.colorRam[0x200] = 0x08 | 2;                         // multicolour, red
    vic.beginFrame(0);
    vic.drawTo(t.cyclesPerFrame);
    const expected = [6, 6, 3, 3, 2, 2, 7, 7].map(i => VIC20_PALETTE[i]);
    for (let x = 0; x < 8; x++) expect(pixelAt(vic, textX + x, textY), `pixel ${x}`).toBe(expected[x]);
  });

  it('follows a change of border colour from where the beam is', () => {
    const { vic } = vicWith({ 15: 0x1B });
    vic.beginFrame(0);
    // Change the border to black at the start of line 40.
    vic.write(15, 0x18, 40 * t.cyclesPerLine);
    vic.drawTo(t.cyclesPerFrame);
    expect(pixelAt(vic, 0, 39 - t.firstLine)).toBe(VIC20_PALETTE[3]);
    expect(pixelAt(vic, 0, 40 - t.firstLine)).toBe(VIC20_PALETTE[0]);
  });

  it('reports the raster line in $9004 (bits 8-1) and $9003 bit 7 (bit 0)', () => {
    const { vic } = vicWith({});
    vic.beginFrame(1000);
    const at = (line: number, cycle: number) => 1000 + line * t.cyclesPerLine + cycle;
    expect(vic.read(4, at(0, 0))).toBe(0);
    expect(vic.read(3, at(1, 5)) & 0x80).toBe(0x80);
    expect(vic.read(4, at(1, 5))).toBe(0);
    expect(vic.read(4, at(301, 70))).toBe(150);
    expect(vic.read(3, at(301, 70)) & 0x80).toBe(0x80);
    expect(vic.read(4, at(311, 0))).toBe(155);
    // The rows field reads back under the raster bit.
    expect(vic.read(3, at(0, 0)) & 0x7F).toBe(0x2E);
  });

  it('has 71 cycles × 312 lines on PAL and 65 × 261 on NTSC', () => {
    expect(VIC20_PAL_TIMING.cyclesPerFrame).toBe(22152);
    expect(VIC20_NTSC_TIMING.cyclesPerFrame).toBe(16965);
    expect(VIC20_PAL_TIMING.clockHz / VIC20_PAL_TIMING.cyclesPerFrame).toBeCloseTo(50.04, 2);
    expect(VIC20_NTSC_TIMING.clockHz / VIC20_NTSC_TIMING.cyclesPerFrame).toBeCloseTo(60.28, 2);
  });
});

// ── Registry and snapshots ─────────────────────────────────────────────────

describe('VIC-20 machine', () => {
  it('fetches the PAL KERNAL for PAL and the NTSC one for NTSC', () => {
    expect(vic20Entry.romSources('vic20', 'uk')).toContain('vic20/kernal-901486-07.rom');
    expect(vic20Entry.romSources('vic20', 'us')).toContain('vic20/kernal-901486-06.rom');
  });

  it('describes a frame buffer the machine renders into', () => {
    for (const ntsc of [false, true]) {
      const d = vic20Descriptor('vic20', ntsc ? 'us' : 'uk');
      const m = new Vic20Machine('vic20', null, ntsc);
      expect(m.frameWidth).toBe(d.screen.width);
      expect(m.frameHeight).toBe(d.screen.height);
      expect(m.pixels.length).toBe(d.screen.width * d.screen.height * 4);
      m.destroy();
    }
  });

  it('restores a snapshot exactly', async () => {
    const rom = firmware();
    const m = machine(rom);
    for (let f = 0; f < 5; f++) m.tick();
    await expectExactFromFile(m, machine(rom), '.vic20state', 8);
  });

  it('refuses a damaged snapshot and leaves the machine alone', async () => {
    const m = machine(firmware());
    for (let f = 0; f < 3; f++) m.tick();
    const file = await m.services.snapshots!.save('.vic20state');
    await expectRefusedUntouched(m, file, '.vic20state');
  });

  it('refuses a snapshot of the other TV standard or other expansion RAM', async () => {
    const rom = firmware();
    const pal = machine(rom);
    pal.tick();
    const file = await pal.services.snapshots!.save('.vic20state');
    const ntsc = machine(rom, true);
    expect((await ntsc.services.snapshots!.apply(file, 'x.vic20state')).ok).toBe(false);
    const expanded = machine(rom);
    expanded.setRamExpansion({ ...VIC20_NO_EXPANSION, blk1: true });
    expect((await expanded.services.snapshots!.apply(file, 'x.vic20state')).ok).toBe(false);
  });
});

// ── With the real ROMs ─────────────────────────────────────────────────────

const basic = romImage('basic-901486-01.rom');
const kernalPal = romImage('kernal-901486-07.rom');
const chargen = romImage('characters-901460-03.rom');

describe.skipIf(!basic || !kernalPal || !chargen)('VIC-20 with the Commodore ROMs', () => {
  it('boots to READY with 3583 bytes free', () => {
    const rom = new Uint8Array(0x5000);
    rom.set(basic!, 0);
    rom.set(kernalPal!, 0x2000);
    rom.set(chargen!, 0x4000);
    const m = machine(rom);
    for (let f = 0; f < 150; f++) m.tick();
    const text = m.ocrScreenForMcp();
    expect(text).toContain('**** CBM BASIC V2 ****');
    expect(text).toContain('3583 BYTES FREE');
    expect(text).toContain('READY.');
  });
});
