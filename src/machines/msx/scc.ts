/**
 * Konami SCC (K051649) — the wavetable sound chip inside Konami's SCC mega-ROM
 * cartridges (Gradius 2, Salamander, Parodius, …). It only ever shipped on MSX
 * cartridges here, so it lives with the MSX rather than in `src/cores/`.
 *
 * Five channels, each playing a 32-sample waveform of signed 8-bit values in a
 * loop. Per channel: a 12-bit period TP, giving
 *
 *     f = fclock / (32 × (TP + 1)),   fclock = 3.579545 MHz (the MSX clock)
 *
 * a 4-bit volume (0 = silent … 15) and an on/off bit. On the original SCC the
 * fourth and fifth channels share one waveform (the SCC+ gave each its own).
 *
 * Register window (offset within each 256-byte block of 9800h–9FFFh — A8–A10
 * are not decoded, so 9900h, 9A00h … mirror 9800h):
 *
 *   00–1F  waveform, channel 1        read/write (behaves as RAM)
 *   20–3F  waveform, channel 2        read/write
 *   40–5F  waveform, channel 3        read/write
 *   60–7F  waveform, channels 4 and 5 read/write
 *   80–89  period, channels 1–5 (low byte, then bits 8–11)     write only
 *   8A–8E  volume, channels 1–5 (bits 0–3)                     write only
 *   8F     on/off, bits 0–4 = channels 1–5                     write only
 *   90–9F  mirror of 80–8F                                     write only
 *   A0–DF  no function
 *   E0–FF  test ("deformation") register, one register         write only
 *
 * Write-only and unused locations read back 0xFF.
 *
 * Sources: Sean Young's SCC notes (register map, read/write behaviour, the
 * A8–A10 mirroring, the test register's pitch bits) and the MSX Wiki
 * "MegaROM Mappers" page (enable value, 9800h–98FFh layout).
 *
 * The test register. Konami games never write it, and its only description
 * is marked unverified by its author: bits 1–0 multiply every channel's
 * frequency (01 → ×256, 1x → ×16, 00 → normal) and bits 7–6 turn channels 4
 * and 5 into noise. The register is stored (and saved in snapshots) and the
 * pitch multiplier is applied as described; the noise modes are not modelled,
 * since nothing describes the noise they make.
 *
 * Output: the chip mixes the five channels as wave × volume into its DAC.
 * Here each channel contributes ±{@link CHANNEL_LEVEL} at full volume and full
 * waveform swing, so one SCC channel sits about as loud as one PSG tone. The
 * machine's mixer asks for one mono sample per output sample
 * ({@link generateSampleMono}); the generator advances by `clocksPerSample`
 * chip clocks each time and box-averages the waveform steps it passes over,
 * which keeps periods shorter than an output sample from aliasing.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/** Peak contribution of one channel at volume 15 and waveform value ±128. */
const CHANNEL_LEVEL = 0.2;
const CHANNELS = 5;
const WAVE_LEN = 32;

export class Scc {
  /** The five channels' waveforms as they play (32 signed samples each). On
   *  the original SCC channel 5 has no waveform of its own: writes to 60–7F
   *  land in both channel 4's and channel 5's copy. */
  readonly wave = new Int8Array(CHANNELS * WAVE_LEN);
  /** 12-bit periods (TP) as written. */
  readonly period = new Uint16Array(CHANNELS);
  /** 4-bit volumes. */
  readonly volume = new Uint8Array(CHANNELS);
  /** On/off bits, bit n = channel n+1. */
  enable = 0;
  /** The test ("deformation") register. */
  deform = 0;

  /** Chip clocks per output sample (the mixer's CPU T-states per sample: the
   *  SCC runs from the cartridge slot's 3.58 MHz clock). */
  clocksPerSample = 3_579_545 / 44_100;

  /** Waveform position (0..31) and clocks left until the next step. */
  private readonly pos = new Uint8Array(CHANNELS);
  private readonly count = new Float64Array(CHANNELS);

  reset(): void {
    this.wave.fill(0);
    this.period.fill(0);
    this.volume.fill(0);
    this.enable = 0;
    this.deform = 0;
    this.pos.fill(0);
    this.count.fill(0);
  }

