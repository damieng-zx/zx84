/**
 * Konami SCC (K051649): register window, read-back and sound.
 *
 * Expectations come from the SCC documentation (the MSX Wiki "MegaROM Mappers"
 * page and Sean Young's SCC notes): the chip appears at 9800h-9FFFh once bank
 * register 3 (9000h) holds 3Fh; 9800h-987Fh reads back as RAM; 9880h-98FFh is
 * write-only (reads 0xFF); A8-A10 are not decoded, so each 256-byte block of
 * 9800h-9FFFh mirrors the first; 9890h-989Fh mirrors 9880h-988Fh; the pitch is
 * f = 3579545 / (32 x (TP + 1)); channels 4 and 5 share one waveform.
 */
import { describe, it, expect } from 'vitest';
import { MsxMemory } from '@/machines/msx/msx-memory.ts';
import { Scc } from '@/machines/msx/scc.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

const CLOCK = 3_579_545;
const RATE = 44100;

/** 128KB Konami SCC image: every 8KB block filled with 0x20 + its number. */
function sccRom(): Uint8Array {
  const rom = new Uint8Array(16 * 0x2000);
  for (let b = 0; b < 16; b++) rom.fill(0x20 + b, b * 0x2000, (b + 1) * 0x2000);
  return rom;
}

function board(): MsxMemory {
  const mem = new MsxMemory();
  mem.reset();
  mem.setPrimarySlots(0x14);                  // pages 1-2 -> slot 1
  mem.insertCartridge(sccRom(), 'konami-scc');
  return mem;
}

function chip(mem: MsxMemory): Scc {
  const scc = mem.cart.scc;
  if (!scc) throw new Error('no SCC');
  return scc;
}

describe('SCC window', () => {
  it('shows ROM at 9800h until bank register 3 holds 3Fh', () => {
    const mem = board();
    expect(mem.readByte(0x9800)).toBe(0x22);       // bank 2 (power-on)
    mem.writeByte(0x9000, 0x3F);
    mem.writeByte(0x9800, 0x55);                   // wave RAM write, not ROM
    expect(mem.readByte(0x9800)).toBe(0x55);
    mem.writeByte(0x9000, 0x03);                   // bank 3: ROM again
    expect(mem.readByte(0x9800)).toBe(0x23);
  });

  it('is switched in by any bank value with bits 0-5 set (bits 6-7 are ignored)', () => {
    const mem = board();
    mem.writeByte(0x97FF, 0xFF);                   // anywhere in the 9000h-97FFh window
    mem.writeByte(0x9801, 0x12);
    expect(mem.readByte(0x9801)).toBe(0x12);
  });

  it('is not switched in by 3Fh in another bank register', () => {
    const mem = board();
    mem.writeByte(0x7000, 0x3F);
    mem.writeByte(0xB000, 0x3F);
    expect(mem.readByte(0x9800)).toBe(0x22);
  });

  it('keeps the rest of the segment ROM: 8000h-97FFh is the bank, not the SCC', () => {
    const mem = board();
    mem.writeByte(0x9000, 0x3F);
    mem.writeByte(0x9800, 0x77);
    // Bank 3Fh on a 16-block image wraps to block 15.
    expect(mem.readByte(0x8000)).toBe(0x20 + 15);
    expect(mem.readByte(0x97FF)).toBe(0x20 + 15);
  });

  it('reads waveform RAM back, signed bytes stored as written', () => {
    const mem = board();
    mem.writeByte(0x9000, 0x3F);
    for (let i = 0; i < 0x80; i++) mem.writeByte(0x9800 + i, i * 3 + 0x80);
    for (let i = 0; i < 0x80; i++) expect(mem.readByte(0x9800 + i)).toBe((i * 3 + 0x80) & 0xFF);
  });

  it('reads 0xFF from the write-only registers 9880h-98FFh', () => {
    const mem = board();
    mem.writeByte(0x9000, 0x3F);
    mem.writeByte(0x9880, 0x34);
    mem.writeByte(0x988A, 0x0F);
    mem.writeByte(0x988F, 0x1F);
    mem.writeByte(0x98E0, 0x01);
    for (let a = 0x9880; a < 0x9900; a++) expect(mem.readByte(a)).toBe(0xFF);
  });

  it('mirrors each 256-byte block of 9800h-9FFFh onto the first (A8-A10 not decoded)', () => {
    const mem = board();
    mem.writeByte(0x9000, 0x3F);
    mem.writeByte(0x9A05, 0x6B);                   // block 2 of 8
    expect(mem.readByte(0x9805)).toBe(0x6B);
    expect(mem.readByte(0x9F05)).toBe(0x6B);
    mem.writeByte(0x9F8A, 0x0B);                   // volume 1 via the last mirror
    expect(chip(mem).volume[0]).toBe(0x0B);
  });

  it('writes bits 0-7 of a period to the even register and bits 8-11 to the odd one', () => {
    const mem = board();
    mem.writeByte(0x9000, 0x3F);
    mem.writeByte(0x9884, 0xCD);                   // channel 3 low
    mem.writeByte(0x9885, 0xFB);                   // channel 3 high: only bits 0-3 count
    expect(chip(mem).period[2]).toBe(0xBCD);
  });

  it('mirrors 9890h-989Fh onto 9880h-988Fh', () => {
    const mem = board();
    mem.writeByte(0x9000, 0x3F);
    mem.writeByte(0x9892, 0x40);                   // channel 2 low via the mirror
    mem.writeByte(0x989B, 0x0A);                   // channel 2 volume via the mirror
    mem.writeByte(0x989F, 0x1F);
    expect(chip(mem).period[1]).toBe(0x40);
    expect(chip(mem).volume[1]).toBe(0x0A);
    expect(chip(mem).enable).toBe(0x1F);
  });

  it('keeps only volume bits 0-3 and enable bits 0-4', () => {
    const mem = board();
    mem.writeByte(0x9000, 0x3F);
    mem.writeByte(0x988C, 0xF5);
    mem.writeByte(0x988F, 0xE7);
    expect(chip(mem).volume[2]).toBe(0x05);
    expect(chip(mem).enable).toBe(0x07);
  });

  it('ignores A0h-DFh and sends E0h-FFh to the test register', () => {
    const mem = board();
    mem.writeByte(0x9000, 0x3F);
    mem.writeByte(0x98A0, 0x01);
    mem.writeByte(0x98DF, 0x01);
    expect(chip(mem).deform).toBe(0);
    mem.writeByte(0x98FF, 0x02);
    expect(chip(mem).deform).toBe(0x02);
  });

  it('is cleared by a reset, which also drops the 3Fh bank', () => {
    const mem = board();
    mem.writeByte(0x9000, 0x3F);
    mem.writeByte(0x9800, 0x44);
    mem.writeByte(0x988F, 0x1F);
    mem.reset();
    mem.setPrimarySlots(0x14);
    expect(chip(mem).enable).toBe(0);
    expect(mem.readByte(0x9800)).toBe(0x22);
  });
});

