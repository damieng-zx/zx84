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
import { createVariant, type MachineVariant } from '@/machines/spectrum/variants/index.ts';
import { spectrum48K } from '@/machines/spectrum/variants/spectrum-48k.ts';
import { spectrum16K } from '@/machines/spectrum/variants/spectrum-16k.ts';
import { createFerranti128K } from '@/machines/spectrum/variants/spectrum-ferranti.ts';
import { createAmstrad } from '@/machines/spectrum/variants/spectrum-amstrad.ts';
import { TIMING_48K, TIMING_128K, TIMING_PLUS2A } from '@/machines/spectrum/contention.ts';

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

  it('16K and 48K are singletons — same object reference every call', () => {
    expect(createVariant('16k')).toBe(createVariant('16k'));
    expect(createVariant('48k')).toBe(createVariant('48k'));
  });

  it('128K/+2/+2A/+3 factories return a fresh object each call (not singletons)', () => {
    expect(createFerranti128K('128k')).not.toBe(createFerranti128K('128k'));
    expect(createFerranti128K('+2')).not.toBe(createFerranti128K('+2'));
    expect(createAmstrad('+2A')).not.toBe(createAmstrad('+2A'));
    expect(createAmstrad('+3')).not.toBe(createAmstrad('+3'));
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

// ─────────────────────────────────────────────────────────────────────────
// Port decode — exhaustive mutual-exclusivity sweep
// ─────────────────────────────────────────────────────────────────────────

describe('variants — port decode exhaustive sweep', () => {
  /**
   * For every 16-bit port, count how many decoders fire. On +3 each port
   * must claim at most one peripheral; any double-decode means the masks
   * overlap and a write would corrupt two registers simultaneously.
   */
  it('+3: no port decodes to more than one peripheral across all 65536 ports', () => {
    const v = createAmstrad('+3');
    let maxHits = 0;
    for (let port = 0; port <= 0xFFFF; port++) {
      const hits =
        (v.decodes7FFD(port) ? 1 : 0) +
        (v.decodes1FFD(port) ? 1 : 0) +
        (v.decodesFDCData(port) ? 1 : 0) +
        (v.decodesFDCStatus(port) ? 1 : 0);
      if (hits > maxHits) maxHits = hits;
    }
    expect(maxHits).toBe(1);
  });

  it('+2A: no port decodes to more than one peripheral across all 65536 ports', () => {
    const v = createAmstrad('+2A');
    let maxHits = 0;
    for (let port = 0; port <= 0xFFFF; port++) {
      const hits =
        (v.decodes7FFD(port) ? 1 : 0) +
        (v.decodes1FFD(port) ? 1 : 0) +
        (v.decodesFDCData(port) ? 1 : 0) +
        (v.decodesFDCStatus(port) ? 1 : 0);
      if (hits > maxHits) maxHits = hits;
    }
    expect(maxHits).toBe(1);
  });

  it('+3: exactly 8192 ports decode as 7FFD (A15=0, A14=1, A1=0)', () => {
    const v = createAmstrad('+3');
    let count = 0;
    for (let port = 0; port <= 0xFFFF; port++) {
      if (v.decodes7FFD(port)) count++;
    }
    expect(count).toBe(8192);
  });

  it('128K/+2: exactly 16384 ports decode as 7FFD (A15=0, A1=0 — loose decode)', () => {
    for (const m of ['128k', '+2'] as const) {
      const v = createFerranti128K(m);
      let count = 0;
      for (let port = 0; port <= 0xFFFF; port++) {
        if (v.decodes7FFD(port)) count++;
      }
      expect(count).toBe(16384);
    }
  });

  it('128K/+2: 7FFD is the only decode that ever fires — 1FFD/FDC always false', () => {
    for (const m of ['128k', '+2'] as const) {
      const v = createFerranti128K(m);
      let any1FFD = false, anyFDCData = false, anyFDCStatus = false;
      for (let port = 0; port <= 0xFFFF; port++) {
        if (v.decodes1FFD(port)) any1FFD = true;
        if (v.decodesFDCData(port)) anyFDCData = true;
        if (v.decodesFDCStatus(port)) anyFDCStatus = true;
      }
      expect(any1FFD, `${m}: decodes1FFD fired on some port`).toBe(false);
      expect(anyFDCData, `${m}: decodesFDCData fired on some port`).toBe(false);
      expect(anyFDCStatus, `${m}: decodesFDCStatus fired on some port`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AY register ports — must not alias as banking/FDC ports
// ─────────────────────────────────────────────────────────────────────────

describe('variants — AY port decode independence', () => {
  // The AY register-select write uses (port & 0xC002) === 0xC000 (0xFFFD canonical).
  // The AY data write uses (port & 0xC002) === 0x8000 (0xBFFD canonical).
  // Neither must accidentally decode as a banking or FDC port.

  it('AY ports 0xBFFD/0xFFFD do not decode as 7FFD on 128K (bit 15 set rejects them)', () => {
    const v = createFerranti128K('128k');
    expect(v.decodes7FFD(0xBFFD)).toBe(false); // AY data write
    expect(v.decodes7FFD(0xFFFD)).toBe(false); // AY register select
  });

  it('AY ports 0xBFFD/0xFFFD do not decode as any banking or FDC port on +3', () => {
    const v = createAmstrad('+3');
    for (const port of [0xBFFD, 0xFFFD]) {
      expect(v.decodes7FFD(port)).toBe(false);
      expect(v.decodes1FFD(port)).toBe(false);
      expect(v.decodesFDCData(port)).toBe(false);
      expect(v.decodesFDCStatus(port)).toBe(false);
    }
  });

  it('ULA port 0x00FE has bit 1 set — does NOT alias as 7FFD on 128K', () => {
    // 0xFE = 11111110₂, bit 1 = 1 → mask (port & 0x8002) === 0x0002 ≠ 0
    const v = createFerranti128K('128k');
    expect(v.decodes7FFD(0x00FE)).toBe(false);
  });

  it('port 0x00FC (ULA read with A1=0) IS the notorious 7FFD alias on 128K', () => {
    // 0xFC = 11111100₂, bit 1 = 0, bit 15 = 0 → qualifies as the loose 7FFD decode.
    // This is a documented 128K hardware quirk, not a bug.
    const v = createFerranti128K('128k');
    expect(v.decodes7FFD(0x00FC)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isContended — address/bank independence checks
// ─────────────────────────────────────────────────────────────────────────

describe('variants — isContended address/bank independence', () => {
  it('Ferranti 128K: contention depends only on bank parity, address is truly irrelevant', () => {
    const v = createFerranti128K('128k');
    // Odd bank contended at every address slot (ROM slot, VRAM slot, high RAM)
    for (const addr of [0x0000, 0x4000, 0x8000, 0xC000]) {
      expect(v.isContended(addr, 1)).toBe(true);
      expect(v.isContended(addr, 5)).toBe(true);
      expect(v.isContended(addr, 7)).toBe(true);
    }
    // Even bank uncontended at every address slot
    for (const addr of [0x0000, 0x4000, 0x8000, 0xC000]) {
      expect(v.isContended(addr, 0)).toBe(false);
      expect(v.isContended(addr, 2)).toBe(false);
      expect(v.isContended(addr, 4)).toBe(false);
      expect(v.isContended(addr, 6)).toBe(false);
    }
  });

  it('Amstrad +2A/+3: contention depends only on bank ≥ 4, address is truly irrelevant', () => {
    for (const v of [createAmstrad('+2A'), createAmstrad('+3')]) {
      // Bank 3 (highest uncontended) and bank 4 (lowest contended) at the same address
      for (const addr of [0x0000, 0x4000, 0x8000, 0xC000]) {
        expect(v.isContended(addr, 3)).toBe(false); // boundary: just below contended range
        expect(v.isContended(addr, 4)).toBe(true);  // boundary: just above
      }
    }
  });

  it('48K isContended: bank parameter is ignored; address alone decides', () => {
    const v = spectrum48K;
    // Any bank value should not change the address-based decision
    for (const bank of [-1, 0, 1, 5, 7]) {
      expect(v.isContended(0x3FFF, bank)).toBe(false); // just below contended range
      expect(v.isContended(0x4000, bank)).toBe(true);  // first contended address
      expect(v.isContended(0x7FFF, bank)).toBe(true);  // last contended address
      expect(v.isContended(0x8000, bank)).toBe(false); // first uncontended address
    }
  });

  it('16K isContended: identical to 48K (same bank-ignoring, address-only rule)', () => {
    const v16 = spectrum16K;
    const v48 = spectrum48K;
    for (const addr of [0x0000, 0x3FFF, 0x4000, 0x5800, 0x7FFF, 0x8000, 0xFFFF]) {
      expect(v16.isContended(addr, 5)).toBe(v48.isContended(addr, 5));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// +2A vs +3 — only FDC presence and decodesFDCData differ
// ─────────────────────────────────────────────────────────────────────────

describe('variants — +2A vs +3 differ only on FDC', () => {
  const v2A = createAmstrad('+2A');
  const vP3 = createAmstrad('+3');

  it('+3 has FDC, +2A does not', () => {
    expect(v2A.hasFDC).toBe(false);
    expect(vP3.hasFDC).toBe(true);
  });

  it('+3 decodesFDCData for the full 0xF002 === 0x3000 set; +2A never does', () => {
    // 0x3FFD is the canonical FDC data port
    expect(v2A.decodesFDCData(0x3FFD)).toBe(false);
    expect(vP3.decodesFDCData(0x3FFD)).toBe(true);
    // Alias (A1=0, bits 15-12 = 0011)
    expect(v2A.decodesFDCData(0x3000)).toBe(false);
    expect(vP3.decodesFDCData(0x3000)).toBe(true);
  });

  it('decodesFDCStatus is true on BOTH +2A and +3 — gate array decodes even without FDC', () => {
    // The gate array hardware decodes 0x2FFD regardless; reads return open bus (0xFF)
    // on +2A (io-ports.ts guards with !v.hasFDC). This is intentional hardware behaviour.
    expect(v2A.decodesFDCStatus(0x2FFD)).toBe(true);
    expect(vP3.decodesFDCStatus(0x2FFD)).toBe(true);
  });

  it('all other properties are identical between +2A and +3', () => {
    // Spot-check key fields that must not diverge
    expect(v2A.timing).toBe(vP3.timing);
    expect(v2A.hasAY).toBe(vP3.hasAY);
    expect(v2A.hasBanking).toBe(vP3.hasBanking);
    expect(v2A.hasSpecialPaging).toBe(vP3.hasSpecialPaging);
    expect(v2A.romPageCount).toBe(vP3.romPageCount);
    expect(v2A.is48K).toBe(vP3.is48K);
    expect(v2A.cellRenderOffset).toBe(vP3.cellRenderOffset);
    expect(v2A.vramFlushEnd).toBe(vP3.vramFlushEnd);
    expect(v2A.hasIOContention).toBe(vP3.hasIOContention);
    expect(Array.from(v2A.contentionPattern)).toEqual(Array.from(vP3.contentionPattern));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 128K vs +2 — must be fully symmetric (same hardware, different branding)
// ─────────────────────────────────────────────────────────────────────────

describe('variants — 128K vs +2 are symmetric', () => {
  const v128 = createFerranti128K('128k');
  const vP2  = createFerranti128K('+2');

  it('all non-model properties are identical', () => {
    expect(v128.timing).toBe(vP2.timing);
    expect(v128.hasAY).toBe(vP2.hasAY);
    expect(v128.hasBanking).toBe(vP2.hasBanking);
    expect(v128.hasFDC).toBe(vP2.hasFDC);
    expect(v128.hasSpecialPaging).toBe(vP2.hasSpecialPaging);
    expect(v128.romPageCount).toBe(vP2.romPageCount);
    expect(v128.is48K).toBe(vP2.is48K);
    expect(v128.cellRenderOffset).toBe(vP2.cellRenderOffset);
    expect(v128.vramFlushEnd).toBe(vP2.vramFlushEnd);
    expect(v128.hasIOContention).toBe(vP2.hasIOContention);
    expect(Array.from(v128.contentionPattern)).toEqual(Array.from(vP2.contentionPattern));
  });

  it('port decode behaviour is identical for a wide port sample', () => {
    const ports = [0x0000, 0x00FE, 0x1FFD, 0x2FFD, 0x3FFD, 0x4000, 0x7FFD,
                   0x7FFF, 0x8000, 0xBFFD, 0xFFFD, 0xFFFF];
    for (const port of ports) {
      expect(v128.decodes7FFD(port)).toBe(vP2.decodes7FFD(port));
      expect(v128.decodes1FFD(port)).toBe(vP2.decodes1FFD(port));
      expect(v128.decodesFDCData(port)).toBe(vP2.decodesFDCData(port));
      expect(v128.decodesFDCStatus(port)).toBe(vP2.decodesFDCStatus(port));
    }
  });

  it('isContended results are identical for all bank/address combinations', () => {
    const addrs = [0x0000, 0x4000, 0x8000, 0xC000];
    const banks = [-1, 0, 1, 2, 3, 4, 5, 6, 7];
    for (const addr of addrs) {
      for (const bank of banks) {
        expect(v128.isContended(addr, bank)).toBe(vP2.isContended(addr, bank));
      }
    }
  });
});
