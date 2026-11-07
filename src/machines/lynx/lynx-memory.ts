/**
 * LynxMemory — the Camputers Lynx's banked 64K window.
 *
 * Two things make this machine unlike the others here:
 *
 *  - Writes and reads are decoded separately. A store goes to every bank whose
 *    write enable is set, all at once, so the ROM can paint one byte into red
 *    and blue in a single instruction. A read comes from one source, chosen by
 *    a different set of enable bits.
 *  - Reads fill the 64K from up to two sources: the bottom 24K can be ROM
 *    while the rest comes from RAM or video.
 *
 * The chips are modelled as the separate stores they are, rather than one
 * address space:
 *
 *   rom       64K   system ROM images, then the disk interface's ROM at 0xE000
 *   userRam   64K   the program's RAM
 *   videoRam        48K/96K: four 8K colour planes (blue, red, alt-green,
 *                   green). 128K: 64K holding four 16K planes (red, blue,
 *                   green, alt-green).
 *   extraRam  64K   128K only
 *
 * The 48K's video RAM is not decoded on A13 or A15, so a plane shows up at
 * every 8K step of its pair: A14 alone picks blue or red (or alt-green or
 * green). The two pairs are one "bank" each, chosen for reading by port 0x80.
 *
 * Each 8K slot of the CPU's address space holds a window onto one of those
 * stores; `applyBanks` recomputes the eight windows when a bank port changes.
 *
 * The bank-select rules come from MAME's `camplynx.cpp`, the only detailed
 * public description of the machine; see THIRD_PARTY.md.
 */

import { LYNX_PAGE_SIZE, LYNX_PAGES } from './constants.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { LynxModel } from './models.ts';

const PAGE = LYNX_PAGE_SIZE;

/** Offset of each ROM image inside the ROM store; the 96K and 128K use all three. */
export const ROM_IMAGE_BASES = [0x0000, 0x2000, 0x4000] as const;
/** The disk interface's ROM sits high in the ROM store, paged in over slot 7. */
export const DOS_ROM_OFFSET = 0xe000;

/** The four one-bit colour planes the display reads, as live views. */
export interface LynxPlanes {
  readonly red: Uint8Array;
  readonly green: Uint8Array;
  readonly altGreen: Uint8Array;
  readonly blue: Uint8Array;
}

/** What one 8K slot of the CPU's map currently shows. */
interface Window {
  readonly store: Uint8Array;
  readonly base: number;
  readonly label: string;
}

export class LynxMemory {
  readonly is128k: boolean;

  readonly rom = new Uint8Array(0x10000).fill(0xff);
  readonly userRam = new Uint8Array(0x10000);
  readonly videoRam: Uint8Array;
  readonly extraRam: Uint8Array | null;
  readonly planes: LynxPlanes;

  /** The 48K's two video banks, each a (low, high-in-A14) pair of planes. */
  private readonly videoBanks: readonly [readonly Uint8Array[], readonly Uint8Array[]];

  private readonly romWin: Window[] = [];
  private readonly userWin: Window[] = [];
  private readonly extraWin: Window[] = [];
  private map: Window[] = [];

  private bankData = 0;
  private port80 = 0;
  private port58 = 0;

  private writeUser = false;
  private writeVideoA = false;   // 48K: blue/red pair. 128K: the video bank.
  private writeVideoB = false;   // 48K only: the green pair.
  private writeExtra = false;    // 128K only

  private readonly ramBanks: Uint8Array[];

  constructor(model: LynxModel) {
    this.is128k = model === 'lynx128';

    if (this.is128k) {
      this.videoRam = new Uint8Array(0x10000);
      this.planes = {
        red: this.videoRam.subarray(0x0000, 0x4000),
        blue: this.videoRam.subarray(0x4000, 0x8000),
        green: this.videoRam.subarray(0x8000, 0xc000),
        altGreen: this.videoRam.subarray(0xc000, 0x10000),
      };
      this.extraRam = new Uint8Array(0x10000);
      this.videoBanks = [[], []];
    } else {
      this.videoRam = new Uint8Array(0x8000);
      this.planes = {
        blue: this.videoRam.subarray(0x0000, 0x2000),
        red: this.videoRam.subarray(0x2000, 0x4000),
        altGreen: this.videoRam.subarray(0x4000, 0x6000),
        green: this.videoRam.subarray(0x6000, 0x8000),
      };
      this.extraRam = null;
      this.videoBanks = [[this.planes.blue, this.planes.red], [this.planes.altGreen, this.planes.green]];
    }

    for (let p = 0; p < LYNX_PAGES; p++) {
      this.romWin.push({ store: this.rom, base: p * PAGE, label: `ROM ${p}` });
      this.userWin.push({ store: this.userRam, base: p * PAGE, label: `RAM ${p}` });
      if (this.extraRam) {
        this.extraWin.push({ store: this.extraRam, base: p * PAGE, label: `RAM ${p + 8}` });
      }
    }

    // 16K views for the Memory pane: user RAM, then video, then extra RAM.
    this.ramBanks = [];
    const addBanks = (store: Uint8Array): void => {
      for (let at = 0; at < store.length; at += 0x4000) this.ramBanks.push(store.subarray(at, at + 0x4000));
    };
    addBanks(this.userRam);
    addBanks(this.videoRam);
    if (this.extraRam) addBanks(this.extraRam);

    this.reset();
  }

