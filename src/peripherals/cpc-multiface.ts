/**
 * Multiface Two (Romantic Robot) — Amstrad CPC freeze/toolkit cartridge.
 *
 * 8KB ROM + 8KB RAM, held in one persistent 16KB buffer overlaid into slot 0
 * when paged in:  ROM 0x0000-0x1FFF (NMI vector 0x0066), RAM 0x2000-0x3FFF.
 *
 * Paging is OUT-triggered (the CPC MF2 is write-decoded, unlike the Spectrum
 * Multiface which is IN-triggered):
 *   OUT &FEE8 → page in,  OUT &FEEA → page out   (data ignored; bit 0 don't-care,
 *   bit 1 selects in/out, the rest decode the &FEE8 base).
 *
 * The red STOP button pages the cartridge in and fires an NMI into the toolkit
 * at 0x0066.
 *
 * I/O snooping (recordOut): the Gate Array, CRTC, upper-ROM-select and PPI
 * control registers are WRITE-ONLY, so the MF2 cannot read the machine state
 * back when you stop a program. Instead its PAL continuously records every OUT
 * into fixed offsets of its RAM, and the toolkit's "Return" reprograms the chips
 * from that shadow. Without this, Return restores garbage (wrong video mode /
 * RAM config) and the CPC crashes. Offsets match the real hardware (as used by
 * Caprice32): pen-select 0x3FCF, colour 0x3F90|pen (border 0x3FD0), mode/RMR
 * 0x3FEF, RAM config 0x3FFF, CRTC select 0x3CFF, CRTC data 0x3DB0|reg, upper-ROM
 * 0x3AAC, PPI control 0x37FF — all within the 8KB RAM half (>= 0x2000).
 */

import type { Z80 } from '@/cores/z80.ts';
import type { CpcMemory } from '@/cpc/cpc-memory.ts';

const ROM_SIZE = 8192;

export class CpcMultiface {
  enabled = false;
  pagedIn = false;
  romLoaded = false;

  /** Pristine 8KB ROM image, re-laid into the buffer's ROM half on each page-in. */
  private readonly romImage = new Uint8Array(ROM_SIZE);
  /** Live 16KB buffer mapped into slot 0 when paged in: [ROM 8KB | RAM 8KB].
   *  The RAM half (0x2000-0x3FFF) is persistent — it holds both the toolkit's
   *  scratch RAM and the recorded I/O shadow. */
  private readonly buf = new Uint8Array(16384);
  /** Gate-Array pen currently selected, tracked for the colour shadow offset. */
  private mfPen = 0;

  reset(): void {
    this.pagedIn = false;
    this.buf.fill(0, 0x2000); // clear the RAM/shadow half; keep the ROM half
    this.mfPen = 0;
  }

  loadROM(data: Uint8Array): void {
    this.romImage.set(data.subarray(0, ROM_SIZE));
    this.buf.set(this.romImage, 0);
    this.romLoaded = true;
  }

  /** Overlay MF2 ROM+RAM into slot 0. */
  pageIn(memory: CpcMemory): void {
    if (this.pagedIn) return;
    this.buf.set(this.romImage, 0); // refresh ROM half (undo any stray writes)
    memory.setSlot0Overlay(this.buf);
    this.pagedIn = true;
  }

  /** Remove the overlay. The buffer (incl. RAM writes) persists. */
  pageOut(memory: CpcMemory): void {
    if (!this.pagedIn) return;
    memory.clearSlot0Overlay();
    this.pagedIn = false;
  }

  /** Press the red STOP button: page in, then NMI into the toolkit at 0x0066. */
  pressButton(memory: CpcMemory, cpu: Z80): void {
    if (!this.enabled || !this.romLoaded) return;
    this.pageIn(memory);
    cpu.nmi();
  }

  /**
   * Decode an OUT port. &FEE8 = page in, &FEEA = page out; bit 0 is don't-care,
   * bit 1 selects in(0)/out(1), the upper bits must match the &FEE8 base.
   */
  matchPortOut(port: number): 'in' | 'out' | null {
    if ((port & 0xFFFC) !== 0xFEE8) return null;
    return (port & 0x02) ? 'out' : 'in';
  }

  /**
   * Snoop an OUT, recording write-only chip registers into the RAM shadow so the
   * toolkit's "Return" can reconstruct the machine state. Called for every OUT
   * while the cartridge is present (independent of paged-in state).
   */
  recordOut(port: number, val: number): void {
    port &= 0xFFFF;
    val &= 0xFF;
    const buf = this.buf;

    // Gate Array / RAM banking: A15=0, A14=1 (&7Fxx). Sub-function in bits 7-6.
    if ((port & 0xC000) === 0x4000) {
      switch (val & 0xC0) {
        case 0x00: // pen select
          this.mfPen = (val & 0x10) ? 0x10 : (val & 0x0f);
          buf[0x3fcf] = val;
          break;
        case 0x40: // pen / border colour (for the currently selected pen)
          buf[0x3f90 | ((this.mfPen & 0x10) << 2) | (this.mfPen & 0x0f)] = val;
          break;
        case 0x80: // screen mode + ROM enable (RMR)
          buf[0x3fef] = val;
          break;
        case 0xC0: // RAM configuration
          buf[0x3fff] = val;
          break;
      }
    }

    // CRTC: A14=0, A13=1 (&BCxx select / &BDxx data).
    if ((port & 0x6000) === 0x2000) {
      const fn = (port >> 8) & 3;
      if (fn === 0) buf[0x3cff] = val;                       // register select
      else if (fn === 1) buf[0x3db0 | (buf[0x3cff] & 0x0f)] = val; // register data
    }

    // Upper ROM select: A13=0 (&DFxx).
    if ((port & 0x2000) === 0) buf[0x3aac] = val;

    // PPI control: A11=0, function 3 (&F7xx).
    if ((port & 0x0800) === 0 && ((port >> 8) & 3) === 3) buf[0x37ff] = val;
  }
}
