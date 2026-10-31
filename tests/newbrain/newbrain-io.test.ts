import { describe, it, expect } from 'vitest';
import { NewBrainMachine } from '@/machines/newbrain/newbrain-machine.ts';
import { NB_COP_ROM_SIZE, NB_CHAR_ROM_SIZE, NB_ROM_SIZE } from '@/machines/newbrain/constants.ts';

/** A machine with an empty (all-zero) ROM set: enough to exercise the board's
 *  registers without running any firmware. */
function bare(): NewBrainMachine {
  const m = new NewBrainMachine('newbrain', null);
  m.loadROM(new Uint8Array(NB_ROM_SIZE + NB_COP_ROM_SIZE + NB_CHAR_ROM_SIZE));
  m.reset();
  return m;
}

const out = (m: NewBrainMachine, port: number, v: number) => m.cpu.portOut(port, v);
const inp = (m: NewBrainMachine, port: number) => m.cpu.portIn(port);
const irq = (m: NewBrainMachine) => (m as unknown as { irqAsserted(): boolean }).irqAsserted();

describe('NewBrain status register (port 0x14)', () => {
  it('reads the interrupt lines active low, with the unused bits high', () => {
    const m = bare();
    m.board.g = 0;           // no COP request
    m.clkPending = false;
    // Bits 2, 3, 4 and 6 are tied high; 5 (clock) and 7 (COP) are high when idle.
    expect(inp(m, 0x14) & 0xFC).toBe(0xFC);
    m.clkPending = true;
    expect(inp(m, 0x14) & 0x20).toBe(0);
    m.board.g = 1;           // the COP asks for service
    expect(inp(m, 0x14) & 0x80).toBe(0);
  });

  it('selects the tape input or a constant onto bit 0 from enable-register bits 7-6', () => {
    const m = bare();
    m.board.tapeIn = 0;
    out(m, 0x07, 0x80);      // 10: tape input
    expect(inp(m, 0x14) & 1).toBe(0);
    m.board.tapeIn = 1;
    expect(inp(m, 0x14) & 1).toBe(1);
    m.board.tapeIn = 0;
    for (const sel of [0x00, 0x40, 0xC0]) {
      out(m, 0x07, sel);
      expect(inp(m, 0x14) & 1, `selection ${sel.toString(16)}`).toBe(1);
    }
  });

  it('reports the power-up flag on enable-register selection 00 until the timer expires', () => {
    const m = bare();
    out(m, 0x07, 0x00);
    expect(inp(m, 0x14) & 2).toBe(2);       // still powering up
    m.memory.poweredUp = true;
    expect(inp(m, 0x14) & 2).toBe(0);
    out(m, 0x07, 0x10);                     // 01 reads clear
    expect(inp(m, 0x14) & 2).toBe(0);
    out(m, 0x07, 0x20);                     // 10 and 11 read set
    expect(inp(m, 0x14) & 2).toBe(2);
    out(m, 0x07, 0x30);
    expect(inp(m, 0x14) & 2).toBe(2);
  });

  it('shows the tape input on bit 5 of port B (0x16) whatever the enable register says', () => {
    const m = bare();
    m.board.tapeIn = 1;
    expect(inp(m, 0x16) & 0x20).toBe(0x20);
    m.board.tapeIn = 0;
    expect(inp(m, 0x16) & 0x20).toBe(0);
  });

  it('repeats every register across the undecoded address lines', () => {
    const m = bare();
    m.board.g = 0;
    // Only A2-A4 and A0-A1 are decoded: 0x14 is also 0x54, 0xB4, and so on.
    expect(inp(m, 0x54)).toBe(inp(m, 0x14));
    expect(inp(m, 0x15)).toBe(inp(m, 0x14));
    expect(inp(m, 0x17)).toBe(inp(m, 0x16));
  });
});

describe('NewBrain video registers', () => {
  it('loads A7-A14 from port 9 and sets A6 from port 8', () => {
    const m = bare();
    out(m, 0x09, 0x05);
    expect(m.tvl).toBe(0x05 << 7);
    out(m, 0x08, 0x05);
    expect(m.tvl).toBe((0x05 << 7) | 0x40);
    out(m, 0x09, 0x05);                      // a fresh port-9 write drops A6 again
    expect(m.tvl).toBe(0x05 << 7);
    out(m, 0x0B, 0x7F);                      // ports 10 and 11 appear as 8 and 9
    expect(m.tvl).toBe(0x7F << 7);
    out(m, 0x0A, 0x7F);
    expect(m.tvl).toBe((0x7F << 7) | 0x40);
  });

  it('latches the control register from ports 12-15', () => {
    const m = bare();
    out(m, 0x0C, 0x4B);
    expect(m.tvctl).toBe(0x4B);
    out(m, 0x0F, 0x02);
    expect(m.tvctl).toBe(0x02);
  });
});

describe('NewBrain interrupt line', () => {
  it('lets the 50 Hz clock through only while enable-register bit 0 is clear, until port 4 is touched', () => {
    const m = bare();
    m.clkPending = true;
    out(m, 0x07, 0x01);
    expect(irq(m)).toBe(false);
    out(m, 0x07, 0x00);
    expect(irq(m)).toBe(true);
    inp(m, 0x04);                            // a read acknowledges it
    expect(m.clkPending).toBe(false);
    m.clkPending = true;
    out(m, 0x04, 0);                         // so does a write
    expect(m.clkPending).toBe(false);
  });

  it('asserts the line while the COP holds G0 high, whatever the clock gate says', () => {
    const m = bare();
    m.clkPending = false;
    out(m, 0x07, 0x01);
    m.board.g = 1;
    expect(irq(m)).toBe(true);
  });
});
