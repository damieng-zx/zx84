/**
 * VTX-5000 Prestel modem — 8251 USART state machine + slot-0 ROM overlay.
 *
 * Reference: Intel 8251A datasheet (mode/command/status registers) and the
 * Prism Microelectronics VTX-5000 service manual (RTS-controlled ROMCS).
 *
 * The 8251 protocol on this hardware:
 *   • After reset the next control write is the mode register.
 *   • Subsequent control writes target the command register.
 *   • Writing bit 6 (Internal Reset) re-arms the "expect mode" latch and
 *     forgets the command register entirely.
 *   • Bit 5 (RTS) is wired to ROMCS: a 0→1 or 1→0 transition pages the
 *     Spectrum ROM in or the VTX ROM in via the onRomPage callback.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VTX5000 } from '@/peripherals/vtx5000.ts';
import { SpectrumMemory } from '@/memory.ts';

describe('VTX5000 — initial state', () => {
  it('starts disabled, no ROM loaded, RAM and FIFO clear, expects mode word', () => {
    const v = new VTX5000();
    expect(v.enabled).toBe(false);
    expect(v.romLoaded).toBe(false);
    expect(v.romSize).toBe(0);
    expect(v.dsr).toBe(false);
    expect(v.vtxRomPaged).toBe(true);
    // Status with empty FIFO: TXRDY|TXEMPTY = 0x05
    expect(v.readStatus()).toBe(0x05);
  });
});

describe('VTX5000 — loadROM', () => {
  it('accepts an 8KB image verbatim', () => {
    const v = new VTX5000();
    const img = new Uint8Array(8192).map((_, i) => i & 0xFF);
    v.loadROM(img);
    expect(v.romLoaded).toBe(true);
    expect(v.romSize).toBe(8192);
    expect(v.vtxRom[0]).toBe(0);
    expect(v.vtxRom[255]).toBe(255);
    expect(v.vtxRom[8191]).toBe(8191 & 0xFF);
  });

  it('truncates a 16KB image to the first 8KB (VTX ROM is 8K; upper half is RAM)', () => {
    const v = new VTX5000();
    const img = new Uint8Array(16384);
    img[0] = 0xAA;
    img[8192] = 0xBB; // would-be upper half
    v.loadROM(img);
    expect(v.romSize).toBe(8192);
    expect(v.vtxRom[0]).toBe(0xAA);
    // vtxRom is sized for 8K, so the upper-half byte is not stored anywhere.
    expect(v.vtxRom.length).toBe(8192);
  });

  it('a short ROM image only fills its own length; later loads start fresh', () => {
    const v = new VTX5000();
    v.loadROM(Uint8Array.of(1, 2, 3, 4));
    expect(v.romSize).toBe(4);
    expect(v.vtxRom[0]).toBe(1);
    expect(v.vtxRom[4]).toBe(0); // zero-fill before set()
    // Re-load with different short image — old tail bytes must not bleed through.
    v.loadROM(Uint8Array.of(9));
    expect(v.romSize).toBe(1);
    expect(v.vtxRom[0]).toBe(9);
    expect(v.vtxRom[1]).toBe(0);
  });
});

describe('VTX5000 — applyROM (slot-0 overlay)', () => {
  let mem: SpectrumMemory;
  let v: VTX5000;
  /** A recognisable 16K Spectrum ROM image: byte i = (i ^ 0x5A) & 0xFF. */
  function makeSpectrumRom(): Uint8Array {
    const r = new Uint8Array(16384);
    for (let i = 0; i < r.length; i++) r[i] = (i ^ 0x5A) & 0xFF;
    return r;
  }
  beforeEach(() => {
    mem = new SpectrumMemory('48k');
    mem.loadROM(makeSpectrumRom());
    v = new VTX5000();
  });

  it('places the VTX ROM at $0000-$1FFF and preserves Spectrum ROM at $2000-$3FFF', () => {
    // The cartridge's ROMCS line only asserts for $0000-$1FFF — the Spectrum
    // ROM upper half must remain visible because cartridge code (e.g. the
    // trampolines at $1FCC) bounces through it.
    const rom = new Uint8Array(8192);
    rom[0] = 0xDE; rom[1] = 0xAD; rom[8191] = 0xEF;
    v.loadROM(rom);
    const spy = vi.spyOn(mem, 'setSlot0');
    v.applyROM(mem);

    expect(spy).toHaveBeenCalledTimes(1);
    const overlay = spy.mock.calls[0][0];
    expect(overlay.length).toBe(16384);
    // Lower 8K: VTX ROM
    expect(overlay[0]).toBe(0xDE);
    expect(overlay[1]).toBe(0xAD);
    expect(overlay[8191]).toBe(0xEF);
    // Upper 8K: identical to the Spectrum ROM upper half
    const expected = makeSpectrumRom();
    expect(overlay[0x2000]).toBe(expected[0x2000]);
    expect(overlay[0x3000]).toBe(expected[0x3000]);
    expect(overlay[0x3FFF]).toBe(expected[0x3FFF]);
    expect(v.vtxRomPaged).toBe(true);
  });

  it('a short ROM image does NOT blank out bytes from the previous Spectrum ROM upper half', () => {
    // Regression guard: an earlier implementation zero-filled $2000-$3FFF
    // with a bogus "on-board RAM" buffer.
    v.loadROM(Uint8Array.of(0xAA));
    const spy = vi.spyOn(mem, 'setSlot0');
    v.applyROM(mem);
    const overlay = spy.mock.calls[0][0];
    expect(overlay[0]).toBe(0xAA);
    // No on-board RAM exists, so $2000+ must mirror the Spectrum ROM.
    const expected = makeSpectrumRom();
    expect(overlay[0x2000]).toBe(expected[0x2000]);
    expect(overlay[0x3FFF]).toBe(expected[0x3FFF]);
  });

  it('re-applying after a Spectrum ROM change re-snapshots the upper half', () => {
    v.loadROM(new Uint8Array(8192));
    v.applyROM(mem);
    // Host swaps in a different Spectrum ROM.
    const alt = new Uint8Array(16384);
    for (let i = 0; i < alt.length; i++) alt[i] = (i + 1) & 0xFF;
    mem.loadROM(alt);
    const spy = vi.spyOn(mem, 'setSlot0');
    v.applyROM(mem);
    const overlay = spy.mock.calls[0][0];
    expect(overlay[0x2000]).toBe(alt[0x2000]);
    expect(overlay[0x3FFF]).toBe(alt[0x3FFF]);
  });
});

