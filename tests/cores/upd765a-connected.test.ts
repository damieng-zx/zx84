/**
 * uPD765A drive-connected line.
 *
 * A select line with no mechanism on it cannot report track 0, so RECALIBRATE
 * and SEEK end with an equipment check (ST0 IC=01 with EC set) instead of
 * succeeding. Both lines are connected by default, so machines that present two
 * drives — the +3, the CPC — are unaffected.
 */

import { describe, expect, it } from 'vitest';
import { UPD765A } from '@/cores/upd765a.ts';

const ST0_SEEK_END = 0x20;
const ST0_ABNORMAL = 0x40;
const ST0_EQUIP_CHECK = 0x10;

/** Recalibrate `unit`, then collect the two Sense Interrupt result bytes. */
function recalibrate(fdc: UPD765A, unit: number): number[] {
  fdc.writeData(0x07);
  fdc.writeData(unit);
  fdc.writeData(0x08);                     // SENSE INTERRUPT STATUS
  return [fdc.readData(), fdc.readData()]; // ST0, PCN
}

describe('uPD765A drive presence', () => {
  it('recalibrates both units by default', () => {
    const fdc = new UPD765A();
    for (const unit of [0, 1]) {
      const [st0] = recalibrate(fdc, unit);
      expect(st0).toBe(ST0_SEEK_END | unit);
    }
  });

  it('fails recalibrate with an equipment check on a disconnected unit', () => {
    const fdc = new UPD765A();
    fdc.connected[1] = false;
    const [st0, pcn] = recalibrate(fdc, 1);
    expect(st0 & 0xC0).toBe(ST0_ABNORMAL);           // IC = abnormal
    expect(st0 & ST0_EQUIP_CHECK).toBe(ST0_EQUIP_CHECK);
    expect(st0 & ST0_SEEK_END).toBe(ST0_SEEK_END);   // the step still ends
    expect(pcn).toBe(0);
    // Unit 0 is unaffected.
    expect(recalibrate(fdc, 0)[0]).toBe(ST0_SEEK_END);
  });

  it('fails a seek on a disconnected unit and does not move its head', () => {
    const fdc = new UPD765A();
    fdc.connected[1] = false;
    fdc.setTrack(1, 5);
    fdc.writeData(0x0F);
    fdc.writeData(0x01);
    fdc.writeData(30);
    fdc.writeData(0x08);
    const st0 = fdc.readData();
    const pcn = fdc.readData();
    expect(st0 & ST0_EQUIP_CHECK).toBe(ST0_EQUIP_CHECK);
    expect(pcn).toBe(5);                             // still where it was
    expect(fdc.getUnitTrack(1)).toBe(5);
  });

  it('reports a disconnected drive as neither ready nor two-sided', () => {
    const fdc = new UPD765A();
    fdc.connected[1] = false;
    fdc.forceReady[1] = true;                        // must not override absence
    fdc.writeData(0x04);                             // SENSE DRIVE STATUS
    fdc.writeData(0x01);
    const st3 = fdc.readData();
    expect(st3 & 0x20).toBe(0);                      // not ready
    expect(st3 & 0x08).toBe(0);                      // not two-sided
  });
});
