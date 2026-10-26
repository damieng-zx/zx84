/**
 * Unconnected drive select lines on the Intel 8271.
 *
 * READ DRIVE STATUS returns the selected drive's READY (bit 2 for drive 0,
 * bit 6 for drive 1) and TRACK 0 (bit 1) inputs. With nothing on a select line
 * neither input is driven, so the result has both clear: this is how the
 * Acorn DFS finds out it has one drive rather than two.
 */

import { describe, it, expect } from 'vitest';
import { I8271 } from '@/cores/i8271.ts';

const READY0 = 0x04;
const READY1 = 0x40;
const TRACK0 = 0x02;

function driveStatus(fdc: I8271, unit: 0 | 1): number {
  fdc.write(0, unit === 0 ? 0x6c : 0xac);
  return fdc.read(1);
}

describe('I8271 connected drive lines', () => {
  it('reports drive 1 ready and at track 0 when it is connected', () => {
    const fdc = new I8271({});
    const status = driveStatus(fdc, 1);
    expect(status & READY1).toBe(READY1);
    expect(status & TRACK0).toBe(TRACK0);
  });

  it('reports an unconnected drive 1 neither ready nor at track 0', () => {
    const fdc = new I8271({});
    fdc.connected[1] = false;
    const status = driveStatus(fdc, 1);
    expect(status & READY1).toBe(0);
    expect(status & TRACK0).toBe(0);
    expect(status & 0x80).toBe(0x80);     // bit 7 is always set
  });

  it('leaves drive 0 unaffected when only drive 1 is removed', () => {
    const fdc = new I8271({});
    fdc.connected[1] = false;
    const status = driveStatus(fdc, 0);
    expect(status & READY0).toBe(READY0);
    expect(status & TRACK0).toBe(TRACK0);
  });
});
