/**
 * SamMemory — SAM Coupé paged memory.
 *
 * The Z80's address space is four 16K "sections" (the SAM's own name for them),
 * each backed by one 16K page. Like the CPC — and unlike the Spectrum — ROM
 * overlays RAM, and reads and writes can come from different places, so this
 * uses the CPC's per-section read/write pointer model rather than a flat 64K
 * buffer that gets re-copied on every bank switch:
 *
 *   read8(addr)       = readPtr[addr >> 14][addr & 0x3FFF]
 *   write8(addr, val) = writePtr[addr >> 14][addr & 0x3FFF]
 *
 * SAM software re-pages far more often than a 128K Spectrum, so an O(1) pointer
 * swap per register write matters.
 *
 * The paging function is transcribed from SimCoupe's `UpdatePaging()`:
 *
 *   Section A (0000-3FFF): ROM 0 unless LMPR_ROM0_OFF, else page (lmpr & 0x1F)
 *   Section B (4000-7FFF): page ((lmpr + 1) & 0x1F)          -- always RAM
 *   Section C (8000-BFFF): external[lepr] if HMPR_MCNTRL, else page (hmpr & 0x1F)
 *   Section D (C000-FFFF): external[hepr] if HMPR_MCNTRL,
 *                          else ROM 1 if LMPR_ROM1,
 *                          else page ((hmpr + 1) & 0x1F)
 *
 * Two details are easy to get wrong and are covered by tests:
 *
 *  - `(page + 1) & 0x1F` **wraps inside the 5-bit field**. It is not `page | 1`.
 *    With LMPR = 0x3F, section B maps page 0, not page 32.
 *  - With HMPR_MCNTRL set on a machine with no megabyte interface fitted,
 *    sections C/D must read **open bus (0xFF)** and swallow writes. Software
 *    probes for the interface exactly this way, so falling through to internal
 *    RAM would make every SAM report a megabyte.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { SamConfig } from './config.ts';
import {
  HMPR_MCNTRL, HMPR_PAGE_MASK,
  LMPR_PAGE_MASK, LMPR_ROM0_OFF, LMPR_ROM1, LMPR_WPROT,
  SAM_PAGE_SIZE, SAM_ROM_SIZE,
  VMPR_MODE_MASK, VMPR_MODE_SHIFT, VMPR_PAGE_MASK,
} from './constants.ts';

/** What a section's CPU reads resolve to, for the memory-layout pane. */
export type SamSectionSource =
  | { readonly kind: 'ram'; readonly page: number }
  | { readonly kind: 'external'; readonly page: number }
  | { readonly kind: 'rom'; readonly index: 0 | 1 }
  | { readonly kind: 'absent' };

/** Structured paging snapshot for the Banks pane and tests. */
export interface SamPagingState {
  readonly lmpr: number;
  readonly hmpr: number;
  readonly vmpr: number;
  readonly lepr: number;
  readonly hepr: number;
  /** Read source of each 16K section, low to high. */
  readonly sections: readonly SamSectionSource[];
  /** True when the section's writes are discarded (ROM or write-protected). */
  readonly readOnly: readonly boolean[];
  readonly writeProtected: boolean;
  readonly externalPaged: boolean;
  /** Video page and screen mode currently selected by VMPR. */
  readonly videoPage: number;
  readonly videoMode: 1 | 2 | 3 | 4;
}

/** Copy `src` into a fresh 16K page, zero-padded or truncated as needed. The
 *  copy matters: the ROM halves must not alias the caller's buffer. */
function padToPage(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(SAM_PAGE_SIZE);
  out.set(src.subarray(0, Math.min(src.length, SAM_PAGE_SIZE)));
  return out;
}

export class SamMemory implements IMachineMemory {
  private readonly cfg: SamConfig;

  /** Internal 16K pages (16 on a 256K machine, 32 on a 512K). */
  private readonly ram: Uint8Array[] = [];
  /** External megabyte pages; empty unless the interface is fitted. */
  private readonly ext: Uint8Array[] = [];

