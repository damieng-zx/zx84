/**
 * ZX Spectrum memory subsystem with 128K bank switching.
 *
 * The Z80's view of memory is a single flat 64KB Uint8Array (`_flat`), which
 * is also the source of truth for all CPU memory access. RAM banks not
 * currently mapped into a slot live in `_ramBanks[]` as cold storage.
 *
 * Bank switching is a 16KB copy: flush the live slot back to its cold bank,
 * then copy the incoming bank from cold into the flat. Cost ~5µs per switch;
 * the win is the hot path collapses from `slots[addr>>>14][addr&0x3FFF]`
 * (two array loads) to `flat[addr&0xFFFF]` (one array load), which dominates
 * memory access cost.
 *
 * For external readers that want a specific RAM bank (snapshot save, debug
 * tools, screen renderer), `getRamBank(n)` returns a live view: a subarray
 * of `_flat` if the bank is currently mapped, otherwise the cold storage.
 * Writes through the returned view go to the live memory either way.
 */

import type { SpectrumModel } from '@/models.ts';

/** Size of a single RAM bank or ROM page (16 KB). */
export const BANK_SIZE = 16_384;

/** Special paging all-RAM bank configurations (indexed by mode 0-3). */
const SPECIAL_MODES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [4, 5, 6, 3],
  [4, 7, 6, 3],
];

/**
 * Minimal interface for reading from the Z80 paged address space.
 * Implemented by SpectrumMemory; accepted by all debug and display tools.
 */
export interface ByteReader {
  readByte(addr: number): number;
  readBlock(addr: number, len: number): Uint8Array;
}

export class SpectrumMemory implements ByteReader {
  /** The Z80's flat 64KB view. Source of truth for all CPU memory access.
   *  Hot-path callers (io-ports.ts) capture this once and index directly. */
  readonly flat = new Uint8Array(0x10000);

  /** 8 × 16KB cold storage for unmapped RAM banks. When a bank is currently
   *  mapped (`_slotBank[s] === n`), the live data lives in flat — this array
   *  is stale until the bank is flushed back on switch. Use `getRamBank()`
   *  for an always-correct accessor. */
  private _ramBanks: Uint8Array[];

  /** ROM pages: 2 for 48K/128K/+2, 4 for +2A/+3 */
  romPages: Uint8Array[];

  /** Which bank is mapped in each slot. Values: 0-7 = RAM bank, -1 = ROM or
   *  external overlay (not flushed back on switch). */
  private _slotBank = new Int8Array(4).fill(-1);

  /** External overlay buffer set by setSlot0 (Multiface / VTX). Retained so
   *  restoreSlot0 can sync flat[0..0x4000] back to it before reloading. */
  private _overlayBuffer: Uint8Array | null = null;

  /** Current port 0x7FFD value */
  port7FFD = 0;

  /** Current port 0x1FFD value (+2A only) */
  port1FFD = 0;

  /** Whether paging is locked (bit 5 of 0x7FFD) */
  pagingLocked = false;

  /** Which RAM bank is paged in at 0xC000 */
  currentBank = 0;

  /** Which ROM page is active */
  currentROM = 0;

  /** True = 128K-class mode, false = 48K mode */
  is128K: boolean;

  /** True for the 16K Spectrum: slots 2/3 (0x8000-0xFFFF) are unpopulated. */
  is16K: boolean;

  /** True when +2A special all-RAM paging is active */
  specialPaging = false;

  /** True when an external peripheral (e.g. VTX-5000) has overridden slot 0.
   *  Suppresses ROM updates to slot 0 during bank switches. */
  externalRomPaged = false;

  /** Fires after every slot mapping change so external caches (notably the
   *  Contention slot mask) can refresh. Null when no listener is wired. */
  onSlotsChanged: (() => void) | null = null;

