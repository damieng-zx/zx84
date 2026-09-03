/**
 * SamAsic interrupts — the frame and line sources, and the active-low STATUS
 * register on port 0xF9.
 *
 * The SAM asserts /INT for a fixed period and then drops it; there is no CPU
 * acknowledge and reading STATUS does not clear anything. Two consequences are
 * asserted below because software depends on both: an interrupt masked behind a
 * DI for the whole window is lost outright, and a handler that re-enables
 * interrupts inside the window is re-entered.
 *
 * Line numbering: the LINE register is treated as a display line (0..191), so
 * the interrupt fires at the start of raster line 48 + LINE. This matches how
 * the SAM's own ROM drives it — its boot screen programs LINE = 11, 22, 33 …
 * 165 and repaints CLUT entry 0 in each handler, and the resulting bands land
 * on exactly those display lines.
 */

import { describe, expect, it } from 'vitest';
import { SamAsic } from '@/machines/sam/asic.ts';
import { SamMemory } from '@/machines/sam/sam-memory.ts';
import { createSamConfig } from '@/machines/sam/config.ts';
import {
  SAM_DISPLAY_FIRST_LINE, SAM_FRAME_INT_LINE, SAM_INT_ACTIVE_T,
  SAM_LINES_PER_FRAME, SAM_T_PER_LINE,
  STATUS_IDLE, STATUS_INT_FRAME, STATUS_INT_LINE,
} from '@/machines/sam/constants.ts';

function asic(): SamAsic {
  return new SamAsic(new SamMemory(createSamConfig('sam512')));
}

/** Run a whole field's worth of line boundaries, calling `onLine` after each.
 *  Returns the raster lines on which /INT went from released to asserted. */
function runField(a: SamAsic, onLine?: (line: number, t: number) => void): number[] {
  const raised: number[] = [];
  let was = a.intPending;
  for (let line = 0; line < SAM_LINES_PER_FRAME; line++) {
    const t = (line + 1) * SAM_T_PER_LINE;
    a.releaseExpired(t);
    a.endLine(line, t);
    if (a.intPending && !was) raised.push(line + 1);
    was = a.intPending;
    onLine?.(line, t);
  }
  return raised;
}

describe('SamAsic STATUS register', () => {
  it('is active low: every bit reads high when nothing is pending', () => {
    const a = asic();
    expect(a.status).toBe(STATUS_IDLE);
    expect(a.status & 0x1F).toBe(0x1F);
    expect(a.intPending).toBe(false);
  });

  it('clears the frame bit while the frame interrupt is asserted', () => {
    const a = asic();
    a.endLine(SAM_FRAME_INT_LINE - 1, 1000);
    expect(a.status & STATUS_INT_FRAME).toBe(0);
    expect(a.intPending).toBe(true);
  });

  it('leaves the line bit alone when only the frame interrupt fires', () => {
    const a = asic();
    a.endLine(SAM_FRAME_INT_LINE - 1, 1000);
    expect(a.status & STATUS_INT_LINE).toBe(STATUS_INT_LINE);
  });
});

describe('SamAsic frame interrupt', () => {
  it('fires at the start of the first line after the display', () => {
    // The display occupies raster lines 48..239, so /INT goes low at line 240.
    const a = asic();
    expect(runField(a)).toEqual([SAM_FRAME_INT_LINE]);
  });

  it('fires exactly once per field', () => {
    const a = asic();
    for (let field = 0; field < 3; field++) {
      expect(runField(a)).toHaveLength(1);
    }
  });

  it('is released after its hold time even if the CPU never looked', () => {
    const a = asic();
    const t = 10_000;
    a.endLine(SAM_FRAME_INT_LINE - 1, t);
    expect(a.intPending).toBe(true);

    a.releaseExpired(t + SAM_INT_ACTIVE_T - 1);
    expect(a.intPending).toBe(true);          // still asserted

    a.releaseExpired(t + SAM_INT_ACTIVE_T);
    expect(a.intPending).toBe(false);         // dropped on the timer
    expect(a.status).toBe(STATUS_IDLE);
  });
});