  /** CPU read of register offset `reg` (0x00–0xFF within the window). */
  read(reg: number): number {
    reg &= 0xFF;
    // 00–7F read back as RAM; channel 4's copy stands for the shared 60–7F.
    if (reg < 0x80) return this.wave[reg] & 0xFF;
    return 0xFF;
  }

  /** CPU write of register offset `reg` (0x00–0xFF within the window). */
  write(reg: number, val: number): void {
    reg &= 0xFF;
    val &= 0xFF;
    const s = val << 24 >> 24;
    if (reg < 0x60) {
      this.wave[reg] = s;
    } else if (reg < 0x80) {
      // Channels 4 and 5 share this waveform.
      this.wave[reg] = s;
      this.wave[reg + WAVE_LEN] = s;
    } else if (reg < 0xA0) {
      const r = reg & 0x0F;   // 90–9F mirror 80–8F
      if (r < 0x0A) {
        const ch = r >> 1;
        this.period[ch] = (r & 1)
          ? (this.period[ch] & 0x0FF) | ((val & 0x0F) << 8)
          : (this.period[ch] & 0xF00) | val;
      } else if (r < 0x0F) {
        this.volume[r - 0x0A] = val & 0x0F;
      } else {
        this.enable = val & 0x1F;
      }
    } else if (reg >= 0xE0) {
      this.deform = val;
    }
    // A0–DF: no function.
  }

  /** Frequency multiplier from the test register's bits 1–0. */
  private pitchMultiplier(): number {
    const p = this.deform & 3;
    return p === 0 ? 1 : p === 1 ? 256 : 16;
  }

  /** One mono output sample (the mixer's MonoAudioSource). */
  generateSampleMono(): number {
    const clocks = this.clocksPerSample;
    const mult = this.pitchMultiplier();
    let out = 0;
    for (let ch = 0; ch < CHANNELS; ch++) {
      const stepLen = (this.period[ch] + 1) / mult;
      let c = this.count[ch] - clocks;
      let p = this.pos[ch];
      const base = ch * WAVE_LEN;
      let level: number;
      if (c > 0) {
        level = this.wave[base + p];
      } else {
        // Steps taken this sample; average the samples passed over (all 32
        // when the waveform loops within one output sample).
        const n = Math.floor(-c / stepLen) + 1;
        c += n * stepLen;
        if (n >= WAVE_LEN) {
          let sum = 0;
          for (let i = 0; i < WAVE_LEN; i++) sum += this.wave[base + i];
          level = sum / WAVE_LEN;
          p = (p + n) & (WAVE_LEN - 1);
        } else {
          let sum = this.wave[base + p];
          for (let i = 0; i < n; i++) {
            p = (p + 1) & (WAVE_LEN - 1);
            sum += this.wave[base + p];
          }
          level = sum / (n + 1);
        }
      }
      this.count[ch] = c;
      this.pos[ch] = p;
      if (this.enable & (1 << ch)) out += level * this.volume[ch];
    }
    return out * (CHANNEL_LEVEL / (128 * 15));
  }

  /** The chip's registers and generator positions. */
  saveState(w: StateWriter): void {
    w.raw(new Uint8Array(this.wave.buffer, this.wave.byteOffset, this.wave.length));
    for (let ch = 0; ch < CHANNELS; ch++) w.u16(this.period[ch]);
    w.raw(this.volume);
    w.u8(this.enable);
    w.u8(this.deform);
    w.raw(this.pos);
    w.f64s(this.count);
  }

  loadState(r: StateReader): void {
    r.rawInto(new Uint8Array(this.wave.buffer, this.wave.byteOffset, this.wave.length));
    for (let ch = 0; ch < CHANNELS; ch++) this.period[ch] = r.u16() & 0xFFF;
    r.rawInto(this.volume);
    this.enable = r.u8() & 0x1F;
    this.deform = r.u8();
    r.rawInto(this.pos);
    for (let ch = 0; ch < CHANNELS; ch++) this.pos[ch] &= WAVE_LEN - 1;
    r.f64sInto(this.count);
  }
}