  /**
   * Load the system ROM images at their own addresses. `images` are the 8K
   * parts in order; `dos` is the optional disk-interface ROM.
   */
  loadRoms(images: readonly Uint8Array[], dos?: Uint8Array | null): void {
    this.rom.fill(0xff);
    images.forEach((image, index) => {
      const at = ROM_IMAGE_BASES[index];
      if (at !== undefined) this.rom.set(image.subarray(0, PAGE), at);
    });
    if (dos) this.rom.set(dos.subarray(0, PAGE), DOS_ROM_OFFSET);
  }

  // ── Bank control ───────────────────────────────────────────────────────

  /** The bank port: 0x7F on the 48K/96K, 0x82 on the 128K. */
  writeBankPort(value: number): void {
    this.bankData = value & 0xff;
    this.applyBanks();
  }

  /** Port 0x80 — on the 48K/96K bits 2 and 3 join the bank decode. */
  setPort80(value: number): void {
    this.port80 = value & 0xff;
    if (!this.is128k) this.applyBanks();
  }

  /** Port 0x58 — the FDC latch, whose bit 4 pages RAM over the DOS ROM. */
  setPort58(value: number): void {
    this.port58 = value & 0xff;
    this.applyBanks();
  }

  /** Reset clears the bank port, which puts the ROM at the bottom for the CPU to start in. */
  reset(): void {
    this.bankData = 0;
    this.port80 = 0;
    this.port58 = 0;
    this.applyBanks();
  }

  private applyBanks(): void {
    this.map = this.is128k ? this.decode128() : this.decode48();
  }

  /**
   * 48K/96K. Bank port bits 0, 4 and 5 arrive inverted. Writes: bit 0 user
   * RAM, bit 1 the blue/red video pair, bit 2 the green pair, with port 0x80
   * bits 2 and 3 vetoing the pairs. Reads: bit 4 puts ROM at the bottom 24K,
   * bit 5 selects user RAM and bit 6 video for the rest, and port 0x80 picks
   * which video pair a read sees.
   */
  private decode48(): Window[] {
    const d = (this.bankData ^ 0x31) & 0xff;
    this.writeUser = (d & 0x01) !== 0;
    this.writeVideoA = (d & 0x02) !== 0 && (this.port80 & 0x04) === 0;
    this.writeVideoB = (d & 0x04) !== 0 && (this.port80 & 0x08) === 0;
    this.writeExtra = false;

    const romLow = (d & 0x10) !== 0;
    const wantUser = (d & 0x20) !== 0;
    const wantVideo = (d & 0x40) !== 0;
    const rom = this.romWin;

    if (wantVideo) {
      const pair = (this.port80 & 0x0c) === 0x04 ? 1 : 0;
      return Array.from({ length: LYNX_PAGES }, (_, s) =>
        s < 3 && romLow ? rom[s] : this.video48(pair, s));
    }

    if (wantUser) {
      const user = this.userWin;
      return Array.from({ length: LYNX_PAGES }, (_, s) => {
        if (s < 3) return romLow ? rom[s] : user[s];
        if (s < 7) return user[s];
        return (this.port58 & 0x10) !== 0 ? user[7] : rom[7];
      });
    }

    // Neither: the ROM, its first three pages repeated over the middle of the map.
    return [rom[0], rom[1], rom[2], rom[3], rom[0], rom[1], rom[2], rom[7]];
  }

  /**
   * 128K. The bank port is a write nibble on top and a read nibble below, each
   * bit-reversed; bits 7, 3 and 2 arrive inverted. Reads: bit 3 ROM at the
   * bottom 24K, bit 2 user RAM, bit 1 video, bit 0 extra RAM. Extra RAM drops
   * out when user RAM is selected (an AND gate in IC82), and user RAM loses to
   * video when both are asked for without the ROM.
   */
  private decode128(): Window[] {
    const c = (this.bankData ^ 0x8c) & 0xff;
    this.writeUser = (c & 0x80) !== 0;
    this.writeVideoA = (c & 0x40) !== 0;
    this.writeVideoB = false;
    this.writeExtra = (c & 0x10) !== 0;

    const romLow = (c & 0x08) !== 0;
    const user = (c & 0x04) !== 0;
    const video = (c & 0x02) !== 0;
    const extra = (c & 0x01) !== 0 && !user;
    const rom = this.romWin;

    let source: Window[] | null;
    if (user && !(video && !romLow)) source = this.userWin;
    else if (video) source = Array.from({ length: LYNX_PAGES }, (_, s) => this.video128(s));
    else if (extra) source = this.extraWin;
    else source = null;

    if (source === null) return rom.slice();
    return source.map((w, s) => {
      if (s < 3 && romLow) return rom[s];
      // User RAM sharing the map with ROM leaves the DOS ROM (or RAM over it) on top.
      if (s === 7 && source === this.userWin && romLow) {
        return (this.port58 & 0x10) !== 0 ? this.userWin[7] : rom[7];
      }
      return w;
    });
  }

