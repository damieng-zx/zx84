import { describe, it, expect, beforeEach } from 'vitest';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';

function machine(): EinsteinMachine {
  const m = new EinsteinMachine('einstein-tc01', null);
  m.turbo = true; // skip the audio path in headless runFrame
  return m;
}

describe('Einstein BASIC listing pane', () => {
  it('exposes the Xtal BASIC listing from RAM via the frame probe', () => {
    const m = machine();
    m.reset();
    // Write "10 PRINT F" as an Xtal BASIC record at the fixed program base
    // 0x3E01: [len=08][line=10][A2 20 46][00], then the 0x0000 end marker.
    const prog = [0x08, 0x00, 0x0A, 0x00, 0xA2, 0x20, 0x46, 0x00, 0x00, 0x00];
    prog.forEach((b, i) => m.memory.writeByte(0x3E01 + i, b));

    const listing = m.services.probe.panes?.basicListing?.();
    expect(listing).toEqual([{ lineNumber: 10, text: 'PRINT F' }]);
  });
});

describe('EinsteinMemory ROM overlay + toggle', () => {
  let m: EinsteinMachine;
  beforeEach(() => {
    m = machine();
    const rom = new Uint8Array(0x2000);
    rom[0x0000] = 0xAA;
    rom[0x1FFF] = 0xBB;
    m.loadROM(rom);
    m.reset();
  });

  it('overlays the MOS at the bottom, mirrored across 0x0000–0x3FFF', () => {
    expect(m.memory.readByte(0x0000)).toBe(0xAA);
    expect(m.memory.readByte(0x2000)).toBe(0xAA); // mirror
    expect(m.memory.readByte(0x1FFF)).toBe(0xBB);
    expect(m.memory.readByte(0x4000)).toBe(0xFF); // upper ROM window reads 0xFF
  });

  it('writes fall through to RAM even while the ROM is mapped', () => {
    m.memory.writeByte(0x0000, 0x55);
    expect(m.memory.readByte(0x0000)).toBe(0xAA);  // still ROM for reads
    expect(m.memory.ramSnapshot()[0]).toBe(0x55);  // but RAM took the write
  });

  it('port 0x24 toggles the ROM overlay in and out', () => {
    m.memory.writeByte(0x0000, 0x55);
    expect(m.memory.romPagedIn).toBe(true);
    m.cpu.portOut(0x24, 0x00);                     // any access toggles
    expect(m.memory.romPagedIn).toBe(false);
    expect(m.memory.readByte(0x0000)).toBe(0x55);  // now reads RAM
    m.cpu.portIn(0x24);                            // read toggles too
    expect(m.memory.romPagedIn).toBe(true);
  });
});

describe('Einstein I/O port decode', () => {
  let m: EinsteinMachine;
  beforeEach(() => { m = machine(); m.reset(); });

  it('routes VDP register and VRAM writes through ports 0x08/0x09', () => {
    // Control-port (0x09) two-byte register write: R1 = 0x50.
    m.cpu.portOut(0x09, 0x50);
    m.cpu.portOut(0x09, 0x80 | 1);
    expect(m.vdp.regs[1]).toBe(0x50);
    // VRAM write via 0x09 (address setup) + 0x08 (data).
    m.cpu.portOut(0x09, 0x00);
    m.cpu.portOut(0x09, 0x40); // write setup, address 0
    m.cpu.portOut(0x08, 0x99);
    expect(m.vdp.vram[0]).toBe(0x99);
  });

  it('scans the keyboard through the AY (port A select, port B read)', () => {
    m.keyboard.handleKeyEvent('KeyA', true); // A = matrix [6,6]
    // Select AY register 14 (port A) and drive row 6 low (active-low select).
    m.cpu.portOut(0x02, 14);
    m.cpu.portOut(0x03, 0xFF & ~(1 << 6));
    // Select AY register 15 (port B) and read the columns.
    m.cpu.portOut(0x02, 15);
    const cols = m.cpu.portIn(0x02);
    expect(cols).toBe(0xFF & ~(1 << 6)); // column 6 pulled low by the key
  });
});

describe('Einstein CTC→IM2 interrupt path', () => {
  it('services a CTC timer interrupt through the ISR during a frame', () => {
    const m = machine();
    const rom = new Uint8Array(0x2000);
    // Boot: IM 2; I := 0; EI; then loop forever with interrupts enabled.
    let p = 0;
    rom[p++] = 0xED; rom[p++] = 0x5E;       // IM 2
    rom[p++] = 0x3E; rom[p++] = 0x00;       // LD A,0
    rom[p++] = 0xED; rom[p++] = 0x47;       // LD I,A
    rom[p++] = 0xFB;                        // EI
    rom[p++] = 0x18; rom[p++] = 0xFE;       // JR $  (loop at 0x0007)
    // IM 2 vector table entry for CTC channel 0 (vector base 0x40 → 0x0040):
    rom[0x0040] = 0x00; rom[0x0041] = 0x01; // ISR at 0x0100
    // ISR: write a sentinel to RAM 0x8000, then EI + RETI.
    let q = 0x0100;
    rom[q++] = 0x3E; rom[q++] = 0xEE;       // LD A,0xEE
    rom[q++] = 0x32; rom[q++] = 0x00; rom[q++] = 0x80; // LD (0x8000),A
    rom[q++] = 0xFB;                        // EI
    rom[q++] = 0xED; rom[q++] = 0x4D;       // RETI
    m.loadROM(rom);
    m.reset();

    // Program CTC channel 0 as a timer with interrupts enabled: vector base
    // 0x40, timer mode, /16 prescaler, time constant 255. The Einstein clocks
    // the CTC at 2MHz (inputClockDivide 2), so this underflows every 16×255×2 =
    // 8160 T-states — several times within a PAL field (80000 T) as addCycles runs.
    m.cpu.portOut(0x28, 0x40);              // vector base (bit0 = 0)
    m.cpu.portOut(0x28, 0x01 | 0x80 | 0x04); // control: timer+int+/16+TCfollows
    m.cpu.portOut(0x28, 0xFF);              // time constant = 255

    expect(m.memory.ramSnapshot()[0x8000]).toBe(0x00); // sentinel not yet written
    m.tick();                               // run one PAL field
    expect(m.memory.ramSnapshot()[0x8000]).toBe(0xEE); // ISR ran via IM 2
  });
});

describe('Einstein runFrame smoke', () => {
  it('renders a frame without throwing and fills the backdrop', () => {
    const m = machine();
    const rom = new Uint8Array(0x2000);
    rom[0] = 0xF3; rom[1] = 0x76; // DI ; HALT
    m.loadROM(rom);
    m.reset();
    m.tick();
    // Backdrop is colour 0 (R7 low nibble) = black; the buffer is non-empty.
    expect(m.pixels.length).toBe(320 * 240 * 4);
    expect(m.pixels[3]).toBe(0xFF); // alpha of the first pixel
  });
});
