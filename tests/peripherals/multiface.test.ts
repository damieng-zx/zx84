/**
 * Multiface peripheral — slot-0 overlay (8KB ROM + 8KB RAM) with three
 * model-specific paging-port variants.
 *
 * Variant page-in / page-out OUT port pairs (low byte):
 *   MF1   (48K):     IN=0x9F, OUT=0x1F  (with MF1's extra "bit5+bit1==2" decode)
 *   MF128 (128K/+2): IN=0xBF, OUT=0x3F
 *   MF3   (+2A/+3):  IN=0x3F, OUT=0xBF  (swapped vs MF128)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  Multiface,
  variantForModel,
  variantLabel,
  romFilename,
} from '@/peripherals/multiface.ts';
import { SpectrumMemory } from '@/memory.ts';

describe('multiface — variantForModel / variantLabel / romFilename', () => {
  it('variantForModel dispatches on model class', () => {
    expect(variantForModel('16k')).toBe('MF1');
    expect(variantForModel('48k')).toBe('MF1');
    expect(variantForModel('128k')).toBe('MF128');
    expect(variantForModel('+2')).toBe('MF128');
    expect(variantForModel('+2A')).toBe('MF3');
    expect(variantForModel('+3')).toBe('MF3');
  });

  it('variantLabel gives the human-readable name', () => {
    expect(variantLabel('MF1')).toBe('Multiface 1');
    expect(variantLabel('MF128')).toBe('Multiface 128');
    expect(variantLabel('MF3')).toBe('Multiface 3');
  });

  it('romFilename matches what the ROM manager expects', () => {
    expect(romFilename('MF1')).toBe('MF1.rom');
    expect(romFilename('MF128')).toBe('MF128.rom');
    expect(romFilename('MF3')).toBe('MF3.rom');
  });
});

describe('multiface — matchPort decode', () => {
  let mf: Multiface;
  beforeEach(() => { mf = new Multiface(); });

  describe('MF1: in=0x9F, out=0x1F (and requires bit5 set + bit1 clear)', () => {
    beforeEach(() => { mf.variant = 'MF1'; });
    it('recognises 0x9F as page-in and 0x1F as page-out', () => {
      expect(mf.matchPort(0x9F)).toBe('in');
      expect(mf.matchPort(0x1F)).toBe('out');
    });
    it('returns null for ports failing the bit-mask gate', () => {
      // bit 1 set means (lo & 0x22) === 0x22, not 0x02 — rejected.
      expect(mf.matchPort(0x9D)).toBeNull();
      expect(mf.matchPort(0xBF)).toBeNull(); // MF128's port
      expect(mf.matchPort(0x3F)).toBeNull();
    });
    it('returns null for ports that pass the gate but are neither 0x9F nor 0x1F', () => {
      // 0x03: bit1=1, bit5=0 — passes gate, unrecognised port.
      expect(mf.matchPort(0x03)).toBeNull();
    });
    it('uses only the low byte (high byte irrelevant)', () => {
      expect(mf.matchPort(0xFF9F)).toBe('in');
      expect(mf.matchPort(0x121F)).toBe('out');
    });
  });

  describe('MF128: in=0xBF, out=0x3F', () => {
    beforeEach(() => { mf.variant = 'MF128'; });
    it('recognises both ports', () => {
      expect(mf.matchPort(0xBF)).toBe('in');
      expect(mf.matchPort(0x3F)).toBe('out');
    });
    it('rejects MF1 / MF3 ports and unrelated ports', () => {
      expect(mf.matchPort(0x9F)).toBeNull();
      expect(mf.matchPort(0x1F)).toBeNull();
      expect(mf.matchPort(0x00)).toBeNull();
    });
  });

  describe('MF3: in=0x3F, out=0xBF (swapped vs MF128)', () => {
    beforeEach(() => { mf.variant = 'MF3'; });
    it('recognises the swapped ports', () => {
      expect(mf.matchPort(0x3F)).toBe('in');
      expect(mf.matchPort(0xBF)).toBe('out');
    });
    it('rejects MF1 ports and unrelated ports', () => {
      expect(mf.matchPort(0x9F)).toBeNull();
      expect(mf.matchPort(0x1F)).toBeNull();
      expect(mf.matchPort(0x00)).toBeNull();
    });
  });
});

describe('multiface — loadROM', () => {
  it('copies the first 8KB and marks ROM loaded', () => {
    const mf = new Multiface();
    expect(mf.romLoaded).toBe(false);
    const blob = new Uint8Array(8192);
    for (let i = 0; i < blob.length; i++) blob[i] = i & 0xFF;
    mf.loadROM(blob);
    expect(mf.romLoaded).toBe(true);
    expect(mf.mfRom[0]).toBe(0);
    expect(mf.mfRom[0x1FFF]).toBe(0xFF);
  });

  it('truncates oversize input to the 8KB ROM area', () => {
    const mf = new Multiface();
    const huge = new Uint8Array(20000);
    huge.fill(0xAA, 0, 8192);
    huge.fill(0x55, 8192);
    mf.loadROM(huge);
    expect(mf.mfRom[0]).toBe(0xAA);
    expect(mf.mfRom[8191]).toBe(0xAA);
    // The 0x55 region must not have leaked into mfRom.
    expect(mf.mfRom.every(b => b === 0xAA)).toBe(true);
  });
});

describe('multiface — pageIn / pageOut overlay', () => {
  function makeMem(): SpectrumMemory {
    return new SpectrumMemory('48k');
  }

  it('pageIn replaces slot 0 with [ROM | RAM] overlay; pageOut restores it', () => {
    const mem = makeMem();
    const mf = new Multiface();
    mf.mfRom.fill(0xAA);
    mf.mfRam.fill(0x55);
    mf.romLoaded = true;

    const before = mem.readByte(0x0000);
    mf.pageIn(mem);
    expect(mem.readByte(0x0000)).toBe(0xAA);  // MF ROM
    expect(mem.readByte(0x1FFF)).toBe(0xAA);
    expect(mem.readByte(0x2000)).toBe(0x55);  // MF RAM
    expect(mem.readByte(0x3FFF)).toBe(0x55);

    mf.pageOut(mem);
    expect(mem.readByte(0x0000)).toBe(before); // back to original ROM
  });

  it('writes to overlay RAM area are persisted back into mfRam on pageOut', () => {
    const mem = makeMem();
    const mf = new Multiface();
    mf.mfRom.fill(0);
    mf.mfRam.fill(0);
    mf.romLoaded = true;

    mf.pageIn(mem);
    // Write into the RAM half of the overlay (0x2000-0x3FFF).
    mem.writeByte(0x2500, 0x42);
    mem.writeByte(0x3FFF, 0x99);
    mf.pageOut(mem);

    expect(mf.mfRam[0x0500]).toBe(0x42);
    expect(mf.mfRam[0x1FFF]).toBe(0x99);
  });

  it('pageIn is idempotent (second call is a no-op)', () => {
    const mem = makeMem();
    const mf = new Multiface();
    mf.mfRom.fill(0x11);
    mf.romLoaded = true;
    mf.pageIn(mem, 5);
    expect(mf.savedSlot0Bank).toBe(5);
    // A second pageIn must NOT overwrite savedSlot0Bank or re-snapshot slot 0.
    mf.pageIn(mem, 7);
    expect(mf.savedSlot0Bank).toBe(5);
    expect(mf.pagedIn).toBe(true);
  });

  it('pageOut is a no-op when not paged in', () => {
    const mem = makeMem();
    const mf = new Multiface();
    const before = mem.readByte(0x0000);
    expect(() => mf.pageOut(mem)).not.toThrow();
    expect(mem.readByte(0x0000)).toBe(before);
    expect(mf.pagedIn).toBe(false);
  });

  it('reset clears RAM, paged-in flag, and savedSlot0Bank', () => {
    const mf = new Multiface();
    mf.mfRam.fill(0xFF);
    mf.pagedIn = true;
    mf.savedSlot0Bank = 3;
    mf.reset();
    expect(mf.mfRam.every(b => b === 0)).toBe(true);
    expect(mf.pagedIn).toBe(false);
    expect(mf.savedSlot0Bank).toBe(-1);
  });

  it('reset does not clear enabled or romLoaded (hardware reset preserves ROM and device state)', () => {
    const mf = new Multiface();
    mf.enabled = true;
    mf.romLoaded = true;
    mf.reset();
    expect(mf.enabled).toBe(true);
    expect(mf.romLoaded).toBe(true);
  });
});

describe('multiface — pressButton', () => {
  it('does nothing when disabled or ROM not loaded (no NMI, no page-in)', () => {
    const mf = new Multiface();
    const mem = new SpectrumMemory('48k');
    let nmiCalls = 0;
    const fakeCpu = { nmi: () => { nmiCalls++; } } as any;

    // Disabled.
    mf.enabled = false;
    mf.romLoaded = true;
    mf.pressButton(mem, fakeCpu);
    expect(nmiCalls).toBe(0);
    expect(mf.pagedIn).toBe(false);

    // Enabled but no ROM.
    mf.enabled = true;
    mf.romLoaded = false;
    mf.pressButton(mem, fakeCpu);
    expect(nmiCalls).toBe(0);
    expect(mf.pagedIn).toBe(false);
  });

  it('when enabled and ROM loaded, pages in and triggers exactly one NMI', () => {
    const mf = new Multiface();
    mf.enabled = true;
    mf.mfRom.fill(0x77);
    mf.romLoaded = true;
    const mem = new SpectrumMemory('48k');
    let nmiCalls = 0;
    const fakeCpu = { nmi: () => { nmiCalls++; } } as any;

    mf.pressButton(mem, fakeCpu, 2);
    expect(mf.pagedIn).toBe(true);
    expect(mf.savedSlot0Bank).toBe(2);
    expect(mem.readByte(0x0000)).toBe(0x77);
    expect(nmiCalls).toBe(1);
  });
});

describe('multiface — armed latch (MF128/MF3 button-arming)', () => {
  it('starts disarmed; pressButton arms it', () => {
    const mf = new Multiface();
    mf.enabled = true;
    mf.romLoaded = true;
    const mem = new SpectrumMemory('128k');
    const fakeCpu = { nmi: () => {} } as any;
    expect(mf.armed).toBe(false);
    mf.pressButton(mem, fakeCpu);
    expect(mf.armed).toBe(true);
  });

  it('pageOut does NOT disarm it — the ROM pages in/out many times per session', () => {
    // The MF ROM's own menu/tool routines legitimately page out and back in
    // repeatedly (e.g. borrowing the underlying ROM's HALT/keyboard-scan
    // idle loop). If pageOut disarmed the latch, the ROM could never page
    // itself back in after the first internal page-out and the machine
    // would hang — a real regression this pins.
    const mf = new Multiface();
    mf.enabled = true;
    mf.romLoaded = true;
    const mem = new SpectrumMemory('128k');
    const fakeCpu = { nmi: () => {} } as any;
    mf.pressButton(mem, fakeCpu);
    mf.pageOut(mem);
    expect(mf.armed).toBe(true);
    // And it can still page itself back in.
    mf.pageIn(mem);
    expect(mf.pagedIn).toBe(true);
  });

  it('pressButton is a no-op (does not arm) when disabled or ROM not loaded', () => {
    const mf = new Multiface();
    const mem = new SpectrumMemory('128k');
    const fakeCpu = { nmi: () => {} } as any;

    mf.enabled = false;
    mf.romLoaded = true;
    mf.pressButton(mem, fakeCpu);
    expect(mf.armed).toBe(false);

    mf.enabled = true;
    mf.romLoaded = false;
    mf.pressButton(mem, fakeCpu);
    expect(mf.armed).toBe(false);
  });

  it('reset clears the armed latch', () => {
    const mf = new Multiface();
    mf.armed = true;
    mf.reset();
    expect(mf.armed).toBe(false);
  });
});