  private video48(pair: number, slot: number): Window {
    const plane = (slot >> 1) & 1;
    const names = pair === 0 ? ['blue', 'red'] : ['alt green', 'green'];
    return { store: this.videoBanks[pair][plane], base: 0, label: `Video ${names[plane]}` };
  }

  private video128(slot: number): Window {
    const names = ['red', 'blue', 'green', 'alt green'];
    return { store: this.videoRam, base: slot * PAGE, label: `Video ${names[slot >> 1]}` };
  }

  // ── CPU access ─────────────────────────────────────────────────────────

  readByte(addr: number): number {
    const a = addr & 0xffff;
    const w = this.map[a >> 13];
    return w.store[w.base + (a & 0x1fff)];
  }

  /**
   * A store lands in every bank enabled for writing. On the 48K/96K each video
   * pair ignores A13 and A15, so the plane is picked by A14 and the offset is
   * the low thirteen bits; the 128K decodes its 64K video bank in full.
   */
  writeByte(addr: number, value: number): void {
    const a = addr & 0xffff;
    const v = value & 0xff;

    if (this.writeUser) this.userRam[a] = v;

    if (this.is128k) {
      if (this.writeVideoA) this.videoRam[a] = v;
      if (this.writeExtra) this.extraRam![a] = v;
      return;
    }
    if (this.writeVideoA) this.videoBanks[0][(a >> 14) & 1][a & 0x1fff] = v;
    if (this.writeVideoB) this.videoBanks[1][(a >> 14) & 1][a & 0x1fff] = v;
  }

  // ── Introspection ──────────────────────────────────────────────────────

  /** What each 8K slot of the CPU's map reads from, for the memory pane. */
  get slotLabels(): readonly string[] { return this.map.map(w => w.label); }

  /** Which banks a store currently lands in, for the memory pane. */
  get writeTargets(): readonly string[] {
    const out: string[] = [];
    if (this.writeUser) out.push('RAM');
    if (this.writeVideoA) out.push(this.is128k ? 'video' : 'blue/red');
    if (this.writeVideoB) out.push('green');
    if (this.writeExtra) out.push('extra RAM');
    return out;
  }

  /** The 8K DOS ROM image, for the Memory pane's `rom-dos` region. */
  get dosRom(): Uint8Array {
    return this.rom.subarray(DOS_ROM_OFFSET, DOS_ROM_OFFSET + PAGE);
  }

  // ── IMachineMemory ─────────────────────────────────────────────────────

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte(addr + i);
    return out;
  }

  /** The 64K the CPU can currently see, flattened. */
  snapshot(): Uint8Array { return this.readBlock(0, 0x10000); }

  /** Every RAM chip back to back — user RAM, video RAM, then the 128K's extra
   *  RAM (not the ROM) — as a copy, for the raw `.bin` save. */
  ramSnapshot(): Uint8Array {
    const parts = [this.userRam, this.videoRam, ...(this.extraRam ? [this.extraRam] : [])];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  /** A 16K view of RAM: user RAM first, then video, then extra RAM. */
  getRamBank(n: number): Uint8Array {
    return this.ramBanks[Math.min(Math.max(n, 0), this.ramBanks.length - 1)];
  }

  get ramBankCount(): number { return this.ramBanks.length; }

  // ── Snapshot state ─────────────────────────────────────────────────────

  /** Every RAM chip and the three latches the bank decode is built from (the
   *  ROM is not state). */
  saveState(w: StateWriter): void {
    w.raw(this.userRam);
    w.raw(this.videoRam);
    if (this.extraRam) w.raw(this.extraRam);
    w.u8(this.bankData); w.u8(this.port80); w.u8(this.port58);
  }

  /** The caller has checked the model (and so the RAM sizes) match. */
  loadState(r: StateReader): void {
    r.rawInto(this.userRam);
    r.rawInto(this.videoRam);
    if (this.extraRam) r.rawInto(this.extraRam);
    this.bankData = r.u8(); this.port80 = r.u8(); this.port58 = r.u8();
    this.applyBanks();
  }
}
