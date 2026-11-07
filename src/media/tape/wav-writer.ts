/**
 * RIFF/WAVE writer for cassette recordings.
 *
 * Machines whose own tape format *is* audio (the Apple I's ACI, the Apple II)
 * export what they SAVEd as a square wave rebuilt from the captured pulse
 * widths. The container is the canonical 44-byte PCM header (RIFF, `fmt `
 * chunk of 16 bytes, `data` chunk), 16-bit signed little-endian mono —
 * readable by `parseWav` in wav.ts and by any audio tool.
 */

/** Default output rate: CD rate, ~22.7 µs per sample — fine against the
 *  shortest cassette half-cycles these machines write (~200 µs). */
export const WAV_DEFAULT_RATE = 44100;

/** Peak of the square wave, as a fraction of 16-bit full scale. */
const AMPLITUDE = 0.5;

/** A pulse longer than this holds its level only this long, then the
 *  signal falls to silence (zero), as a real AC-coupled tape does. The pulse
 *  that follows has the opposite polarity, so it still reads as an edge. */
const HOLD_SECONDS = 0.01;

/** Silence written before the first and after the last pulse. */
const LEAD_SECONDS = 0.1;

/** Wrap 16-bit signed mono PCM samples in a RIFF/WAVE container. */
export function encodeWav16(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);      // RIFF size: everything after this field
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);                 // fmt chunk size (plain PCM)
  v.setUint16(20, 1, true);                  // format 1 = PCM
  v.setUint16(22, 1, true);                  // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);     // byte rate = rate × block align
  v.setUint16(32, 2, true);                  // block align = channels × 2
  v.setUint16(34, 16, true);                 // bits per sample
  tag(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i], true);
  return out;
}

/**
 * Render a pulse train as a square-wave WAVE file. `pulses` are the times
 * between successive edges in `clockHz` units (a PulseRecorder's output);
 * the first pulse is at `firstLevel` (1 = positive) and each one after it
 * flips. Edges are placed on the nearest sample with the error carried
 * forward, so the long-run timing does not drift.
 */
export function pulsesToWav(
  pulses: ArrayLike<number>,
  clockHz: number,
  firstLevel = 1,
  sampleRate = WAV_DEFAULT_RATE,
): Uint8Array {
  const perPulse = sampleRate / clockHz;
  const lead = Math.round(LEAD_SECONDS * sampleRate);
  const hold = Math.max(1, Math.round(HOLD_SECONDS * sampleRate));

  let total = 0;
  for (let i = 0; i < pulses.length; i++) total += pulses[i];
  const length = lead * 2 + Math.round(total * perPulse) + 1;
  const samples = new Int16Array(length);

  const peak = Math.round(32767 * AMPLITUDE);
  let level = firstLevel ? 1 : 0;
  let t = 0;                                  // exact edge time, in samples
  let at = lead;                              // next sample to write
  for (let i = 0; i < pulses.length; i++) {
    t += pulses[i] * perPulse;
    const end = Math.min(lead + Math.round(t), length);
    const value = level ? peak : -peak;
    const holdEnd = Math.min(end, at + hold);
    for (; at < holdEnd; at++) samples[at] = value;
    at = end;                                 // the rest of a long pulse stays silent (0)
    level ^= 1;
  }
  return encodeWav16(samples, sampleRate);
}
