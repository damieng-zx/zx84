/**
 * Minimal RIFF/WAVE reader for cassette audio.
 *
 * Apple II tapes are recordings of the machine's FSK output, so the tape
 * decoder needs the raw samples rather than any pulse model. Only the common
 * uncompressed layouts are handled (8-bit unsigned, 16-bit signed, 32-bit
 * float, PCM or IEEE float); multi-channel audio is averaged down to mono.
 */

import type { TapeBlock } from '@/media/tape/tap.ts';
import { TAPE_REF_HZ } from '@/media/tape/tap.ts';

export interface WavAudio {
  readonly sampleRate: number;
  /** Mono samples in -1..1. */
  readonly samples: Float32Array;
}

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
}

export function isWav(data: Uint8Array): boolean {
  return data.length > 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46  // RIFF
    && data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45; // WAVE
}

export function parseWav(data: Uint8Array): WavAudio {
  if (!isWav(data)) throw new Error('Not a RIFF/WAVE file');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= data.length) {
    const id = fourCC(view, pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, data.length - body);
    }
    pos = body + size + (size & 1);
  }

  if (dataOffset < 0 || channels === 0 || sampleRate === 0) {
    throw new Error('WAVE file has no usable audio data');
  }

  const bytesPerSample = bits >> 3;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataLength / frameBytes);
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const at = dataOffset + i * frameBytes + c * bytesPerSample;
      acc += readSample(view, at, format, bits);
    }
    out[i] = acc / channels;
  }
  return { sampleRate, samples: out };
}

function readSample(view: DataView, at: number, format: number, bits: number): number {
  if (format === 3) return view.getFloat32(at, true);   // IEEE float
  switch (bits) {
    case 8: return (view.getUint8(at) - 128) / 128;
    case 16: return view.getInt16(at, true) / 32768;
    case 24: {
      const b0 = view.getUint8(at);
      const b1 = view.getUint8(at + 1);
      const b2 = view.getUint8(at + 2);
      let v = b0 | (b1 << 8) | (b2 << 16);
      if (v & 0x800000) v |= ~0xFFFFFF;
      return v / 8388608;
    }
    case 32: return view.getInt32(at, true) / 2147483648;
    default: throw new Error(`Unsupported WAVE sample size: ${bits} bits`);
  }
}

// -- Audio to pulse stream --------------------------------------------------

/** Schmitt-trigger half-width as a fraction of the recording's peak. Wide
 *  enough to ride out tape hiss and ringing on a square edge, narrow enough
 *  that a quiet recording still triggers. */
const TRIGGER = 0.2;

/**
 * Turn a WAVE recording of a cassette into the pulse-level block the CSW path
 * already plays: a `set-level` for the starting polarity and one `csw` block
 * whose entries are the run lengths between edges, in 3.5MHz-referenced
 * T-states. The signal is centred on its mean and thresholded with hysteresis,
 * so each pulse is the time between the signal crossing +TRIGGER and -TRIGGER
 * of peak. Leading silence is dropped. Throws when the recording is silent.
 */
export function wavToPulseBlocks(data: Uint8Array): TapeBlock[] {
  const { sampleRate, samples } = parseWav(data);

  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  const mean = samples.length ? sum / samples.length : 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i] - mean);
    if (a > peak) peak = a;
  }
  if (peak < 0.01) throw new Error('WAVE recording is silent');
  const hi = mean + peak * TRIGGER;
  const lo = mean - peak * TRIGGER;

  const perSample = TAPE_REF_HZ / sampleRate;
  const runs: number[] = [];
  let level = -1;
  let start = 0;
  let initial = 0;
  const close = (end: number): void => {
    const t = Math.round((end - start) * perSample);
    runs.push(t < 1 ? 1 : t > 0x7FFFFFFF ? 0x7FFFFFFF : t);
  };
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (level < 0) {
      if (v > hi) { level = 1; initial = 1; start = i; }
      else if (v < lo) { level = 0; initial = 0; start = i; }
    } else if (level === 1 && v < lo) {
      close(i); level = 0; start = i;
    } else if (level === 0 && v > hi) {
      close(i); level = 1; start = i;
    }
  }
  if (level >= 0) close(samples.length);

  return [
    { kind: 'set-level', level: initial },
    { kind: 'csw', pulses: Uint32Array.from(runs) },
  ];
}
