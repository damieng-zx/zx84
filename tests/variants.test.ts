/**
 * MachineVariant strategy-object tests.
 *
 * Each Spectrum family (16K/48K Ferranti, 128K/+2 Ferranti, +2A/+3 Amstrad)
 * has a frozen variant object encoding the model-specific behaviour that
 * used to live as scattered `if (model === ...)` checks. The tests below
 * lock down:
 *
 *   • the contention pattern (Ferranti 6,5,4,3,2,1,0,0 vs Amstrad 1,0,7,6,5,4,3,2),
 *   • the contended-bank rule (48K: 0x4000-0x7FFF only; 128K: odd banks; +2A: banks ≥4),
 *   • capability flags (AY/banking/FDC/specialPaging/romPageCount/is48K),
 *   • port decode masks for 0x7FFD, 0x1FFD, FDC data/status,
 *   • display knobs (cellRenderOffset, vramFlushEnd),
 *   • factory dispatch and immutability.
 *
 * References:
 *   - Sinclair Wiki, "Contended Memory", "Contended I/O"
 *   - FUSE source (libspectrum machines/* port decode masks)
 *   - Chris Smith, "The ZX Spectrum ULA" (2010)
 */

import { describe, it, expect } from 'vitest';
import { createVariant, type MachineVariant } from '@/variants/index.ts';
import { spectrum48K } from '@/variants/spectrum-48k.ts';
import { spectrum16K } from '@/variants/spectrum-16k.ts';
import { createFerranti128K } from '@/variants/spectrum-ferranti.ts';
import { createAmstrad } from '@/variants/spectrum-amstrad.ts';
import { TIMING_48K, TIMING_128K, TIMING_PLUS2A } from '@/contention.ts';

// ─────────────────────────────────────────────────────────────────────────
// Contention patterns
// ─────────────────────────────────────────────────────────────────────────

const FERRANTI_PATTERN = [6, 5, 4, 3, 2, 1, 0, 0];
const AMSTRAD_PATTERN  = [1, 0, 7, 6, 5, 4, 3, 2];

