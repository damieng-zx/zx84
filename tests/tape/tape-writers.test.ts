/**
 * The shared recording pieces: PulseRecorder (edge timing), the TZX writer
 * (block layouts from the TZX 1.20 specification) and the WAV writer (the
 * canonical 44-byte RIFF/WAVE PCM header).
 */

import { describe, it, expect } from 'vitest';
import { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import { encodeTzx } from '@/media/tape/tzx-writer.ts';
import { pulsesToWav } from '@/media/tape/wav-writer.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { parseWav } from '@/media/tape/wav.ts';
import type { CswBlock, PauseBlock, TextBlock } from '@/media/tape/tap.ts';

describe('PulseRecorder', () => {
  it('times transitions from the first edge and ignores re-writes of the same level', () => {
    const r = new PulseRecorder();
    r.observe(0, 100);       // already low: not an edge
    r.observe(1, 1000);      // first edge starts the clock
    r.observe(1, 1500);      // same level
    r.observe(0, 1855);
    r.observe(1, 2710);
    expect(Array.from(r.pulses())).toEqual([855, 855]);
    expect(r.firstLevel).toBe(1);
  });

  it('closes the pulse still in progress when asked for the time now', () => {
    const r = new PulseRecorder();
    r.observe(1, 0);
    r.observe(0, 500);
    expect(Array.from(r.pulses(2000))).toEqual([500, 1500]);
    expect(r.count).toBe(1);   // asking does not record it
  });

  it('toggle() is an edge every call', () => {
    const r = new PulseRecorder();
    r.toggle(10); r.toggle(20); r.toggle(50);
    expect(Array.from(r.pulses())).toEqual([10, 30]);
  });

  it('grows past its initial buffer and stops at its ceiling', () => {
    const r = new PulseRecorder(100_000);
    for (let i = 0; i <= 150_000; i++) r.observe(i & 1, i * 10);
    expect(r.count).toBe(100_000);
    expect(r.pulses()[99_999]).toBe(10);
  });

  it('forgets everything on reset', () => {
    const r = new PulseRecorder();
    r.observe(1, 0); r.observe(0, 10);
    r.reset();
    expect(r.count).toBe(0);
    expect(r.hasEdges).toBe(false);
    expect(r.pulses(1000).length).toBe(0);
  });
});

describe('encodeTzx', () => {
  it('writes a 0x18 CSW block as RLE at a 3.5 MHz sample rate', () => {
    const t = encodeTzx([{ kind: 'csw', pulses: [100, 300, 70000], pause: 250 }]);
    expect(Array.from(t.subarray(10))).toEqual([
      0x18,
      0x15, 0, 0, 0,               // block length after this DWORD: 10 + 1 + 5 + 5 = 21
      250, 0,                      // pause
      0xE0, 0x67, 0x35,            // 3500000 = 0x3567E0
      1,                           // RLE
      3, 0, 0, 0,                  // pulse count
      100,                         // fits a byte
      0, 0x2C, 0x01, 0, 0,         // 300 = 0x012C, escaped
      0, 0x70, 0x11, 0x01, 0,      // 70000 = 0x011170
    ]);
    const blocks = parseTZX(t);
    expect(Array.from((blocks[0] as CswBlock).pulses)).toEqual([100, 300, 70000]);
    expect((blocks[1] as PauseBlock).duration).toBe(250);
  });

  it('never writes a 0x20 pause of 0 (that means "stop the tape")', () => {
    const t = encodeTzx([{ kind: 'pause', ms: 0 }]);
    expect(Array.from(t.subarray(10))).toEqual([0x20, 1, 0]);
  });

  it('writes a 0x30 text block', () => {
    const t = encodeTzx([{ kind: 'text', text: 'hi' }]);
    expect(Array.from(t.subarray(10))).toEqual([0x30, 2, 0x68, 0x69]);
    expect((parseTZX(t)[0] as TextBlock).text).toBe('hi');
  });
});

describe('pulsesToWav', () => {
  it('writes the canonical 16-bit mono PCM header', () => {
    const w = pulsesToWav([441, 441], 44100, 1, 44100);   // two 10 ms half-cycles
    const v = new DataView(w.buffer);
    const tag = (o: number): string => String.fromCharCode(...w.subarray(o, o + 4));
    const dataBytes = w.length - 44;
    expect(tag(0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + dataBytes);
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);      // PCM
    expect(v.getUint16(22, true)).toBe(1);      // mono
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(88200);  // byte rate
    expect(v.getUint16(32, true)).toBe(2);      // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(dataBytes);
  });

  it('puts each edge on the right sample with the polarity alternating', () => {
    // 1 kHz clock: 3 ms high, 2 ms low, at 1 kHz sampling.
    const { samples } = parseWav(pulsesToWav([3, 2], 1000, 1, 1000));
    const lead = 100;   // 0.1 s of leading silence
    const body = Array.from(samples.subarray(lead, lead + 5), s => Math.sign(s));
    expect(body).toEqual([1, 1, 1, -1, -1]);
    expect(samples[lead - 1]).toBe(0);
  });
});