describe('VTX5000 — 8251 status register', () => {
  let v: VTX5000;
  beforeEach(() => { v = new VTX5000(); });

  it('always asserts TXRDY + TXEMPTY (no real serial line to back up)', () => {
    expect(v.readStatus() & 0x05).toBe(0x05);
  });

  it('sets RXRDY (bit 1) iff a byte is waiting in the receive FIFO', () => {
    expect(v.readStatus() & 0x02).toBe(0);
    v.receivebyte(0x55);
    expect(v.readStatus() & 0x02).toBe(0x02);
    v.readData();
    expect(v.readStatus() & 0x02).toBe(0);
  });

  it('reflects DSR (bit 7) from the modelled remote end', () => {
    expect(v.readStatus() & 0x80).toBe(0);
    v.dsr = true;
    expect(v.readStatus() & 0x80).toBe(0x80);
  });
});

describe('VTX5000 — receive FIFO', () => {
  let v: VTX5000;
  beforeEach(() => { v = new VTX5000(); });

  it('receivebyte enqueues and readData dequeues in FIFO order, masked to 8 bits', () => {
    v.receivebyte(0x100 | 0xAB); // upper bits must be masked off
    v.receivebyte(0xCD);
    expect(v.readData()).toBe(0xAB);
    expect(v.readData()).toBe(0xCD);
  });

  it('readData on an empty FIFO returns 0 rather than throwing', () => {
    expect(v.readData()).toBe(0);
  });

  it('writeData is a no-op (no remote end; bytes are intentionally discarded)', () => {
    expect(() => v.writeData(0x55)).not.toThrow();
  });
});