  /** Low and high halves of the 32K system ROM. */
  private rom0: Uint8Array = new Uint8Array(SAM_PAGE_SIZE);
  private rom1: Uint8Array = new Uint8Array(SAM_PAGE_SIZE);

  /** Sink for writes that hardware discards (ROM overlay, write-protect,
   *  absent external memory). Never read back. */
  private readonly scratch = new Uint8Array(SAM_PAGE_SIZE);
  /** Open bus — what an unfitted external page reads as. */
  private readonly absent = new Uint8Array(SAM_PAGE_SIZE).fill(0xFF);

  private readonly readPtr: Uint8Array[] = new Array(4);
  private readonly writePtr: Uint8Array[] = new Array(4);
  /**
   * The RAM (or external page) backing each section, regardless of any ROM
   * overlay or write-protection. `readPtr` shows what the CPU reads and
   * `writePtr` where its writes land; this is what is physically underneath,
   * which is what the BASIC viewer needs when ROM is paged over the program.
   */
  private readonly ramPtr: Uint8Array[] = new Array(4);

  /** Read source per section, kept in step with readPtr for the Banks pane. */
  private readonly sources: SamSectionSource[] = [
    { kind: 'absent' }, { kind: 'absent' }, { kind: 'absent' }, { kind: 'absent' },
  ];
  private readonly readOnly = [false, false, false, false];

  /**
   * True when a section is backed by internal RAM, which is the memory the
   * ASIC contends for. ROM, external RAM and the scratch page are uncontended.
   * Recomputed by `applyPaging` so the hot path can test it with one index.
   */
  readonly sectionContended = new Uint8Array(4);

  // ── Paging registers ──────────────────────────────────────────────────────
  lmpr = 0;
  hmpr = 0;
  vmpr = 0;
  lepr = 0;
  hepr = 0;

  constructor(cfg: SamConfig) {
    this.cfg = cfg;
    for (let i = 0; i < cfg.internalPages; i++) this.ram.push(new Uint8Array(SAM_PAGE_SIZE));
    for (let i = 0; i < cfg.externalPages; i++) this.ext.push(new Uint8Array(SAM_PAGE_SIZE));
    this.applyPaging();
  }

  // ── ROM loading ───────────────────────────────────────────────────────────

  /**
   * Install the 32K system ROM. The low half becomes ROM 0 (over section A),
   * the high half ROM 1 (over section D). A short image is zero-padded; a long
   * one is truncated, so a mis-sized drop degrades rather than throwing.
   */
  loadRom(data: Uint8Array): void {
    const full = new Uint8Array(SAM_ROM_SIZE);
    full.set(data.subarray(0, Math.min(data.length, SAM_ROM_SIZE)));
    this.rom0 = padToPage(full.subarray(0, SAM_PAGE_SIZE));
    this.rom1 = padToPage(full.subarray(SAM_PAGE_SIZE, SAM_ROM_SIZE));
    this.applyPaging();
  }

  /** Live 16K view of ROM 0 / ROM 1, for the Memory pane's region picker. */
  getRom(index: 0 | 1): Uint8Array {
    return index === 0 ? this.rom0 : this.rom1;
  }

  // ── Paging ────────────────────────────────────────────────────────────────

  setLmpr(val: number): void { this.lmpr = val & 0xFF; this.applyPaging(); }
  setHmpr(val: number): void { this.hmpr = val & 0xFF; this.applyPaging(); }
  setLepr(val: number): void { this.lepr = val & 0xFF; this.applyPaging(); }
  setHepr(val: number): void { this.hepr = val & 0xFF; this.applyPaging(); }
  /** VMPR selects the display page and mode; it does not affect CPU paging, so
   *  no remap is needed — the ASIC samples it directly. */
  setVmpr(val: number): void { this.vmpr = val & 0xFF; }

  /** True when internal page `n` is actually fitted. */
  private fitted(n: number): boolean { return n < this.cfg.internalPages; }

