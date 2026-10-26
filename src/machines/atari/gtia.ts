/**
 * GTIA — the Atari 8-bit colour and player/missile chip.
 *
 * ANTIC supplies the playfield as a stream of 2-bit colour indices and GTIA
 * turns that into the television signal: it owns the nine colour registers,
 * the four players and four missiles, their collision registers, the four
 * joystick trigger inputs and the console switches. It also generates the
 * 400/800's small internal speaker (CONSOL bit 3), which is why the family
 * has both a beeper and POKEY.
 *
 * Register map (write side; the read side is the collision/trigger bank):
 *
 *   $D000-$D003  HPOSP0-3       $D00D-$D010  GRAFP0-3
 *   $D004-$D007  HPOSM0-3       $D011        GRAFM
 *   $D008-$D00B  SIZEP0-3       $D012-$D015  COLPM0-3
 *   $D00C        SIZEM          $D016-$D019  COLPF0-3
 *   $D01A        COLBK          $D01B        PRIOR
 *   $D01C        VDELAY         $D01D        GRACTL
 *   $D01E        HITCLR         $D01F        CONSOL (console + speaker)
 *
 * Read side:
 *
 *   $D000-$D003  M0PF-M3PF      $D008-$D00B  M0PL-M3PL
 *   $D004-$D007  P0PF-P3PF      $D00C-$D00F  P0PL-P3PL
 *   $D010-$D013  TRIG0-3        $D014        PAL
 *   $D01F        CONSOL
 *
 * Priority resolution, collisions and VDELAY live in the renderer
 * (`atari-video.ts`), which sees every object pixel. GTIA's special modes
 * 9/10/11 (PRIOR bits 6-7) are not interpreted yet and fall back to normal
 * playfield colours.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

export class Gtia {
  /** COLPM0-3. */
  readonly colpm = new Uint8Array(4);
  /** COLPF0-3. */
  readonly colpf = new Uint8Array(4);
  /** COLBK. */
  colbk = 0;

  /** PRIOR: bits 0-3 player/playfield priority, 4 = 5th player, 5 =
   *  multicolour players, 6-7 = GTIA mode. */
  prior = 0;
  /** VDELAY: one bit per player. */
  vdelay = 0;
  /** GRACTL: bit 0 = missile DMA, bit 1 = player DMA. */
  gractl = 0;

  readonly hposp = new Uint8Array(4);
  readonly hposm = new Uint8Array(4);
  readonly sizep = new Uint8Array(4);
  sizem = 0;
  readonly grafp = new Uint8Array(4);
  grafm = 0;

  /** Joystick triggers, active low: 1 = released, 0 = pressed. */
  readonly trig = new Uint8Array([1, 1, 1, 1]);
  /** Console switches, active low (bit 0 START, 1 SELECT, 2 OPTION). */
  consol = 0x07;
  /** Internal speaker state, set by CONSOL bit 3 on a write. The OS parks
   *  it high; a click or tone is the bit *changing*. */
  speaker = false;
  /** Speaker transitions since the machine last cleared it (once a frame),
   *  for the BEEP activity LED. */
  speakerToggles = 0;
  /** The last value written to CONSOL's four lines: a 1 grounds a line. */
  consolWrite = 0;

  /** True on a PAL machine; read through $D014. */
  pal = false;

  /** The sixteen collision registers, cleared by HITCLR. */
  readonly hits = new Uint8Array(16);

  reset(): void {
    this.colpm.fill(0);
    this.colpf.fill(0);
    this.colbk = 0;
    this.prior = 0;
    this.vdelay = 0;
    this.gractl = 0;
    this.hposp.fill(0);
    this.hposm.fill(0);
    this.sizep.fill(0);
    this.sizem = 0;
    this.grafp.fill(0);
    this.grafm = 0;
    this.trig.fill(1);
    // CONSOL's inputs are the physical console keys, which a reset does not
    // release: an XL is booted without BASIC by holding OPTION through it.
    this.speaker = false;
    this.speakerToggles = 0;
    this.consolWrite = 0;
    this.hits.fill(0);
  }

  /** Snapshot: every register, the collision latches, triggers and console. */
  saveState(w: StateWriter): void {
    w.raw(this.colpm); w.raw(this.colpf); w.u8(this.colbk);
    w.u8(this.prior); w.u8(this.vdelay); w.u8(this.gractl);
    w.raw(this.hposp); w.raw(this.hposm); w.raw(this.sizep); w.u8(this.sizem);
    w.raw(this.grafp); w.u8(this.grafm);
    w.raw(this.trig); w.u8(this.consol); w.u8(this.consolWrite);
    w.bool(this.speaker);
    w.raw(this.hits);
  }

  loadState(r: StateReader): void {
    r.rawInto(this.colpm); r.rawInto(this.colpf); this.colbk = r.u8();
    this.prior = r.u8(); this.vdelay = r.u8(); this.gractl = r.u8();
    r.rawInto(this.hposp); r.rawInto(this.hposm); r.rawInto(this.sizep); this.sizem = r.u8();
    r.rawInto(this.grafp); this.grafm = r.u8();
    r.rawInto(this.trig); this.consol = r.u8(); this.consolWrite = r.u8();
    this.speaker = r.bool();
    r.rawInto(this.hits);
    this.speakerToggles = 0;
  }

  readReg(addr: number): number {
    const a = addr & 0x1F;
    if (a < 0x10) return this.hits[a];
    // TRIG0-3: only bit 0 is driven (1 = released); bits 1-7 read 0. The XL
    // OS compares TRIG3 as a whole byte with its GINTLK copy every VBI.
    if (a < 0x14) return this.trig[a - 0x10];
    if (a === 0x14) return this.pal ? 0x01 : 0x0F;
    // CONSOL reads 0000 SPK OPT SEL STA. A line written as 1 is grounded and
    // reads 0; the OS writes $08, so with no key down it reads $07. Games
    // compare the whole byte (CMP #$07, #$06...), so bits 4-7 must be 0.
    if (a === 0x1F) return ((this.consol & 0x07) | 0x08) & ~this.consolWrite & 0x0F;
    return 0xFF;
  }

  writeReg(addr: number, value: number): void {
    const a = addr & 0x1F;
    const v = value & 0xFF;
    if (a <= 0x03) { this.hposp[a] = v; return; }
    if (a <= 0x07) { this.hposm[a - 0x04] = v; return; }
    if (a <= 0x0B) { this.sizep[a - 0x08] = v; return; }
    switch (a) {
      case 0x0C: this.sizem = v; break;
      case 0x0D: case 0x0E: case 0x0F: case 0x10:
        this.grafp[a - 0x0D] = v;
        break;
      case 0x11: this.grafm = v; break;
      case 0x12: case 0x13: case 0x14: case 0x15:
        this.colpm[a - 0x12] = v & 0xFE; // colour registers hold no bit 0
        break;
      case 0x16: case 0x17: case 0x18: case 0x19:
        this.colpf[a - 0x16] = v & 0xFE;
        break;
      case 0x1A: this.colbk = v & 0xFE; break;
      case 0x1B: this.prior = v; break;
      case 0x1C: this.vdelay = v; break;
      case 0x1D: this.gractl = v; break;
      case 0x1E: this.hits.fill(0); break;
      case 0x1F: {
        this.consolWrite = v & 0x0F;
        const on = (v & 0x08) !== 0;
        if (on !== this.speaker) this.speakerToggles++;
        this.speaker = on;
        break;
      }
      default: break;
    }
  }

  /** What write register `a` ($00-$1D) currently holds (they cannot be read
   *  back over the bus; the line-write log needs the value a write replaces). */
  regValue(a: number): number {
    if (a <= 0x03) return this.hposp[a];
    if (a <= 0x07) return this.hposm[a - 0x04];
    if (a <= 0x0B) return this.sizep[a - 0x08];
    switch (a) {
      case 0x0C: return this.sizem;
      case 0x0D: case 0x0E: case 0x0F: case 0x10: return this.grafp[a - 0x0D];
      case 0x11: return this.grafm;
      case 0x12: case 0x13: case 0x14: case 0x15: return this.colpm[a - 0x12];
      case 0x16: case 0x17: case 0x18: case 0x19: return this.colpf[a - 0x16];
      case 0x1A: return this.colbk;
      case 0x1B: return this.prior;
      case 0x1C: return this.vdelay;
      case 0x1D: return this.gractl;
      default: return 0;
    }
  }

  /** Console switches, active-low bits (false = pressed). */
  setConsole(start: boolean, select: boolean, option: boolean): void {
    let v = 0x07;
    if (start) v &= ~0x01;
    if (select) v &= ~0x02;
    if (option) v &= ~0x04;
    this.consol = v;
  }

  setTrigger(index: number, pressed: boolean): void {
    if (index < 0 || index > 3) return;
    this.trig[index] = pressed ? 0 : 1;
  }

  get gtiaMode(): 0 | 9 | 10 | 11 {
    const m = (this.prior >> 6) & 0x03;
    return m === 0 ? 0 : (m === 1 ? 9 : m === 2 ? 10 : 11);
  }
}
