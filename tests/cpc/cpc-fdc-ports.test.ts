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