  /**
   * Read source for internal page `n`. An unfitted page reads **open bus**
   * (0xFF); it does NOT alias a fitted one.
   *
   * This is not a guess: the SAM ROM sizes memory by paging each candidate
   * page into section C, writing 0xFF and reading it back, then writing 0x00
   * and reading that back. An aliasing model passes both checks and every
   * machine reports 512K — a 256K SAM would announce itself as 512K, which it
   * plainly does not. Open bus fails the second check, which is what makes the
   * ROM stop at the right size.
   */
  private internalRead(n: number): Uint8Array {
    return this.fitted(n) ? this.ram[n] : this.absent;
  }

  /** Write target for internal page `n`; writes to an unfitted page are lost. */
  private internalWrite(n: number): Uint8Array {
    return this.fitted(n) ? this.ram[n] : this.scratch;
  }

  private applyPaging(): void {
    const { lmpr, hmpr } = this;
    const wprot = (lmpr & LMPR_WPROT) !== 0;
    const external = (hmpr & HMPR_MCNTRL) !== 0;

    // ── Section A (0000-3FFF) ──
    const pageA = lmpr & LMPR_PAGE_MASK;
    const rom0In = (lmpr & LMPR_ROM0_OFF) === 0;
    if (rom0In) {
      this.readPtr[0] = this.rom0;
      this.sources[0] = { kind: 'rom', index: 0 };
    } else {
      this.readPtr[0] = this.internalRead(pageA);
      this.sources[0] = this.fitted(pageA)
        ? { kind: 'ram', page: pageA } : { kind: 'absent' };
    }
    // Writes are discarded over ROM and under write-protect alike.
    this.readOnly[0] = rom0In || wprot || !this.fitted(pageA);
    this.ramPtr[0] = this.internalRead(pageA);
    this.writePtr[0] = this.readOnly[0] ? this.scratch : this.internalWrite(pageA);
    this.sectionContended[0] = !rom0In && this.fitted(pageA) ? 1 : 0;

    // ── Section B (4000-7FFF) — always internal RAM ──
    // NOTE the wrap: (lmpr + 1) & 0x1F, so LMPR page 31 maps page 0 here.
    const pageB = (pageA + 1) & LMPR_PAGE_MASK;
    this.readPtr[1] = this.internalRead(pageB);
    this.sources[1] = this.fitted(pageB)
      ? { kind: 'ram', page: pageB } : { kind: 'absent' };
    // LMPR bit 7 write-protects the whole low 32K, section B included.
    this.readOnly[1] = wprot || !this.fitted(pageB);
    this.ramPtr[1] = this.internalRead(pageB);
    this.writePtr[1] = this.readOnly[1] ? this.scratch : this.internalWrite(pageB);
    this.sectionContended[1] = this.fitted(pageB) ? 1 : 0;

    // ── Section C (8000-BFFF) ──
    const pageC = hmpr & HMPR_PAGE_MASK;
    if (external) {
      this.mapExternal(2, this.lepr);
    } else {
      this.ramPtr[2] = this.internalRead(pageC);
      this.readPtr[2] = this.ramPtr[2];
      this.writePtr[2] = this.internalWrite(pageC);
      this.sources[2] = this.fitted(pageC)
        ? { kind: 'ram', page: pageC } : { kind: 'absent' };
      this.readOnly[2] = !this.fitted(pageC);
      this.sectionContended[2] = this.fitted(pageC) ? 1 : 0;
    }

    // ── Section D (C000-FFFF) ──
    // External memory wins over ROM 1, which wins over internal RAM.
    if (external) {
      this.mapExternal(3, this.hepr);
    } else {
      // NOTE the same wrap as section B: (hmpr + 1) & 0x1F.
      const pageD = (pageC + 1) & HMPR_PAGE_MASK;
      this.ramPtr[3] = this.internalRead(pageD);
      if (lmpr & LMPR_ROM1) {
        this.readPtr[3] = this.rom1;
        this.writePtr[3] = this.scratch;
        this.sources[3] = { kind: 'rom', index: 1 };
        this.readOnly[3] = true;
        this.sectionContended[3] = 0;
      } else {
        this.readPtr[3] = this.ramPtr[3];
        this.writePtr[3] = this.internalWrite(pageD);
        this.sources[3] = this.fitted(pageD)
          ? { kind: 'ram', page: pageD } : { kind: 'absent' };
        this.readOnly[3] = !this.fitted(pageD);
        this.sectionContended[3] = this.fitted(pageD) ? 1 : 0;
      }
    }
  }

