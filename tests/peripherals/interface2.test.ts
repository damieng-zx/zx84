/**
 * ZX Interface 2 ROM cartridge slot — whole-16K slot-0 overlay.
 *
 * Reference: http://www.fruitcake.plus.com/Sinclair/Interface2/Cartridges/Interface2_RC_Cartridges.htm
 * — the cartridge ties /ROMCS permanently active, disabling the internal ROM
 * across all of $0000-$3FFF (there is no partial-range split like the
 * VTX-5000's $0000-$1FFF-only ROMCS). The slot has no /RD or /WR line, so a
 * real cartridge cannot be written to at all — writes are gated separately
 * in io-ports.ts (see tests/io-ports.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Interface2 } from '@/machines/spectrum/peripherals/interface2.ts';
import { SpectrumMemory } from '@/machines/spectrum/memory.ts';

describe('Interface2 — initial state', () => {
  it('starts with no cartridge inserted', () => {
    const c = new Interface2();
    expect(c.inserted).toBe(false);
    expect(c.name).toBe('');
  });
});

describe('Interface2 — insert/eject', () => {
  it('insert() records the cartridge name and marks it inserted', () => {
    const c = new Interface2();
    c.insert(new Uint8Array(16384).fill(0x11), 'Chess.rom');
    expect(c.inserted).toBe(true);
    expect(c.name).toBe('Chess.rom');
  });

  it('eject() clears both inserted and name', () => {
    const c = new Interface2();
    c.insert(new Uint8Array(16384), 'Chess.rom');
    c.eject();
    expect(c.inserted).toBe(false);
    expect(c.name).toBe('');
  });
});

describe('Interface2 — applyROM (slot-0 overlay)', () => {
  let mem: SpectrumMemory;
  beforeEach(() => {
    mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384).fill(0x5A)); // recognisable Spectrum ROM
  });

  it('overlays the whole 16K with the cartridge image — no splicing with the Spectrum ROM', () => {
    const c = new Interface2();
    const cart = new Uint8Array(16384);
    for (let i = 0; i < cart.length; i++) cart[i] = i & 0xFF;
    c.insert(cart, 'cart.rom');

    const spy = vi.spyOn(mem, 'setSlot0');
    c.applyROM(mem);

    expect(spy).toHaveBeenCalledTimes(1);
    const overlay = spy.mock.calls[0][0];
    expect(overlay.length).toBe(16384);
    // Unlike VTX-5000 (which preserves the upper 8K), none of the Spectrum
    // ROM's 0x5A filler bytes should appear anywhere in the overlay.
    expect(overlay[0]).toBe(0);
    expect(overlay[0x2000]).toBe(0x2000 & 0xFF);
    expect(overlay[0x3FFF]).toBe(0x3FFF & 0xFF);
  });

  it('marks the memory as externally ROM-paged', () => {
    const c = new Interface2();
    c.insert(new Uint8Array(16384), 'cart.rom');
    c.applyROM(mem);
    expect(mem.externalRomPaged).toBe(true);
  });

  it('a short image is zero-padded to 16KB rather than left undersized', () => {
    const c = new Interface2();
    c.insert(Uint8Array.of(0xDE, 0xAD), 'short.rom');
    const spy = vi.spyOn(mem, 'setSlot0');
    c.applyROM(mem);
    const overlay = spy.mock.calls[0][0];
    expect(overlay[0]).toBe(0xDE);
    expect(overlay[1]).toBe(0xAD);
    expect(overlay[2]).toBe(0);
    expect(overlay[16383]).toBe(0);
  });

  it('a re-insert does not bleed bytes from the previous cartridge past its own length', () => {
    const c = new Interface2();
    c.insert(new Uint8Array(16384).fill(0xFF), 'first.rom');
    c.insert(Uint8Array.of(0x01), 'second.rom');
    const spy = vi.spyOn(mem, 'setSlot0');
    c.applyROM(mem);
    const overlay = spy.mock.calls[0][0];
    expect(overlay[0]).toBe(0x01);
    expect(overlay[1]).toBe(0); // must not still read 0xFF from 'first.rom'
  });

  it('an oversized image is truncated to the first 16KB', () => {
    const c = new Interface2();
    const img = new Uint8Array(20000);
    img[16383] = 0x42;
    img[16384] = 0x99; // beyond the 16K window — must be dropped
    c.insert(img, 'big.rom');
    const spy = vi.spyOn(mem, 'setSlot0');
    c.applyROM(mem);
    const overlay = spy.mock.calls[0][0];
    expect(overlay.length).toBe(16384);
    expect(overlay[16383]).toBe(0x42);
  });
});
