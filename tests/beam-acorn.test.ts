/**
 * The beam on the BBC Micro and the Electron agrees with where their video
 * hardware puts its line events, and a frame stopped part-way through a line
 * carries on without repeating the work done at that line's start.
 *
 * BBC: the MOS Mode 0 CRTC settings (R4=38, R7=34, R9=7: 8-line rows) start
 * VSYNC on the first line of row 34, line 272, which is the System VIA CA1
 * falling edge. Electron: the ULA raises its RTC interrupt at the start of
 * line 100 (the machine's line events, see `ElectronMachine`).
 *
 * No ROM is loaded: the CPU runs BRKs through a zero vector with I set, so
 * nothing acknowledges an interrupt but the test.
 */

import { describe, it, expect } from 'vitest';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';
import { INT_RTC } from '@/machines/electron/electron-ula.ts';

const VIA_IFR_CA1 = 0x02;

/** Run to the first instruction boundary at or after `t` in `frame`. */
function runToBeam(m: BbcMachine | ElectronMachine, frame: number, t: number): number {
  m.beamTarget = { frame, t };
  m.runUntil(frame + 2);
  expect(m.stopReason?.kind).toBe('beam');
  const at = m.beam();
  expect(at.frame).toBe(frame);
  return at.t;
}

describe('BBC Micro beam geometry', () => {
  function bootMode0(): BbcMachine {
    const m = new BbcMachine('bbc-b', null);
    m.reset();
    // MOS Mode 0 CRTC registers (R8 = 0: no interlace).
    const regs = [127, 80, 98, 0x28, 38, 0, 32, 34, 0, 7];
    regs.forEach((v, r) => { m.crtc.selectRegister(r); m.crtc.writeRegister(v); });
    return m;
  }

  it('VSYNC reaches the System VIA on line 272, not before', () => {
    const m = bootMode0();
    try {
      const cpl = m.beamInfo().cyclesPerLine;
      // Last few cycles of line 271 of frame 1: the edge of frame 0 is cleared.
      const before = runToBeam(m, 1, Math.ceil(272 * cpl) - 8);
      expect(Math.floor(before / cpl)).toBe(271);
      m.sysVia.write(13, VIA_IFR_CA1);
      expect(m.sysVia.ifr & VIA_IFR_CA1).toBe(0);
      const at = runToBeam(m, 1, Math.ceil(272 * cpl));
      expect(Math.floor(at / cpl)).toBe(272);
      expect(m.sysVia.ifr & VIA_IFR_CA1).toBe(VIA_IFR_CA1);
    } finally { m.destroy(); }
  });
});

describe('Electron beam geometry', () => {
  function boot(): ElectronMachine {
    const m = new ElectronMachine('electron', null);
    m.reset();
    return m;
  }

  it('the RTC interrupt is raised at the start of line 100', () => {
    const m = boot();
    try {
      runToBeam(m, 1, 99 * 128);
      m.ula.write(5, 0x20);                       // clear the RTC flag from frame 0
      expect(m.ula.intStatus & INT_RTC).toBe(0);
      const at = runToBeam(m, 1, 100 * 128);
      expect(Math.floor(at / 128)).toBe(100);
      expect(m.ula.intStatus & INT_RTC).toBe(INT_RTC);
    } finally { m.destroy(); }
  });

  it('a stop inside line 100 does not raise the RTC interrupt again on resume', () => {
    const m = boot();
    try {
      runToBeam(m, 1, 100 * 128 + 40);
      m.ula.write(5, 0x20);                       // the program acknowledges it
      runToBeam(m, 1, 200 * 128);
      expect(m.ula.intStatus & INT_RTC).toBe(0);
      // The next frame's line 100 raises it again.
      runToBeam(m, 2, 101 * 128);
      expect(m.ula.intStatus & INT_RTC).toBe(INT_RTC);
    } finally { m.destroy(); }
  });
});