  /** Map one section to an external megabyte page, or to open bus when the
   *  interface isn't fitted. External RAM sits outside the ASIC's contention. */
  private mapExternal(section: number, page: number): void {
    this.sectionContended[section] = 0;
    if (this.cfg.externalPages === 0) {
      this.ramPtr[section] = this.absent;
      this.readPtr[section] = this.absent;
      this.writePtr[section] = this.scratch;
      this.sources[section] = { kind: 'absent' };
      this.readOnly[section] = true;
      return;
    }
    const p = page % this.cfg.externalPages;
    this.ramPtr[section] = this.ext[p];
    this.readPtr[section] = this.ext[p];
    this.writePtr[section] = this.ext[p];
    this.sources[section] = { kind: 'external', page: p };
    this.readOnly[section] = false;
  }

  // ── Video fetch ───────────────────────────────────────────────────────────

  /**
   * Live 16K view of an internal page for the ASIC's display fetch. The video
   * circuitry reads RAM directly and never sees CPU paging or the ROM overlays,
   * so this deliberately bypasses readPtr.
   */
  videoPage(page: number): Uint8Array {
    return this.internalRead(page);
  }

  /** Screen mode currently selected by VMPR (1-4, as the SAM numbers them). */
  get videoMode(): 1 | 2 | 3 | 4 {
    return (((this.vmpr & VMPR_MODE_MASK) >> VMPR_MODE_SHIFT) + 1) as 1 | 2 | 3 | 4;
  }

  /** Base display page. Modes 3 and 4 need 24K, so they span a page pair and
   *  the low page bit is ignored by the hardware. */
  get videoBasePage(): number {
    const page = this.vmpr & VMPR_PAGE_MASK;
    return this.videoMode >= 3 ? (page & ~1) : page;
  }

  // ── IMachineMemory ────────────────────────────────────────────────────────

  readByte(addr: number): number {
    addr &= 0xFFFF;
    return this.readPtr[addr >>> 14][addr & 0x3FFF];
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    this.writePtr[addr >>> 14][addr & 0x3FFF] = val & 0xFF;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let s = 0; s < 4; s++) out.set(this.readPtr[s], s * SAM_PAGE_SIZE);
    return out;
  }

  /** The 64K of RAM physically beneath the current mapping, ignoring ROM
   *  overlays and write-protection. Used by the BASIC viewer, which must not
   *  read ROM where RAM holds the program. */
  ramSnapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let s = 0; s < 4; s++) out.set(this.ramPtr[s], s * SAM_PAGE_SIZE);
    return out;
  }

  getRamBank(n: number): Uint8Array {
    return this.ram[n] ?? this.ram[0];
  }

  /** Every internal page concatenated — the RAM export. */
  allRam(): Uint8Array {
    const out = new Uint8Array(this.cfg.internalPages * SAM_PAGE_SIZE);
    for (let i = 0; i < this.cfg.internalPages; i++) out.set(this.ram[i], i * SAM_PAGE_SIZE);
    return out;
  }

  reset(): void {
    this.lmpr = 0;
    this.hmpr = 0;
    this.vmpr = 0;
    this.lepr = 0;
    this.hepr = 0;
    this.applyPaging();
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  pagingState(): SamPagingState {
    return {
      lmpr: this.lmpr,
      hmpr: this.hmpr,
      vmpr: this.vmpr,
      lepr: this.lepr,
      hepr: this.hepr,
      sections: this.sources.slice(),
      readOnly: this.readOnly.slice(),
      writeProtected: (this.lmpr & LMPR_WPROT) !== 0,
      externalPaged: (this.hmpr & HMPR_MCNTRL) !== 0,
      videoPage: this.videoBasePage,
      videoMode: this.videoMode,
    };
  }
}