describe('variants — contention pattern', () => {
  it('Ferranti ULA (16K/48K/128K/+2) uses 6,5,4,3,2,1,0,0', () => {
    const ferranti: MachineVariant[] = [
      spectrum16K,
      spectrum48K,
      createFerranti128K('128k'),
      createFerranti128K('+2'),
    ];
    for (const v of ferranti) {
      expect(Array.from(v.contentionPattern)).toEqual(FERRANTI_PATTERN);
    }
  });

  it('Amstrad gate array (+2A/+3) uses 1,0,7,6,5,4,3,2', () => {
    for (const v of [createAmstrad('+2A'), createAmstrad('+3')]) {
      expect(Array.from(v.contentionPattern)).toEqual(AMSTRAD_PATTERN);
    }
  });

  it('contention patterns are length-8 Uint8Arrays', () => {
    for (const m of ['16k', '48k', '128k', '+2', '+2A', '+3'] as const) {
      const v = createVariant(m);
      expect(v.contentionPattern).toBeInstanceOf(Uint8Array);
      expect(v.contentionPattern.length).toBe(8);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isContended
// ─────────────────────────────────────────────────────────────────────────

describe('variants — isContended', () => {
  it('48K: only 0x4000-0x7FFF is contended (no banking)', () => {
    const v = spectrum48K;
    // ROM
    expect(v.isContended(0x0000, -1)).toBe(false);
    expect(v.isContended(0x3FFF, -1)).toBe(false);
    // Contended 16KB
    expect(v.isContended(0x4000, 5)).toBe(true);
    expect(v.isContended(0x5800, 5)).toBe(true);
    expect(v.isContended(0x7FFF, 5)).toBe(true);
    // Upper RAM
    expect(v.isContended(0x8000, 2)).toBe(false);
    expect(v.isContended(0xC000, 0)).toBe(false);
    expect(v.isContended(0xFFFF, 0)).toBe(false);
  });

  it('16K: same rule as 48K — bank is irrelevant, address range decides', () => {
    const v = spectrum16K;
    expect(v.isContended(0x3FFF, -1)).toBe(false);
    expect(v.isContended(0x4000, 5)).toBe(true);
    expect(v.isContended(0x7FFF, 5)).toBe(true);
    expect(v.isContended(0x8000, -1)).toBe(false); // open-bus area
  });

  it('128K/+2 (Ferranti): odd RAM banks (1,3,5,7) are contended, address is irrelevant', () => {
    for (const v of [createFerranti128K('128k'), createFerranti128K('+2')]) {
      for (const bank of [1, 3, 5, 7]) {
        expect(v.isContended(0x0000, bank)).toBe(true);
        expect(v.isContended(0xC000, bank)).toBe(true);
      }
      for (const bank of [0, 2, 4, 6]) {
        expect(v.isContended(0x4000, bank)).toBe(false);
        expect(v.isContended(0xC000, bank)).toBe(false);
      }
      // ROM (bank = -1) is never contended
      expect(v.isContended(0x0000, -1)).toBe(false);
      expect(v.isContended(0x4000, -1)).toBe(false);
    }
  });

  it('+2A/+3 (Amstrad): banks 4-7 are contended, banks 0-3 are not', () => {
    for (const v of [createAmstrad('+2A'), createAmstrad('+3')]) {
      for (const bank of [4, 5, 6, 7]) {
        expect(v.isContended(0x0000, bank)).toBe(true);
        expect(v.isContended(0xC000, bank)).toBe(true);
      }
      for (const bank of [0, 1, 2, 3]) {
        expect(v.isContended(0x4000, bank)).toBe(false);
        expect(v.isContended(0xC000, bank)).toBe(false);
      }
      expect(v.isContended(0x0000, -1)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// IO contention flag
// ─────────────────────────────────────────────────────────────────────────

describe('variants — hasIOContention', () => {
  it('Ferranti variants enable four-case IO contention', () => {
    for (const v of [spectrum16K, spectrum48K, createFerranti128K('128k'), createFerranti128K('+2')]) {
      expect(v.hasIOContention).toBe(true);
    }
  });
  it('Amstrad variants disable IO contention (single MREQ-free check)', () => {
    expect(createAmstrad('+2A').hasIOContention).toBe(false);
    expect(createAmstrad('+3').hasIOContention).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Capability flags
// ─────────────────────────────────────────────────────────────────────────

describe('variants — capability flags', () => {
  type Caps = Pick<MachineVariant,
    'hasAY' | 'hasBanking' | 'hasFDC' | 'hasSpecialPaging' | 'romPageCount' | 'is48K'>;

  const expected: Record<string, Caps> = {
    '16k':  { hasAY: false, hasBanking: false, hasFDC: false, hasSpecialPaging: false, romPageCount: 1, is48K: true  },
    '48k':  { hasAY: false, hasBanking: false, hasFDC: false, hasSpecialPaging: false, romPageCount: 1, is48K: true  },
    '128k': { hasAY: true,  hasBanking: true,  hasFDC: false, hasSpecialPaging: false, romPageCount: 2, is48K: false },
    '+2':   { hasAY: true,  hasBanking: true,  hasFDC: false, hasSpecialPaging: false, romPageCount: 2, is48K: false },
    '+2A':  { hasAY: true,  hasBanking: true,  hasFDC: false, hasSpecialPaging: true,  romPageCount: 4, is48K: false },
    '+3':   { hasAY: true,  hasBanking: true,  hasFDC: true,  hasSpecialPaging: true,  romPageCount: 4, is48K: false },
  };

  it.each(Object.keys(expected))('%s has the expected capability set', (model) => {
    const v = createVariant(model as any);
    const caps = expected[model];
    expect(v.hasAY).toBe(caps.hasAY);
    expect(v.hasBanking).toBe(caps.hasBanking);
    expect(v.hasFDC).toBe(caps.hasFDC);
    expect(v.hasSpecialPaging).toBe(caps.hasSpecialPaging);
    expect(v.romPageCount).toBe(caps.romPageCount);
    expect(v.is48K).toBe(caps.is48K);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Display knobs
// ─────────────────────────────────────────────────────────────────────────

describe('variants — display configuration', () => {
  it('48K and 16K render at +1 cell offset, flush bitmap+attr (0x5B00)', () => {
    for (const v of [spectrum48K, spectrum16K]) {
      expect(v.cellRenderOffset).toBe(1);
      expect(v.vramFlushEnd).toBe(0x5B00);
    }
  });

  it('128K/+2/+2A/+3 render at offset 0, flush bitmap only (0x5800)', () => {
    for (const m of ['128k', '+2', '+2A', '+3'] as const) {
      const v = createVariant(m);
      expect(v.cellRenderOffset).toBe(0);
      expect(v.vramFlushEnd).toBe(0x5800);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Timing tables
// ─────────────────────────────────────────────────────────────────────────

describe('variants — timing tables', () => {
  it('16K/48K use TIMING_48K', () => {
    expect(spectrum16K.timing).toBe(TIMING_48K);
    expect(spectrum48K.timing).toBe(TIMING_48K);
  });
  it('128K/+2 use TIMING_128K', () => {
    expect(createFerranti128K('128k').timing).toBe(TIMING_128K);
    expect(createFerranti128K('+2').timing).toBe(TIMING_128K);
  });
  it('+2A/+3 use TIMING_PLUS2A', () => {
    expect(createAmstrad('+2A').timing).toBe(TIMING_PLUS2A);
    expect(createAmstrad('+3').timing).toBe(TIMING_PLUS2A);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Port decode
// ─────────────────────────────────────────────────────────────────────────

describe('variants — port decode', () => {
  describe('48K/16K decode nothing', () => {
    it.each([spectrum16K, spectrum48K])('variant %#', (v) => {
      // Try a representative spread of ports — none should decode.
      for (const port of [0x0000, 0x1FFD, 0x2FFD, 0x3FFD, 0x4000, 0x7FFD, 0xBFFD, 0xFFFD]) {
        expect(v.decodes7FFD(port)).toBe(false);
        expect(v.decodes1FFD(port)).toBe(false);
        expect(v.decodesFDCData(port)).toBe(false);
        expect(v.decodesFDCStatus(port)).toBe(false);
      }
    });
  });

  describe('128K/+2 loose decode: (port & 0x8002) === 0', () => {
    const v = createFerranti128K('128k');

    it('canonical 0x7FFD is recognised', () => {
      expect(v.decodes7FFD(0x7FFD)).toBe(true);
    });

    it('aliases that share bits 1 and 15 cleared also decode (loose 128K rule)', () => {
      // bit 15 = 0, bit 1 = 0: matches.
      expect(v.decodes7FFD(0x0000)).toBe(true); // famously aliases on real 128K
      expect(v.decodes7FFD(0x1FFD)).toBe(true); // would clash with +2A's 0x1FFD on real 128K
      expect(v.decodes7FFD(0x4000)).toBe(true);
    });

    it('rejects ports with bit 1 or bit 15 set', () => {
      expect(v.decodes7FFD(0x7FFF)).toBe(false); // bit 1 set
      expect(v.decodes7FFD(0xFFFD)).toBe(false); // bit 15 set
      expect(v.decodes7FFD(0x8000)).toBe(false);
    });

    it('does not decode 0x1FFD, FDC data, or FDC status', () => {
      for (const port of [0x1FFD, 0x3FFD, 0x2FFD]) {
        expect(v.decodes1FFD(port)).toBe(false);
        expect(v.decodesFDCData(port)).toBe(false);
        expect(v.decodesFDCStatus(port)).toBe(false);
      }
    });

    it('+2 behaves identically to 128K for port decode', () => {
      const v2 = createFerranti128K('+2');
      for (const port of [0x7FFD, 0x0000, 0x1FFD, 0x7FFF, 0xFFFD]) {
        expect(v2.decodes7FFD(port)).toBe(v.decodes7FFD(port));
      }
    });
  });

  describe('+2A strict decode: distinct masks per port', () => {
    const v = createAmstrad('+2A');

    it('0x7FFD requires (port & 0xC002) === 0x4000', () => {
      expect(v.decodes7FFD(0x7FFD)).toBe(true);
      expect(v.decodes7FFD(0x4000)).toBe(true);   // minimal match
      expect(v.decodes7FFD(0x5FFC)).toBe(true);   // bit 1 clear, bits 14 set, 15 clear
      // Aliases that the loose 128K decode allowed must NOT decode on +2A:
      expect(v.decodes7FFD(0x0000)).toBe(false);
      expect(v.decodes7FFD(0x1FFD)).toBe(false);
      expect(v.decodes7FFD(0xFFFD)).toBe(false);
      expect(v.decodes7FFD(0x7FFF)).toBe(false);  // bit 1 set
    });

    it('0x1FFD requires (port & 0xF002) === 0x1000', () => {
      expect(v.decodes1FFD(0x1FFD)).toBe(true);
      expect(v.decodes1FFD(0x1000)).toBe(true);
      expect(v.decodes1FFD(0x1FFC)).toBe(true);
      expect(v.decodes1FFD(0x1FFF)).toBe(false); // bit 1 set
      expect(v.decodes1FFD(0x2FFD)).toBe(false); // would hit FDC status
      expect(v.decodes1FFD(0x7FFD)).toBe(false);
    });

    it('FDC ports are not decoded on +2A (no FDC fitted)', () => {
      expect(v.decodesFDCData(0x3FFD)).toBe(false);
      expect(v.decodesFDCData(0x3000)).toBe(false);
    });

    it('FDC status port 0x2FFD: decoded on +2A even without an FDC', () => {
      // The gate array still decodes the address; reads return 0xFF (open bus).
      expect(v.decodesFDCStatus(0x2FFD)).toBe(true);
      expect(v.decodesFDCStatus(0x2000)).toBe(true);
      expect(v.decodesFDCStatus(0x2FFF)).toBe(false); // bit 1 set
    });
  });

  describe('+3 adds FDC data port', () => {
    const v = createAmstrad('+3');

    it('0x3FFD (FDC data) requires (port & 0xF002) === 0x3000', () => {
      expect(v.decodesFDCData(0x3FFD)).toBe(true);
      expect(v.decodesFDCData(0x3000)).toBe(true);
      expect(v.decodesFDCData(0x3FFC)).toBe(true);
      expect(v.decodesFDCData(0x3FFF)).toBe(false); // bit 1 set
      expect(v.decodesFDCData(0x2FFD)).toBe(false); // status, not data
      expect(v.decodesFDCData(0x7FFD)).toBe(false);
    });

    it('0x2FFD (FDC status) shares the same mask family', () => {
      expect(v.decodesFDCStatus(0x2FFD)).toBe(true);
      expect(v.decodesFDCStatus(0x2FFF)).toBe(false);
    });

    it('inherits +2A behaviour for 0x7FFD and 0x1FFD', () => {
      expect(v.decodes7FFD(0x7FFD)).toBe(true);
      expect(v.decodes7FFD(0x0000)).toBe(false);
      expect(v.decodes1FFD(0x1FFD)).toBe(true);
      expect(v.decodes1FFD(0x2FFD)).toBe(false);
    });
  });

  it('+3 decodes each canonical port to exactly one peripheral', () => {
    const v = createAmstrad('+3');
    for (const port of [0x7FFD, 0x1FFD, 0x2FFD, 0x3FFD]) {
      const hits =
        (v.decodes7FFD(port) ? 1 : 0) +
        (v.decodes1FFD(port) ? 1 : 0) +
        (v.decodesFDCData(port) ? 1 : 0) +
        (v.decodesFDCStatus(port) ? 1 : 0);
      expect(hits).toBe(1);
    }
  });

  it('+2A: no canonical port decodes to more than one peripheral (FDC data unfitted)', () => {
    const v = createAmstrad('+2A');
    for (const port of [0x7FFD, 0x1FFD, 0x2FFD, 0x3FFD]) {
      const hits =
        (v.decodes7FFD(port) ? 1 : 0) +
        (v.decodes1FFD(port) ? 1 : 0) +
        (v.decodesFDCData(port) ? 1 : 0) +
        (v.decodesFDCStatus(port) ? 1 : 0);
      expect(hits).toBeLessThanOrEqual(1);
      // 0x3FFD is the only one that may go unclaimed on +2A (no FDC data port).
      if (port !== 0x3FFD) expect(hits).toBe(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Factory and identity
// ─────────────────────────────────────────────────────────────────────────

describe('variants — factory and identity', () => {
  it('createVariant dispatches to the right family', () => {
    expect(createVariant('16k')).toBe(spectrum16K);
    expect(createVariant('48k')).toBe(spectrum48K);
    expect(createVariant('128k').model).toBe('128k');
    expect(createVariant('+2').model).toBe('+2');
    expect(createVariant('+2A').model).toBe('+2A');
    expect(createVariant('+3').model).toBe('+3');
  });

  it('variant objects are frozen (defensive immutability)', () => {
    for (const m of ['16k', '48k', '128k', '+2', '+2A', '+3'] as const) {
      const v = createVariant(m);
      expect(Object.isFrozen(v)).toBe(true);
      expect(() => { (v as any).hasFDC = !v.hasFDC; }).toThrow();
    }
  });

  it('each variant reports its own model', () => {
    for (const m of ['16k', '48k', '128k', '+2', '+2A', '+3'] as const) {
      expect(createVariant(m).model).toBe(m);
    }
  });
});
