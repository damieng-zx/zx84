/**
 * CPC raster/interrupt timing through the real frame loop.
 *
 * Expectations (cpctech "Interrupts on the CPC", 6845 datasheet, MAME amstrad):
 *   - VSYNC rises at the start of the scanline where VCC = R7, RA = 0.
 *   - The Gate Array counts the falling edge of the CRTC's HSYNC, which ends
 *     R2 + (R3 & 15) characters into the line (4 T-states per character).
 *   - The interrupt counter re-syncs on the 2nd HSYNC after VSYNC starts; the
 *     VSYNC onset line's own HSYNC is the 1st.
 * The CPU runs NOPs (4 T each, an empty lower ROM) with interrupts disabled,
 * so HSYNC T-state positions land exactly.
 */

import { describe, it, expect } from 'vitest';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

function programStandard(m: CpcMachine): void {
  const regs: [number, number][] = [
    [0, 63], [1, 40], [2, 46], [3, 0x8E], [4, 38], [5, 0], [6, 25], [7, 30], [9, 7],
  ];
  for (const [r, v] of regs) { m.crtc.selectRegister(r); m.crtc.writeRegister(v); }
}

interface HsyncEvent { t: number; vsync: boolean }

function instrument(m: CpcMachine): { hsyncs: HsyncEvent[]; resyncAt: number[] } {
  const hsyncs: HsyncEvent[] = [];
  const resyncAt: number[] = [];
  const ga = m.gateArray;
  const onHSync = ga.onHSync.bind(ga);
  const onResync = ga.onVSyncResync.bind(ga);
  ga.onHSync = () => { hsyncs.push({ t: m.cpu.tStates, vsync: m.crtc.vsyncActive }); onHSync(); };
  ga.onVSyncResync = () => { resyncAt.push(hsyncs.length - 1); onResync(); };
  return { hsyncs, resyncAt };
}

describe('CPC raster timing', () => {
  it('clocks the Gate Array at the HSYNC trailing edge (char 60), not at end of line', () => {
    const m = new CpcMachine('cpc6128', null);
    programStandard(m);
    const { hsyncs } = instrument(m);
    const t0 = m.cpu.tStates;
    m.tick();
    expect(hsyncs.length).toBe(312);
    expect(hsyncs[0].t - t0).toBe(60 * 4);             // (46 + 14) chars × 4 T
    expect(hsyncs[1].t - t0).toBe(64 * 4 + 60 * 4);    // one line later
  });

  it('reports VSYNC during the HSYNC of the R7 onset scanline (line 240)', () => {
    const m = new CpcMachine('cpc6128', null);
    programStandard(m);
    const { hsyncs } = instrument(m);
    m.tick();
    const first = hsyncs.findIndex((h) => h.vsync);
    expect(first).toBe(240);                            // row 30 × 8 rasters
  });

  it('re-syncs the interrupt counter on the 2nd HSYNC after VSYNC onset', () => {
    const m = new CpcMachine('cpc6128', null);
    programStandard(m);
    const { resyncAt } = instrument(m);
    m.tick();
    expect(resyncAt).toEqual([241]);                    // HSYNCs of lines 240, 241
    expect(m.gateArray.rasterCount).toBe((312 - 242) - 52); // 70 HSYNCs since, one 52-wrap
  });
});
