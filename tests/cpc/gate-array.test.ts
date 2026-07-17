/**
 * Gate Array raster interrupt + screen-address generation.
 *
 * CPC hardware facts (not the implementation) drive these expectations:
 *   - The GA raises the Z80 INT every 52 HSYNCs.
 *   - At VSYNC it re-syncs: if ≥32 HSYNCs have elapsed since the last INT it
 *     fires an extra INT, then resets the counter to 0.
 *   - Servicing the INT clears bit 5 of the 6-bit counter (count &= 0x1F) — this
 *     is what makes hardware raster splits land on a stable line.
 *   - RMR bit 4 clears the counter and any pending INT.
 *   - Display bytes are fetched through the CPC address scramble
 *       addr = ((MA & 0x3000) << 2) | ((RA & 7) << 11) | ((MA & 0x3FF) << 1)
 *     so the standard screen base MA=0x3000 maps to byte 0xC000.
 */

import { describe, it, expect } from 'vitest';
import { GateArray } from '@/machines/cpc/gate-array.ts';
import type { CrtcLine } from '@/cores/crtc-6845.ts';
import { CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT } from '@/machines/cpc/constants.ts';

describe('Gate Array — raster interrupt', () => {
  it('requests an interrupt every 52 HSYNCs', () => {
    const ga = new GateArray();
    for (let i = 0; i < 51; i++) {
      ga.onHSync();
      expect(ga.interruptRequested).toBe(false);
    }
    ga.onHSync();
    expect(ga.interruptRequested).toBe(true);   // 52nd HSYNC
    ga.acknowledgeInterrupt();
    // Counter reset at 52 → the next INT is a full 52 lines away.
    for (let i = 0; i < 51; i++) {
      ga.onHSync();
      expect(ga.interruptRequested).toBe(false);
    }
    ga.onHSync();
    expect(ga.interruptRequested).toBe(true);
  });

  it('clears bit 5 of the counter on interrupt acknowledge (raster-split timing)', () => {
    const ga = new GateArray();
    for (let i = 0; i < 48; i++) ga.onHSync();    // count = 48, no INT yet
    expect(ga.interruptRequested).toBe(false);
    ga.acknowledgeInterrupt();                     // 48 & 0x1F = 16
    // From 16, the next INT is 52 − 16 = 36 HSYNCs away (not 4).
    for (let i = 0; i < 35; i++) {
      ga.onHSync();
      expect(ga.interruptRequested).toBe(false);
    }
    ga.onHSync();
    expect(ga.interruptRequested).toBe(true);
  });

  it('fires a re-sync interrupt at VSYNC when ≥32 HSYNCs have elapsed', () => {
    const ga = new GateArray();
    for (let i = 0; i < 32; i++) ga.onHSync();
    ga.onVSyncResync();
    expect(ga.interruptRequested).toBe(true);
  });

  it('does not fire a re-sync interrupt below 32 HSYNCs', () => {
    const ga = new GateArray();
    for (let i = 0; i < 31; i++) ga.onHSync();
    ga.onVSyncResync();
    expect(ga.interruptRequested).toBe(false);
  });

  it('resets the counter on VSYNC re-sync', () => {
    const ga = new GateArray();
    for (let i = 0; i < 40; i++) ga.onHSync();    // count 40 → fires + resets
    ga.onVSyncResync();
    ga.acknowledgeInterrupt();
    for (let i = 0; i < 51; i++) {
      ga.onHSync();
      expect(ga.interruptRequested).toBe(false);
    }
    ga.onHSync();
    expect(ga.interruptRequested).toBe(true);      // a full 52 from the reset
  });

  it('resets the interrupt counter on RMR bit 4', () => {
    const ga = new GateArray();
    for (let i = 0; i < 51; i++) ga.onHSync();    // count 51, one short of firing
    ga.write(0x80 | 0x10);                         // RMR with bit 4 set
    expect(ga.interruptRequested).toBe(false);
    for (let i = 0; i < 51; i++) {
      ga.onHSync();
      expect(ga.interruptRequested).toBe(false);   // counter was cleared
    }
    ga.onHSync();
    expect(ga.interruptRequested).toBe(true);
  });
});

describe('Gate Array — screen mode latch', () => {
  it('latches a mode change until the next HSYNC', () => {
    const ga = new GateArray();
    expect(ga.mode).toBe(1);          // reset default
    ga.write(0x80 | 0x02);            // RMR selecting mode 2
    expect(ga.mode).toBe(1);          // not applied within the line
    ga.onHSync();
    expect(ga.mode).toBe(2);          // applied at the HSYNC boundary
  });
});

describe('Gate Array — screen-address scramble', () => {
  function spyReads(line: CrtcLine, bufferY: number): number[] {
    const ga = new GateArray();
    const reads: number[] = [];
    const px = new Uint32Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT);
    ga.renderScanline(px, bufferY, line, (a) => { reads.push(a); return 0; });
    return reads;
  }

  it('fetches the first display byte at 0xC000 for the standard screen base', () => {
    // MA=0x3000, RA=0 → ((0x3000&0x3000)<<2) | 0 | ((0x3000&0x3FF)<<1) = 0xC000.
    const reads = spyReads({ maRow: 0x3000, ra: 0, hDisplayed: 1, vDisplay: true }, 0);
    expect(reads[0]).toBe(0xC000);
    expect(reads[1]).toBe(0xC001);    // the paired second byte of the character
  });

  it('offsets the fetch by RA<<11 within a character row', () => {
    // RA=2 adds 2<<11 = 0x1000 → 0xC000 | 0x1000 = 0xD000.
    const reads = spyReads({ maRow: 0x3000, ra: 2, hDisplayed: 1, vDisplay: true }, 10);
    expect(reads[0]).toBe(0xD000);
  });

  it('reads no display memory outside the vertical display region', () => {
    const reads = spyReads({ maRow: 0x3000, ra: 0, hDisplayed: 40, vDisplay: false }, 0);
    expect(reads.length).toBe(0);
  });
});
