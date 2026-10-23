/**
 * SP0256-AL2 against the real allophone ROM.
 *
 * The mask ROM is copyrighted, so the image is not in the repo: put it at
 * mcp/.cache/sp0256-al2.rom (either bit order). The suite is skipped without it.
 *
 * The AL2 datasheet gives each allophone a nominal duration; the pause allophones
 * (PA1-PA5 = codes 0-4) are 10/30/50/100/200 ms by design. Decoding the wrong
 * field width anywhere in the ROM's instruction streams would derail the bit
 * stream, so every one of the 64 allophones must also run to a clean halt.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sp0256 } from '@/cores/sp0256.ts';

const ROM = resolve(__dirname, '../../mcp/.cache/sp0256-al2.rom');
const have = existsSync(ROM);

function play(chip: Sp0256, cmd: number): { ms: number; peak: number; rms: number } {
  chip.writeAld(cmd);
  let n = 0, peak = 0, sq = 0;
  while (n < 40000) {
    const s = chip.nextSample();
    n++;
    peak = Math.max(peak, Math.abs(s));
    sq += s * s;
    if (chip.idle) break;
  }
  return { ms: n / 10, peak, rms: Math.sqrt(sq / n) };
}

describe.skipIf(!have)('SP0256-AL2 ROM', () => {
  const rom = (): Uint8Array => new Uint8Array(readFileSync(ROM));
  const fresh = (): Sp0256 => { const c = new Sp0256(); c.loadRom(rom()); return c; };

  it('runs every allophone to a clean halt without clipping', () => {
    for (let cmd = 0; cmd < 64; cmd++) {
      const r = play(fresh(), cmd);
      expect(r.ms, `allophone ${cmd} halts`).toBeLessThan(3999);
      expect(r.peak, `allophone ${cmd} does not clip`).toBeLessThan(0.99);
    }
  });

  it('times the pause allophones PA1-PA5 at 10/30/50/100/200 ms', () => {
    const nominal = [10, 30, 50, 100, 200];
    nominal.forEach((ms, cmd) => {
      const r = play(fresh(), cmd);
      expect(r.ms, `PA${cmd + 1}`).toBeGreaterThan(ms * 0.65);
      expect(r.ms, `PA${cmd + 1}`).toBeLessThan(ms * 1.15);
      expect(r.peak).toBe(0);
    });
  });

  it('voices the vowels and leaves the pauses silent', () => {
    // 7 = EH, 19 = AA (an open vowel), 11 = IY.
    for (const cmd of [7, 19, 11]) expect(play(fresh(), cmd).rms, `allophone ${cmd}`).toBeGreaterThan(0.005);
  });

  it('accepts the next command as soon as the first is picked up (back-to-back words)', () => {
    const c = fresh();
    const seq = [0x1B, 0x07, 0x2D, 0x0F, 0x35];
    let i = 0, total = 0, guard = 0;
    while ((i < seq.length || !c.idle) && guard++ < 200000) {
      if (i < seq.length && c.ready) c.writeAld(seq[i++]);
      c.nextSample();
      total++;
    }
    expect(i).toBe(seq.length);
    expect(c.idle).toBe(true);
    expect(total).toBeGreaterThan(300);
  });
});