describe('VTX5000 — 8251 control register: mode vs command', () => {
  let v: VTX5000;
  beforeEach(() => { v = new VTX5000(); });

  it('first control write after reset is consumed as the mode register', () => {
    v.writeControl(0xCE); // arbitrary mode word (1 stop, 8-bit, x16)
    expect(v.modeReg).toBe(0xCE);
    // Subsequent writes are command-register; another byte should NOT clobber mode.
    v.writeControl(0x00);
    expect(v.modeReg).toBe(0xCE);
  });

  it('Internal Reset (command bit 6) re-arms the mode latch and zeros the command', () => {
    v.writeControl(0x00);       // mode = 0
    v.writeControl(0x27);       // command: TxEN|DTR|RxEN|ER — RTS not asserted
    v.writeControl(0x40);       // Internal Reset
    // After IR the next control write must be treated as mode again.
    v.writeControl(0xAB);
    expect(v.modeReg).toBe(0xAB);
  });
});

describe('VTX5000 — RTS / ROM page switching', () => {
  let v: VTX5000;
  let pages: boolean[];
  beforeEach(() => {
    v = new VTX5000();
    pages = [];
    v.onRomPage = (rts) => pages.push(rts);
    v.writeControl(0x00); // consume the mode word
  });

  it('asserting RTS (bit 5) for the first time fires onRomPage(true) → Spectrum ROM in', () => {
    v.writeControl(0x20); // RTS = 1
    expect(pages).toEqual([true]);
  });

  it('only edges trigger the callback — repeated writes with the same RTS bit do nothing', () => {
    v.writeControl(0x20);
    v.writeControl(0x21); // RTS still set, other bits change
    v.writeControl(0x25);
    expect(pages).toEqual([true]);
  });

  it('a 1→0 transition fires onRomPage(false) → VTX ROM in', () => {
    v.writeControl(0x20); // 0→1
    v.writeControl(0x00); // 1→0
    expect(pages).toEqual([true, false]);
  });

  it('an Internal Reset clears the command register so the next RTS=0 write is not seen as an edge', () => {
    v.writeControl(0x20);   // 0→1, fires true
    v.writeControl(0x40);   // IR — command cleared, mode-latch re-armed
    v.writeControl(0x00);   // next write is mode reg again, not command
    v.writeControl(0x00);   // command write with RTS=0; prev RTS was 0, no edge
    expect(pages).toEqual([true]);
  });

  it('with no onRomPage callback installed, RTS transitions are silently absorbed', () => {
    const v2 = new VTX5000();
    v2.writeControl(0x00);                          // mode
    expect(() => v2.writeControl(0x20)).not.toThrow();
  });
});

describe('VTX5000 — reset', () => {
  it('clears USART state, FIFO, DSR, and the mode-latch; leaves enabled and the loaded ROM untouched', () => {
    const v = new VTX5000();
    v.enabled = true;
    v.loadROM(Uint8Array.of(0x99));
    v.writeControl(0xAA);             // mode reg
    v.writeControl(0x20);              // command, RTS set
    v.receivebyte(0x77);
    v.dsr = true;
    v.vtxRomPaged = false;

    v.reset();
    expect(v.enabled).toBe(true);
    expect(v.modeReg).toBe(0);
    expect(v.dsr).toBe(false);
    expect(v.vtxRomPaged).toBe(true);
    expect(v.romLoaded).toBe(true);       // ROM survives reset (user-loaded asset)
    expect(v.vtxRom[0]).toBe(0x99);
    expect(v.readStatus() & 0x02).toBe(0); // FIFO drained
    // After reset, expectMode is true again — next control write lands as mode.
    v.writeControl(0x55);
    expect(v.modeReg).toBe(0x55);
  });
});