  constructor(model: SpectrumModel, opts?: { hasBanking?: boolean; romPageCount?: number; is16K?: boolean }) {
    this.is128K = opts?.hasBanking ?? (model !== '48k' && model !== '16k');
    this.is16K = opts?.is16K ?? (model === '16k');

    // Create 8 RAM banks (cold storage)
    this._ramBanks = [];
    for (let i = 0; i < 8; i++) {
      this._ramBanks.push(new Uint8Array(BANK_SIZE));
    }

    // Create ROM pages
    const romCount = opts?.romPageCount ?? (this.is128K ? 2 : 1);
    const allocCount = Math.max(2, romCount);
    this.romPages = [];
    for (let i = 0; i < allocCount; i++) {
      this.romPages.push(new Uint8Array(BANK_SIZE));
    }

    // Establish the initial slot mapping from the default paging state.
    // For 128K-class this is [ROM, bank 5, bank 2, bank 0]; for 48K the
    // same shape using the single ROM. For 16K, slots 2/3 are filled 0xFF
    // (open bus). Without this, bankAt/getRamBank/screenBank would all
    // report 'not mapped' until the first bankSwitch or applyBanking.
    this._resyncAllSlots();
  }

  // ── Paged memory access ───────────────────────────────────────────────

  /** Read one byte from the Z80 address space. */
  readByte(addr: number): number {
    return this.flat[addr & 0xFFFF];
  }

  /** Write one byte into the Z80 address space (no ROM protection — callers
   *  handle that; io-ports.ts gates writes before calling). */
  writeByte(addr: number, val: number): void {
    this.flat[addr & 0xFFFF] = val & 0xFF;
  }

  /** Read a block of bytes from the Z80 address space into a new Uint8Array. */
  readBlock(addr: number, len: number): Uint8Array {
    const result = new Uint8Array(len);
    for (let i = 0; i < len; i++) result[i] = this.flat[(addr + i) & 0xFFFF];
    return result;
  }

  /** Return a live view into a 16KB slot (always reflects current state). */
  getSlot(slot: number): Uint8Array {
    return this.flat.subarray(slot << 14, (slot + 1) << 14);
  }

  /**
   * True when slot 0 currently maps the 48K BASIC ROM (the one that contains
   * LD-BYTES / SA-BYTES). Used by tape ROM traps to verify we're really
   * about to execute the Spectrum's standard tape routine, not a custom
   * routine running from a RAM bank that happens to live at the same address.
   *
   * Page layout: the 48K BASIC ROM is always the LAST entry in romPages.
   *  - 16K/48K (1 page):       page 0
   *  - Ferranti 128/+2 (2):    page 1
   *  - Amstrad +2A/+3 (4):     page 3
   *
   * Returns false when special all-RAM paging is active (+2A/+3) or when an
   * external ROM (Multiface, VTX-5000) has been paged into slot 0.
   */
  isBasicRomActive(): boolean {
    if (this.specialPaging || this.externalRomPaged) return false;
    if (!this.is128K) return true;
    return this.currentROM === this.romPages.length - 1;
  }

  // ── Screen bank ───────────────────────────────────────────────────────

  /**
   * Return the 16KB RAM bank used for the current display.
   * Live view if mapped (almost always — bank 5 is in slot 1 in normal
   * paging), cold storage otherwise (bank 7 when not currently mapped).
   */
  get screenBank(): Uint8Array {
    const bank = (this.port7FFD & 0x08) ? 7 : 5;
    return this.getRamBank(bank);
  }

  // ── Slot management ───────────────────────────────────────────────────

  /**
   * Overlay slot 0 with an external buffer (Multiface / VTX-5000).
   *
   * Flushes the current slot 0 (if RAM) back to its cold bank, copies the
   * overlay into the flat, and remembers the overlay reference so
   * restoreSlot0 can sync CPU writes back to it.
   */
  setSlot0(overlay: Uint8Array): void {
    this._flushSlot(0);
    this.flat.set(overlay.subarray(0, BANK_SIZE), 0);
    this._overlayBuffer = overlay;
    this._slotBank[0] = -1;
    if (this.onSlotsChanged !== null) this.onSlotsChanged();
  }

