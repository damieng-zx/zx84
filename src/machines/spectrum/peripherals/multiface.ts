/**
 * Multiface peripheral — overlays 8KB ROM + 8KB RAM into slot 0 (0x0000-0x3FFF).
 *
 * Three variants:
 *   MF1   (48K)       — OUT 0x9F pages in, OUT 0x1F pages out
 *   MF128 (128K/+2)   — OUT 0xBF pages in, OUT 0x3F pages out
 *   MF3   (+2A/+3)    — OUT 0x3F pages in, OUT 0xBF pages out
 */

import type { SpectrumModel } from '@/machines/spectrum/spectrum.ts';
import type { Z80 } from '@/cores/z80.ts';
import type { SpectrumMemory } from '@/machines/spectrum/memory.ts';

export type MultifaceVariant = 'MF1' | 'MF128' | 'MF3';

export function variantForModel(model: SpectrumModel): MultifaceVariant {
  if (model === '16k' || model === '48k') return 'MF1';
  if (model === '+2A' || model === '+3') return 'MF3';
  return 'MF128';
}

export function variantLabel(variant: MultifaceVariant): string {
  if (variant === 'MF1') return 'Multiface 1';
  if (variant === 'MF128') return 'Multiface 128';
  return 'Multiface 3';
}

export function romFilename(variant: MultifaceVariant): string {
  if (variant === 'MF1') return 'sinclair/MF1.rom';
  if (variant === 'MF128') return 'sinclair/MF128.rom';
  return 'sinclair/MF3.rom';
}

export class Multiface {
  enabled = false;
  pagedIn = false;
  romLoaded = false;
  variant: MultifaceVariant = 'MF1';

  /** MF128/MF3 only: the button's NMI arms a hardware latch that makes the
   *  paging/latch-readback ports live. Without it a game's own stray IN/OUT
   *  to those (very common) port numbers would page the MF ROM in mid-game.
   *  Stays armed for the rest of the session once pressed — the ROM's own
   *  menu/tool routines legitimately page out and back in many times (e.g.
   *  borrowing the underlying ROM's HALT/keyboard-scan idle loop), so a
   *  page-out must NOT disarm it, or the ROM can never page itself back in
   *  and the machine hangs. Only a hardware reset clears it.
   *  MF1's narrower bit-mask decode means real MF1 hardware has no such
   *  latch — its ports are always live, so this flag isn't consulted for it. */
  armed = false;

  /** 8KB Multiface ROM (0x0000-0x1FFF when paged in) */
  mfRom = new Uint8Array(8192);
  /** 8KB Multiface RAM (0x2000-0x3FFF when paged in) */
  mfRam = new Uint8Array(8192);

  /** 16KB overlay placed in slot 0 when paged in: [mfRom | mfRam]. */
  private mfOverlay = new Uint8Array(16384);

  /** RAM bank that was at slot 0 when MF paged in (-1 = ROM). */
  savedSlot0Bank = -1;

  reset(): void {
    this.pagedIn = false;
    this.armed = false;
    this.mfRam.fill(0);
    this.savedSlot0Bank = -1;
  }

  loadROM(data: Uint8Array): void {
    this.mfRom.set(data.subarray(0, 8192));
    this.romLoaded = true;
  }

  /**
   * Overlay MF ROM+RAM into slot 0 by replacing the slot pointer.
   * @param slot0Bank RAM bank that was at slot 0 (-1 = ROM) for tracking.
   */
  pageIn(memory: SpectrumMemory, slot0Bank = -1): void {
    if (this.pagedIn) return;
    this.savedSlot0Bank = slot0Bank;
    // Build the 16KB overlay: [ROM 8KB | RAM 8KB]
    this.mfOverlay.set(this.mfRom, 0);
    this.mfOverlay.set(this.mfRam, 0x2000);
    memory.setSlot0(this.mfOverlay);
    this.pagedIn = true;
  }

  /**
   * Remove MF overlay: save any RAM writes from overlay, restore slot 0.
   */
  pageOut(memory: SpectrumMemory): void {
    if (!this.pagedIn) return;
    // CPU writes during overlay went into the live flat memory (slot 0).
    // Read the RAM half (0x2000-0x3FFF) directly from the live slot before
    // restoring, so any software modifications persist.
    this.mfRam.set(memory.getSlot(0).subarray(0x2000, 0x4000));
    memory.restoreSlot0();
    this.pagedIn = false;
  }

  /** Press the red button: arm the paging latch, page in, then trigger NMI.
   *  No-op while already paged in — the Z80's NMI is unconditional (it fires
   *  even mid-ROM), so a second press while the MF ROM is still running
   *  would push a second return address onto the game's stack. The ROM's
   *  own "Return" only unwinds one level, so the leftover entry would later
   *  get popped and jumped to after the ROM has already paged itself back
   *  out — running whatever garbage happens to be there. Real hardware has
   *  no legitimate use for a second press before the first session ends. */
  pressButton(memory: SpectrumMemory, cpu: Z80, slot0Bank = -1): void {
    if (!this.enabled || !this.romLoaded || this.pagedIn) return;
    this.armed = true;
    this.pageIn(memory, slot0Bank);
    cpu.nmi();
  }

  /** Check if a port IN matches a Multiface paging port.
   *  Returns 'in' for page-in, 'out' for page-out, null for no match. */
  matchPort(port: number): 'in' | 'out' | null {
    const lo = port & 0xFF;
    switch (this.variant) {
      case 'MF1':
        if ((lo & 0x22) !== 0x02) return null;
        if (lo === 0x9F) return 'in';
        if (lo === 0x1F) return 'out';
        return null;
      case 'MF128':
        if (lo === 0xBF) return 'in';
        if (lo === 0x3F) return 'out';
        return null;
      case 'MF3':
        if (lo === 0x3F) return 'in';
        if (lo === 0xBF) return 'out';
        return null;
    }
  }
}
