/**
 * loader-signature.ts — pattern-matches bytes preceding PC against known
 * loader polling-loop tails. Pure function over a (read, pc) pair.
 *
 * Why this matters: when an auto-start fires, we know SOMETHING is reading
 * the tape but not WHAT. Identifying the ROM loader (vs an unrecognised
 * custom loader) lets the UI/debug surface a meaningful label and gives
 * us a hook for per-loader acceleration in future.
 *
 * What we pin:
 *   - The standard ROM LD-SAMPLE signature is recognised exactly at the
 *     PC the real Spectrum ROM hits ($05F3, just past the IN A,($FE)).
 *   - One-byte deltas anywhere in the pattern break the match.
 *   - PC wrap-around: a signature spanning the $FFFF/$0000 boundary still
 *     matches (we mask to 16 bits, as the Z80 does).
 *   - PC values too low to fit the pattern (e.g. PC < 6) wrap and may match
 *     coincidentally if the bytes near $FFFx happen to line up — we pin
 *     that behaviour here so it isn't surprising later.
 *   - Unknown patterns return 'unknown', not a thrown error.
 */

import { describe, it, expect } from 'vitest';
import { detectLoaderSignature } from '@/tape/loader-signature.ts';

// Build a 64K memory and place ROM-loader bytes at $05ED..$05F2.
// (Same bytes that appear in our shipped spec48.rom — verified by hexdump.)
const ROM_SAMPLE = [0x04, 0xC8, 0x3E, 0x7F, 0xDB, 0xFE];

function buildMemWithRomPattern(): Uint8Array {
  const mem = new Uint8Array(0x10000);
  for (let i = 0; i < ROM_SAMPLE.length; i++) mem[0x05ED + i] = ROM_SAMPLE[i];
  return mem;
}

function reader(mem: Uint8Array): (a: number) => number {
  return (a) => mem[a & 0xFFFF];
}

describe('detectLoaderSignature — ROM LD-SAMPLE', () => {
  it('recognises the ROM pattern at PC=$05F3 (real ROM hit point)', () => {
    const mem = buildMemWithRomPattern();
    expect(detectLoaderSignature(reader(mem), 0x05F3)).toBe('rom');
  });

  it('returns unknown if PC is shifted by one (signature alignment matters)', () => {
    const mem = buildMemWithRomPattern();
    expect(detectLoaderSignature(reader(mem), 0x05F2)).toBe('unknown');
    expect(detectLoaderSignature(reader(mem), 0x05F4)).toBe('unknown');
  });

  it('rejects any single-byte corruption in the pattern', () => {
    for (let i = 0; i < ROM_SAMPLE.length; i++) {
      const mem = buildMemWithRomPattern();
      mem[0x05ED + i] ^= 0x01; // flip a bit
      expect(detectLoaderSignature(reader(mem), 0x05F3)).toBe('unknown');
    }
  });

  it('all-zero memory returns unknown', () => {
    const mem = new Uint8Array(0x10000);
    expect(detectLoaderSignature(reader(mem), 0x05F3)).toBe('unknown');
  });

  it('recognises the pattern placed anywhere in memory (not tied to $05ED)', () => {
    // The detector reads relative to PC; the pattern's absolute address
    // doesn't matter as long as PC sits just after the last byte.
    const mem = new Uint8Array(0x10000);
    for (let i = 0; i < ROM_SAMPLE.length; i++) mem[0x8000 + i] = ROM_SAMPLE[i];
    expect(detectLoaderSignature(reader(mem), 0x8006)).toBe('rom');
  });
});

describe('detectLoaderSignature — PC wrap-around', () => {
  it('matches a signature that straddles the $FFFF/$0000 boundary', () => {
    const mem = new Uint8Array(0x10000);
    // Place bytes at $FFFD, $FFFE, $FFFF, $0000, $0001, $0002
    const addrs = [0xFFFD, 0xFFFE, 0xFFFF, 0x0000, 0x0001, 0x0002];
    for (let i = 0; i < ROM_SAMPLE.length; i++) mem[addrs[i]] = ROM_SAMPLE[i];
    // PC=$0003 means "the pattern ends at $0002 (PC-1)" — straddle.
    expect(detectLoaderSignature(reader(mem), 0x0003)).toBe('rom');
  });

  it('PC=0 walks backward into $FFFA..$FFFF (16-bit mask in effect)', () => {
    const mem = new Uint8Array(0x10000);
    const addrs = [0xFFFA, 0xFFFB, 0xFFFC, 0xFFFD, 0xFFFE, 0xFFFF];
    for (let i = 0; i < ROM_SAMPLE.length; i++) mem[addrs[i]] = ROM_SAMPLE[i];
    expect(detectLoaderSignature(reader(mem), 0x0000)).toBe('rom');
  });
});

describe('detectLoaderSignature — robustness', () => {
  it('does not throw when reader returns out-of-range integers', () => {
    // A noisy reader returning negatives / >255: we still expect a clean
    // 'unknown' (equality compares verbatim — pattern bytes are 0..255).
    const noisy = (a: number) => (a * 1234567) | 0;
    expect(detectLoaderSignature(noisy, 0x1234)).toBe('unknown');
  });

  it('PC at $0000 with all-zero memory: unknown (no false positive)', () => {
    const mem = new Uint8Array(0x10000);
    expect(detectLoaderSignature(reader(mem), 0x0000)).toBe('unknown');
  });
});