  /**
   * Restore slot 0 from current paging state, syncing any CPU writes that
   * landed in flat[0..0x4000] back to the overlay buffer first so the
   * peripheral can extract them.
   */
  restoreSlot0(): void {
    if (this._overlayBuffer !== null) {
      this._overlayBuffer.set(this.flat.subarray(0, BANK_SIZE));
      this._overlayBuffer = null;
    }
    if (this.externalRomPaged) return; // external ROM manages its own slot 0
    if (this.specialPaging) {
      const bank = SPECIAL_MODES[(this.port1FFD >> 1) & 3][0];
      this._loadSlot(0, this._ramBanks[bank], bank);
    } else {
      this._loadSlot(0, this.romPages[this.currentROM], -1);
    }
    if (this.onSlotsChanged !== null) this.onSlotsChanged();
  }

  /** Flush the live contents of `slot` back to cold storage if it currently
   *  maps a RAM bank. No-op for ROM/overlay slots. */
  private _flushSlot(slot: number): void {
    const bank = this._slotBank[slot];
    if (bank < 0) return;
    this._ramBanks[bank].set(this.flat.subarray(slot << 14, (slot + 1) << 14));
  }

  /** Copy `src` into the flat at `slot`, recording the bank index (-1 for ROM/overlay). */
  private _loadSlot(slot: number, src: Uint8Array, bank: number): void {
    this.flat.set(src.subarray(0, BANK_SIZE), slot << 14);
    this._slotBank[slot] = bank;
  }

  /** Swap the bank mapped in `slot` to a new RAM bank, flushing old to cold
   *  if it was a RAM bank. Skips entirely if the bank is already mapped here.
   *
   *  If `newBank` is already live in another slot (bank aliasing — e.g.
   *  currentBank=5 maps bank 5 into both slot 1 and slot 3), source the new
   *  contents from that live slot rather than the (potentially stale) cold
   *  storage. This is correctness on map-in; subsequent writes through one
   *  aliased slot still won't reflect in the other (true write-through would
   *  require a write-hot-path branch), but that pattern is rare in practice. */
  private _switchRam(slot: number, newBank: number): void {
    if (this._slotBank[slot] === newBank) return;
    this._flushSlot(slot);
    let src: Uint8Array = this._ramBanks[newBank];
    for (let s = 0; s < 4; s++) {
      if (s !== slot && this._slotBank[s] === newBank) {
        src = this.flat.subarray(s << 14, (s + 1) << 14);
        break;
      }
    }
    this._loadSlot(slot, src, newBank);
  }

