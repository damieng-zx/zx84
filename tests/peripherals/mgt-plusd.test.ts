import { describe, it, expect } from 'vitest';
import { MgtPlusD } from '@/machines/spectrum/peripherals/mgt-plusd.ts';
import type { SpectrumMemory } from '@/machines/spectrum/memory.ts';

const mem = {} as SpectrumMemory;

describe('MgtPlusD printer (ports 0xF7 data/busy, 0xEF b6 strobe)', () => {
  it('reads BUSY (bit 7) clear: the virtual printer is always ready', () => {
    // G+DOS polls IN 0xF7 bit 7 until the printer is ready; a permanently set
    // bit stalls every LPRINT/COPY.
    const d = new MgtPlusD();
    expect(d.readPort(0xF7, mem) & 0x80).toBe(0);
  });

  it('latches data on OUT 0xF7 and delivers it on the STROBE rising edge', () => {
    const d = new MgtPlusD();
    d.writePort(0xF7, 0x41, mem);
    expect(d.printed).toEqual([]);           // latched only, not yet strobed
    d.writePort(0xEF, 0x40, mem);            // STROBE high
    expect(d.printed).toEqual([0x41]);
    d.writePort(0xEF, 0x00, mem);            // STROBE low: nothing sent
    expect(d.printed).toEqual([0x41]);
  });

  it('holding STROBE high does not repeat the byte; the next edge sends the new one', () => {
    const d = new MgtPlusD();
    d.writePort(0xF7, 0x0D, mem);
    d.writePort(0xEF, 0x40, mem);
    d.writePort(0xEF, 0x41, mem);            // still high, drive bit changes
    expect(d.printed).toEqual([0x0D]);
    d.writePort(0xEF, 0x00, mem);
    d.writePort(0xF7, 0x0A, mem);
    d.writePort(0xEF, 0x40, mem);
    expect(d.printed).toEqual([0x0D, 0x0A]);
  });

  it('strobe bit does not disturb drive or side selection', () => {
    const d = new MgtPlusD();
    d.writePort(0xEF, 0x40 | 0x80 | 0x02, mem); // drive 2, side 1, strobe
    expect(d.fdc.currentDrive).toBe(1);
    expect(d.fdc.side).toBe(1);
  });
});