describe('SamAsic line interrupt', () => {
  it('does not fire until the LINE register has been programmed', () => {
    const a = asic();
    expect(a.lineReg).toBe(-1);
    expect(runField(a)).toEqual([SAM_FRAME_INT_LINE]);   // frame only
  });

  it('fires at the start of raster line 48 + LINE', () => {
    const a = asic();
    a.setLineInterrupt(11);
    expect(runField(a)).toEqual([SAM_DISPLAY_FIRST_LINE + 11, SAM_FRAME_INT_LINE]);
  });

  it('fires on display line 0, at the very top of the picture', () => {
    const a = asic();
    a.setLineInterrupt(0);
    expect(runField(a)).toEqual([SAM_DISPLAY_FIRST_LINE, SAM_FRAME_INT_LINE]);
  });

  it('fires on the line before the one the handler would see as current', () => {
    // "Start of line L" means the boundary at the end of line L-1.
    const a = asic();
    a.setLineInterrupt(100);
    const target = SAM_DISPLAY_FIRST_LINE + 100;

    a.endLine(target - 2, 1000);
    expect(a.status & STATUS_INT_LINE).toBe(STATUS_INT_LINE);   // not yet
    a.endLine(target - 1, 2000);
    expect(a.status & STATUS_INT_LINE).toBe(0);                 // now
  });

  it('clears a pending line interrupt when LINE is rewritten', () => {
    // The write doubles as an acknowledge on real hardware — which is what
    // lets a chained raster handler re-arm without re-triggering itself.
    const a = asic();
    a.setLineInterrupt(11);
    a.endLine(SAM_DISPLAY_FIRST_LINE + 10, 1000);
    expect(a.status & STATUS_INT_LINE).toBe(0);

    a.setLineInterrupt(22);
    expect(a.status & STATUS_INT_LINE).toBe(STATUS_INT_LINE);
    expect(a.intPending).toBe(false);
  });

  it('supports a chained raster effect: re-arming inside the handler', () => {
    // A faithful model of what the SAM ROM's boot screen does: each line
    // handler programs the next boundary 11 display lines further down, parks
    // the register at 255 after the last band, and the FRAME handler re-arms
    // it at 0 for the next field.
    const a = asic();
    a.setLineInterrupt(11);
    const fired: number[] = [];
    let next = 11;

    runField(a, (line) => {
      if (line + 1 === SAM_FRAME_INT_LINE) {
        a.setLineInterrupt(0);        // frame handler re-arms for the next field
        next = 0;
        return;
      }
      if ((a.status & STATUS_INT_LINE) === 0) {
        fired.push(line + 1 - SAM_DISPLAY_FIRST_LINE);
        next += 11;
        a.setLineInterrupt(next <= 165 ? next : 255);
      }
    });

    expect(fired).toEqual([11, 22, 33, 44, 55, 66, 77, 88, 99, 110, 121, 132, 143, 154, 165]);
  });

  it('parks harmlessly when LINE is set past the bottom of the field', () => {
    // The ROM writes LINE = 255 to mean "no more this frame". 48 + 255 = 303,
    // which is inside the 312-line field but after the frame interrupt, so the
    // frame handler re-arms LINE before it can ever match.
    const a = asic();
    a.setLineInterrupt(255);
    const raised = runField(a, (line) => {
      if (line + 1 === SAM_FRAME_INT_LINE) a.setLineInterrupt(0);
    });
    expect(raised).toEqual([SAM_FRAME_INT_LINE]);
  });

  it('holds frame and line assertions on independent timers', () => {
    const a = asic();
    a.setLineInterrupt(0);
    a.endLine(SAM_DISPLAY_FIRST_LINE - 1, 1000);        // line interrupt
    a.endLine(SAM_FRAME_INT_LINE - 1, 1000 + SAM_INT_ACTIVE_T / 2);   // frame

    // The line assertion expires first; the frame one is still live.
    a.releaseExpired(1000 + SAM_INT_ACTIVE_T);
    expect(a.status & STATUS_INT_LINE).toBe(STATUS_INT_LINE);
    expect(a.status & STATUS_INT_FRAME).toBe(0);
    expect(a.intPending).toBe(true);

    a.releaseExpired(1000 + SAM_INT_ACTIVE_T * 2);
    expect(a.intPending).toBe(false);
  });
});

describe('SamAsic reset', () => {
  it('clears every interrupt source and disarms the line register', () => {
    const a = asic();
    a.setLineInterrupt(50);
    a.endLine(SAM_FRAME_INT_LINE - 1, 1000);
    expect(a.intPending).toBe(true);

    a.reset();
    expect(a.status).toBe(STATUS_IDLE);
    expect(a.intPending).toBe(false);
    expect(a.lineReg).toBe(-1);
    // A reset assertion must not come back to life on the next release check.
    a.releaseExpired(1_000_000);
    expect(a.status).toBe(STATUS_IDLE);
  });
});