  /** Recompute every slot's contents from current paging state, flushing
   *  live RAM slots back to cold first. Use after changing paging registers
   *  without going through bankSwitch (e.g. after loadROM, special-paging
   *  exit cleanup). Safe to call mid-execution — live writes are preserved. */
  private _resyncAllSlots(): void {
    if (this.specialPaging) {
      const banks = SPECIAL_MODES[(this.port1FFD >> 1) & 3];
      if (!this.externalRomPaged) this._switchRam(0, banks[0]);
      this._switchRam(1, banks[1]);
      this._switchRam(2, banks[2]);
      this._switchRam(3, banks[3]);
    } else {
      if (!this.externalRomPaged) {
        this._flushSlot(0);
        const rom = this.is128K ? this.romPages[this.currentROM] : this.romPages[1];
        this._loadSlot(0, rom, -1);
      }
      this._switchRam(1, 5);
      if (this.is16K) {
        // Slots 2/3 unpopulated — leave flat as 0xFF (open bus). The write
        // gate in io-ports prevents writes from reaching it.
        this._flushSlot(2);
        this._flushSlot(3);
        this.flat.fill(0xFF, 0x8000, 0x10000);
        this._slotBank[2] = -1;
        this._slotBank[3] = -1;
      } else {
        this._switchRam(2, 2);
        this._switchRam(3, this.currentBank);
      }
    }
    if (this.onSlotsChanged !== null) this.onSlotsChanged();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  reset(): void {
    for (const bank of this._ramBanks) bank.fill(0);
    this.flat.fill(0);
    this.port7FFD = 0;
    this.port1FFD = 0;
    this.pagingLocked = false;
    this.currentBank = 0;
    this.currentROM = 0;
    this.specialPaging = false;
    this.externalRomPaged = false;
    // Force-reload all slots (mark unmapped so _switchRam's same-bank
    // shortcut doesn't fire on a live region that no longer matches cold).
    this._slotBank.fill(-1);
    this._overlayBuffer = null;
    this._resyncAllSlots();
  }

  /**
   * Load ROM data. 16KB = 48K ROM only. 32KB = 2 pages. 64KB = 4 pages (+2A).
   * Preserves live RAM contents — only slot 0 is rewritten (if it maps ROM).
   */
  loadROM(data: Uint8Array): void {
    if (data.length >= 65536 && this.romPages.length === 4) {
      for (let i = 0; i < 4; i++) {
        this.romPages[i].set(data.subarray(i * BANK_SIZE, (i + 1) * BANK_SIZE));
      }
    } else if (data.length >= 2 * BANK_SIZE && this.is128K) {
      this.romPages[0].set(data.subarray(0, BANK_SIZE));
      this.romPages[1].set(data.subarray(BANK_SIZE, 2 * BANK_SIZE));
    } else if (data.length >= BANK_SIZE) {
      this.romPages[1].set(data.subarray(0, BANK_SIZE));
      if (!this.is128K) {
        this.romPages[0].set(data.subarray(0, BANK_SIZE));
      }
    }
    // If slot 0 currently maps ROM, refresh it from the new ROM image.
    // RAM banks in slots 1-3 are untouched.
    if (!this.externalRomPaged && !this.specialPaging && this._slotBank[0] === -1) {
      const rom = this.is128K ? this.romPages[this.currentROM] : this.romPages[1];
      this.flat.set(rom.subarray(0, BANK_SIZE), 0);
    }
    if (this.onSlotsChanged !== null) this.onSlotsChanged();
  }

  // ── Port writes (O(1) per-slot bank swap) ─────────────────────────────

  /**
   * Handle port 0x7FFD write.
   * @param skipSlot0 Pass true when Multiface/VTX overlay occupies slot 0.
   */
  bankSwitch(val: number, skipSlot0 = false): void {
    if (!this.is128K || this.pagingLocked) return;

    const newBank = val & 0x07;

    let newROM: number;
    if (this.romPages.length === 4) {
      newROM = (((this.port1FFD >> 2) & 1) << 1) | ((val >> 4) & 1);
    } else {
      newROM = (val >> 4) & 1;
    }

    if (this.specialPaging) {
      // In special paging, 0x7FFD only latches — does not change slots.
      this.port7FFD = val;
      this.currentBank = newBank;
      this.currentROM = newROM;
      if (val & 0x20) this.pagingLocked = true;
      return;
    }
    this._switchRam(3, newBank);
    if (!skipSlot0 && !this.externalRomPaged && newROM !== this.currentROM) {
      // Slot 0 was ROM (or this method only runs when slot 0 is ROM here);
      // overwrite with new ROM image without flushing (ROM isn't dirtied).
      this.flat.set(this.romPages[newROM].subarray(0, BANK_SIZE), 0);
      this._slotBank[0] = -1;
    }

    this.port7FFD = val;
    this.currentBank = newBank;
    this.currentROM = newROM;
    if (val & 0x20) this.pagingLocked = true;
    if (this.onSlotsChanged !== null) this.onSlotsChanged();
  }

  /**
   * Handle port 0x1FFD write.
   * @param skipSlot0 Pass true when Multiface/VTX overlay occupies slot 0.
   */
  bankSwitch1FFD(val: number, skipSlot0 = false): void {
    if (!this.is128K || this.pagingLocked) return;

    this.port1FFD = val;
    const wasSpecial = this.specialPaging;
    this.specialPaging = (val & 1) !== 0;
    if (this.romPages.length === 4) {
      this.currentROM = (((val >> 2) & 1) << 1) | ((this.port7FFD >> 4) & 1);
    }

    if (this.specialPaging) {
      const banks = SPECIAL_MODES[(val >> 1) & 3];
      if (!skipSlot0 && !this.externalRomPaged) this._switchRam(0, banks[0]);
      this._switchRam(1, banks[1]);
      this._switchRam(2, banks[2]);
      this._switchRam(3, banks[3]);
    } else {
      // Exiting special paging (or staying in normal paging with ROM change).
      // Slot 0 reverts to ROM; slots 1/2/3 to bank 5/2/currentBank.
      if (!skipSlot0 && !this.externalRomPaged) {
        if (wasSpecial) this._flushSlot(0);  // slot 0 held a RAM bank
        this.flat.set(this.romPages[this.currentROM].subarray(0, BANK_SIZE), 0);
        this._slotBank[0] = -1;
      }
      this._switchRam(1, 5);
      this._switchRam(2, 2);
      this._switchRam(3, this.currentBank);
    }
    if (this.onSlotsChanged !== null) this.onSlotsChanged();
  }

  // ── Bulk operations (snapshots, reset, ROM load) ──────────────────────

  /**
   * Apply current paging state to slot mappings.
   *
   * Used by snapshot loaders after populating banks via setBankFromSnapshot
   * (which keeps live and cold in sync for already-mapped banks), and by
   * any caller that has changed paging registers (port7FFD, port1FFD,
   * specialPaging, currentROM, currentBank) directly.
   *
   * Live writes to flat are preserved: _switchRam flushes the old bank
   * back to cold before loading the new one. For banks that don't need
   * to change (same bank in same slot), it's a no-op.
   */
  applyBanking(): void {
    this._resyncAllSlots();
  }

  /**
   * Return all 8 RAM banks for serialisation. Returns live views (subarrays
   * of flat for mapped banks; cold storage otherwise) so post-call writes
   * through getRamBank reflect in the returned references.
   */
  flushBanks(): readonly Uint8Array[] {
    const result: Uint8Array[] = [];
    for (let n = 0; n < 8; n++) result.push(this.getRamBank(n));
    return result;
  }

  /**
   * Build a 64KB snapshot of the current paged address space.
   * Use for debug/display tools that need a plain Uint8Array view.
   * Not for CPU execution — use readByte/writeByte for that.
   */
  snapshot(): Uint8Array {
    return new Uint8Array(this.flat);
  }

  // ── Public bank accessors ─────────────────────────────────────────────

  /**
   * Write 16KB of snapshot data into a RAM bank.
   *
   * Writes to both cold storage and (if the bank is currently mapped) the
   * live flat memory, so the data is consistent regardless of whether
   * applyBanking is called next. Snapshot loaders typically call this for
   * every bank, then apply paging state, then call applyBanking() — which
   * just remaps slots; live and cold are already in sync.
   */
  setBankFromSnapshot(n: number, data: Uint8Array): void {
    const slice = data.subarray(0, BANK_SIZE);
    this._ramBanks[n].set(slice);
    for (let s = 0; s < 4; s++) {
      if (this._slotBank[s] === n) {
        this.flat.set(slice, s << 14);
      }
    }
  }

  /**
   * Return a RAM bank by index. If the bank is currently mapped into a slot,
   * returns a live view (subarray of flat) so writes propagate immediately.
   * Otherwise returns the cold storage (last written when the bank was last
   * unmapped, kept in sync by bankSwitch).
   */
  getRamBank(n: number): Uint8Array {
    for (let s = 0; s < 4; s++) {
      if (this._slotBank[s] === n) {
        return this.flat.subarray(s << 14, (s + 1) << 14);
      }
    }
    return this._ramBanks[n];
  }

  /**
   * Load raw 48K RAM (49152 bytes) into banks 5, 2, 0 and update slots.
   * Used by snapshot loaders.
   */
  load48KRAM(data: Uint8Array): void {
    this.setBankFromSnapshot(5, data.subarray(0, BANK_SIZE));               // 0x4000-0x7FFF
    this.setBankFromSnapshot(2, data.subarray(BANK_SIZE, 2 * BANK_SIZE));   // 0x8000-0xBFFF
    this.setBankFromSnapshot(0, data.subarray(2 * BANK_SIZE, 3 * BANK_SIZE)); // 0xC000-0xFFFF
    this.currentBank = 0;
    this._resyncAllSlots();
  }

  // ── Paging state helpers ──────────────────────────────────────────────

  /** RAM bank index at slot 0, or -1 when slot 0 holds ROM/overlay. */
  get slot0Bank(): number {
    return this._slotBank[0];
  }

  /** Return the RAM bank index actually paged at the given address.
   *  -1 means ROM or external overlay. */
  bankAt(addr: number): number {
    return this._slotBank[addr >>> 14];
  }
}
