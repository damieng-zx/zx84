/**
 * CPC uPD765A port decode (cpcwiki "I/O Port Summary"):
 *   &FA7E  motor control   A10=0, A8=0, A7=0          (write)
 *   &FB7E  main status     A10=0, A8=1, A7=0, A0=0    (read only)
 *   &FB7F  data register   A10=0, A8=1, A7=0, A0=1    (read/write)
 * The 464 and GX4000 have no FDC (a DDI-1 is not modelled): reads float to
 * 0xFF and writes do nothing.
 */

import { describe, it, expect } from 'vitest';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

describe('CPC FDC ports without a disk interface', () => {
  for (const model of ['cpc464', 'gx4000'] as const) {
    it(`${model}: FDC reads float to 0xFF`, () => {
      const m = new CpcMachine(model, null);
      expect(m.cpu.portIn(0xFB7E)).toBe(0xFF);  // a 765 would report RQM (0x80)
      expect(m.cpu.portIn(0xFB7F)).toBe(0xFF);
    });

    it(`${model}: FDC writes do nothing`, () => {
      const m = new CpcMachine(model, null);
      let dataWrites = 0;
      m.fdc.writeData = () => { dataWrites++; };
      m.cpu.portOut(0xFA7E, 0x01);
      expect(m.fdc.motorOn).toBe(false);
      m.cpu.portOut(0xFB7F, 0x08);
      expect(dataWrites).toBe(0);
    });
  }

  it('cpc6128: the FDC answers on its ports', () => {
    const m = new CpcMachine('cpc6128', null);
    expect(m.cpu.portIn(0xFB7E) & 0x80).toBe(0x80);  // RQM set when idle
    m.cpu.portOut(0xFA7E, 0x01);
    expect(m.fdc.motorOn).toBe(true);
  });
});

describe('CPC FDC address decode (A7 must be 0)', () => {
  it('OUT &F8FF (peripheral reset, A7=1) does not touch the drive motor', () => {
    const m = new CpcMachine('cpc6128', null);
    m.cpu.portOut(0xFA7E, 0x01);
    expect(m.fdc.motorOn).toBe(true);
    m.cpu.portOut(0xF8FF, 0x00);             // A10=0, A8=0 but A7=1
    expect(m.fdc.motorOn).toBe(true);
  });

  it('a write to &FB7E (read-only status) is not fed to the data register', () => {
    const m = new CpcMachine('cpc6128', null);
    let dataWrites = 0;
    m.fdc.writeData = () => { dataWrites++; };
    m.cpu.portOut(0xFB7E, 0x08);
    expect(dataWrites).toBe(0);
    m.cpu.portOut(0xFB7F, 0x08);             // the data port still works
    expect(dataWrites).toBe(1);
  });

  it('reads with A7=1 do not reach the FDC', () => {
    const m = new CpcMachine('cpc6128', null);
    let dataReads = 0;
    m.fdc.readData = () => { dataReads++; return 0x00; };
    m.cpu.portIn(0xFBFF);                    // A10=0, A8=1, A0=1 but A7=1
    expect(dataReads).toBe(0);
    m.cpu.portIn(0xFB7F);
    expect(dataReads).toBe(1);
  });
});