/** Run `n` samples and return them. */
function render(scc: Scc, n: number): number[] {
  scc.clocksPerSample = CLOCK / RATE;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(scc.generateSampleMono());
  return out;
}

/** A 32-sample square wave: 16 samples of +amp, 16 of -amp. */
function square(scc: Scc, base: number, amp: number): void {
  for (let i = 0; i < 32; i++) scc.write(base + i, i < 16 ? amp : -amp);
}

function risingEdges(samples: number[]): number {
  let edges = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] <= 0 && samples[i] > 0) edges++;
  return edges;
}

describe('SCC sound', () => {
  it('is silent until a channel is enabled, and when its volume is 0', () => {
    const scc = new Scc();
    square(scc, 0, 100);
    scc.write(0x80, 100);
    scc.write(0x8A, 15);
    expect(Math.max(...render(scc, 200).map(Math.abs))).toBe(0);      // not enabled
    scc.write(0x8F, 1);
    expect(Math.max(...render(scc, 200).map(Math.abs))).toBeGreaterThan(0);
    scc.write(0x8A, 0);
    expect(Math.max(...render(scc, 200).map(Math.abs))).toBe(0);      // volume 0
  });

  it('plays a waveform at f = 3579545 / (32 x (TP + 1)): TP = 127 is 873.9 Hz', () => {
    const scc = new Scc();
    square(scc, 0, 100);
    scc.write(0x80, 127);
    scc.write(0x81, 0);
    scc.write(0x8A, 15);
    scc.write(0x8F, 1);
    const edges = risingEdges(render(scc, RATE));
    expect(Math.abs(edges - CLOCK / (32 * 128))).toBeLessThanOrEqual(1);
  });

  it('uses all 12 period bits: TP = 0x2FF is 36.4 Hz', () => {
    const scc = new Scc();
    square(scc, 0, 100);
    scc.write(0x80, 0xFF);
    scc.write(0x81, 0x02);
    scc.write(0x8A, 15);
    scc.write(0x8F, 1);
    const edges = risingEdges(render(scc, RATE * 2));
    expect(Math.abs(edges - 2 * CLOCK / (32 * 0x300))).toBeLessThanOrEqual(1);
  });

  it('scales linearly with volume and with waveform amplitude, and is signed', () => {
    const peak = (amp: number, vol: number): number => {
      const scc = new Scc();
      square(scc, 0, amp);
      scc.write(0x80, 200);
      scc.write(0x8A, vol);
      scc.write(0x8F, 1);
      return Math.max(...render(scc, 400));
    };
    const full = peak(100, 15);
    expect(full).toBeGreaterThan(0);
    expect(peak(100, 5) / full).toBeCloseTo(5 / 15, 3);
    expect(peak(50, 15) / full).toBeCloseTo(0.5, 3);
    // A waveform that is all negative gives negative output.
    const scc = new Scc();
    for (let i = 0; i < 32; i++) scc.write(i, 0x80);               // -128
    scc.write(0x80, 10); scc.write(0x8A, 15); scc.write(0x8F, 1);
    expect(Math.max(...render(scc, 100))).toBeLessThan(0);
  });

  it('adds the channels', () => {
    const level = (mask: number): number => {
      const scc = new Scc();
      for (let ch = 0; ch < 3; ch++) {
        for (let i = 0; i < 32; i++) scc.write(ch * 32 + i, 64);   // constant +64
        scc.write(0x8A + ch, 15);
        scc.write(0x80 + ch * 2, 50);
      }
      scc.write(0x8F, mask);
      render(scc, 50);
      return render(scc, 1)[0];
    };
    const a = level(1);
    expect(a).toBeGreaterThan(0);
    expect(level(3) / a).toBeCloseTo(2, 6);
    expect(level(7) / a).toBeCloseTo(3, 6);
  });

  it('shares one waveform between channels 4 and 5 (writes at 60h-7Fh land in both)', () => {
    const scc = new Scc();
    for (let i = 0; i < 32; i++) scc.write(0x60 + i, 64);
    scc.write(0x88, 20);                                               // channel 5 period
    scc.write(0x8E, 15);                                               // channel 5 volume
    scc.write(0x8F, 0x10);                                             // only channel 5
    render(scc, 20);
    expect(render(scc, 1)[0]).toBeGreaterThan(0);
    // Channel 1 has its own, untouched (silent) waveform.
    scc.write(0x8A, 15); scc.write(0x8F, 0x01);
    expect(Math.max(...render(scc, 50).map(Math.abs))).toBe(0);
  });

  it('multiplies every pitch by 256 with test-register bits 1-0 = 01 and by 16 with 1x', () => {
    const edgesWith = (deform: number): number => {
      const scc = new Scc();
      square(scc, 0, 100);
      scc.write(0x80, 0xFF); scc.write(0x81, 0x0F);                  // TP = 4095: 27.3 Hz
      scc.write(0x8A, 15); scc.write(0x8F, 1);
      scc.write(0xE0, deform);
      return risingEdges(render(scc, RATE));
    };
    const base = CLOCK / (32 * 4096);                                 // 27.31 Hz
    expect(Math.abs(edgesWith(0) - base)).toBeLessThanOrEqual(1);
    expect(Math.abs(edgesWith(0x02) - base * 16)).toBeLessThanOrEqual(2);
    expect(Math.abs(edgesWith(0x03) - base * 16)).toBeLessThanOrEqual(2);
    expect(Math.abs(edgesWith(0x01) - base * 256)).toBeLessThanOrEqual(base * 256 * 0.02);
  });

  it('does not alias a period shorter than an output sample into a buzz', () => {
    // TP = 1: 55.9 kHz fundamental, far above Nyquist. Averaging the steps
    // inside each output sample leaves a steady level, not a beat pattern.
    const scc = new Scc();
    for (let i = 0; i < 32; i++) scc.write(i, i < 8 ? 100 : 0);       // mean 25
    scc.write(0x80, 1);
    scc.write(0x8A, 15); scc.write(0x8F, 1);
    const s = render(scc, 200).slice(10);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    for (const v of s) expect(v).toBeCloseTo(mean, 2);
    expect(mean).toBeGreaterThan(0);
  });

  it('round-trips through saveState/loadState with the output continuing exactly', () => {
    const a = new Scc();
    square(a, 0, 90); square(a, 0x60, 40);
    a.write(0x80, 77); a.write(0x88, 31); a.write(0x8A, 12); a.write(0x8E, 9); a.write(0x8F, 0x11);
    a.write(0xE0, 0x02);
    render(a, 333);
    const w = new StateWriter();
    a.saveState(w);
    const b = new Scc();
    b.loadState(new StateReader(w.finish()));
    expect(render(b, 500)).toEqual(render(a, 500));
    expect(b.deform).toBe(0x02);
  });
});
