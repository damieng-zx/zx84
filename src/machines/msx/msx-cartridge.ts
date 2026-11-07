/**
 * MsxCartridge — what sits in the MSX cartridge slot (slot 1): a plain ROM, or
 * a mega-ROM behind one of the common bank mappers, with the battery-backed
 * SRAM some carry and the Konami SCC sound chip.
 *
 * The memory pager (`msx-memory.ts`) asks it for one 8KB read view per
 * segment of the Z80 address space (`seg`), routes reads of segments flagged
 * in `slow` through {@link read} (the SCC register window), and hands every
 * CPU write into slot 1 of a mega-ROM to {@link write}, which returns true
 * when the views changed so the pager can rebuild.
 *
 * Mapper behaviour follows the MSX Wiki "MegaROM Mappers" page:
 *
 *   ascii8      4 × 8KB banks at 4000/6000/8000/A000h, registers 6000h, 6800h,
 *               7000h, 7800h (each a 2KB window); power-on bank 0 everywhere.
 *   ascii8 SRAM the bank value's SRAM bit maps SRAM instead of ROM; SRAM is
 *               writable only at 8000h–BFFFh. 'ascii8-sram8' / '-sram32' use
 *               the first bit above the ROM's segment bits (Xanadu, 256KB:
 *               bit 5; the Koei titles); 'ascii8-sram8-b7' uses bit 7 (Royal
 *               Blood, Wizardry). In SRAM mode the low bits pick the 8KB SRAM
 *               block (32KB: bits 0–1).
 *   ascii16     2 × 16KB banks at 4000h/8000h, registers 6000h–67FFh and
 *               7000h–77FFh; power-on bank 0.
 *   ascii16 SRAM bit 4 selects SRAM (Hydlide 2, 2KB: bits 1–3 ignored); the
 *               SRAM mirrors through the 16KB window; writable only at
 *               8000h–BFFFh.
 *   konami      4000h–5FFFh fixed to bank 0; a write anywhere in 6000h–BFFFh
 *               selects the bank of that 8KB segment; power-on banks 0–3.
 *   konami-scc  registers 5000h/7000h/9000h/B000h (2KB windows, bits 0–5);
 *               power-on banks 0–3. Bank register 3 (9000h) holding 3Fh in
 *               bits 0–5 brings the SCC in at 9800h–9FFFh (see scc.ts).
 *   rtype       ASCII16 with 4000h–7FFFh fixed to 16KB segment 0Fh; the
 *               7000h–77FFh register switches 8000h–BFFFh (bit 4 set: bits
 *               0–2 select among segments 10h–17h).
 *   crossblaim  64KB; 4000h–7FFFh fixed to 16KB segment 0; a write to 4045h
 *               picks 8000h–BFFFh: value bits 0–1, with 0 selecting segment 1
 *               like 1 does (a write never switches segment 0 back in);
 *               power-on segment 0.
 *
 * Every mapper decodes 4000h–BFFFh only; pages 0 and 3 read 0xFF.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { Scc } from '@/machines/msx/scc.ts';

const PAGE_SIZE = 0x4000;
const SEG_SIZE = 0x2000;
const SEGS = 8;

export type MsxMapper =
  | 'plain'
  | 'ascii8' | 'ascii8-sram8' | 'ascii8-sram8-b7' | 'ascii8-sram32'
  | 'ascii16' | 'ascii16-sram2' | 'ascii16-sram8'
  | 'konami' | 'konami-scc'
  | 'rtype' | 'crossblaim';

/** Every mapper, in the order the Hardware pane lists them. */
export const MSX_MAPPERS: readonly { readonly id: MsxMapper; readonly label: string }[] = [
  { id: 'plain', label: 'Plain ROM (no mapper)' },
  { id: 'ascii8', label: 'ASCII 8 KB' },
  { id: 'ascii8-sram8', label: 'ASCII 8 KB + 8 KB SRAM (Xanadu, Koei)' },
  { id: 'ascii8-sram32', label: 'ASCII 8 KB + 32 KB SRAM (Koei)' },
  { id: 'ascii8-sram8-b7', label: 'ASCII 8 KB + 8 KB SRAM, bit 7 (Wizardry)' },
  { id: 'ascii16', label: 'ASCII 16 KB' },
  { id: 'ascii16-sram2', label: 'ASCII 16 KB + 2 KB SRAM (Hydlide 2)' },
  { id: 'ascii16-sram8', label: 'ASCII 16 KB + 8 KB SRAM' },
  { id: 'konami', label: 'Konami' },
  { id: 'konami-scc', label: 'Konami SCC' },
  { id: 'rtype', label: 'R-Type' },
  { id: 'crossblaim', label: 'Cross Blaim' },
];

export function isMsxMapper(id: string): id is MsxMapper {
  return MSX_MAPPERS.some(m => m.id === id);
}

/** SRAM size in bytes for a mapper (0 = none). */
function sramSize(mapper: MsxMapper): number {
  switch (mapper) {
    case 'ascii8-sram8': case 'ascii8-sram8-b7': case 'ascii16-sram8': return 0x2000;
    case 'ascii8-sram32': return 0x8000;
    case 'ascii16-sram2': return 0x800;
    default: return 0;
  }
}

function isAscii8(m: MsxMapper): boolean {
  return m === 'ascii8' || m === 'ascii8-sram8' || m === 'ascii8-sram8-b7' || m === 'ascii8-sram32';
}

function isAscii16(m: MsxMapper): boolean {
  return m === 'ascii16' || m === 'ascii16-sram2' || m === 'ascii16-sram8';
}

/**
 * Where a plain (non-mapper) cartridge image starts in the Z80 address space,
 * from its "AB" header(s). Every 16KB boundary of the image is checked for
 * "AB"; each non-zero pointer in the header (INIT, STATEMENT, DEVICE, TEXT)
 * votes for the page the image must start at so the pointer lands inside its
 * own 16KB block. 0x4000 is preferred, then 0x0000, then 0x8000; no header at
 * all defaults to 0x4000.
 */
export function guessCartBase(rom: Uint8Array): number {
  const votes = [0, 0, 0];
  for (let i = 0; i + 0x10 <= rom.length; i += PAGE_SIZE) {
    if (rom[i] !== 0x41 || rom[i + 1] !== 0x42) continue;   // "AB"
    for (let j = 0; j < 4; j++) {
      const w = rom[i + 2 + j * 2] | (rom[i + 3 + j * 2] << 8);
      if (w === 0) continue;
      const page = (w >> 14) - (i >> 14);
      if (page >= 0 && page <= 2) votes[page]++;
    }
  }
  if (votes[1] && votes[1] >= votes[0] && votes[1] >= votes[2]) return 0x4000;
  if (votes[0] && votes[0] >= votes[2]) return 0x0000;
  if (votes[2]) return 0x8000;
  return 0x4000;
}

/**
 * Guess a mega-ROM's mapper from its code. Games switch banks by storing to
 * the bank registers, with `LD (nnnn),A` (32 nn nn) or `LD HL,nnnn` followed
 * by `LD (HL),A` (21 nn nn 77); count those stores to each mapper's register
 * addresses and pick the most-hit mapper. Ties go to Konami SCC, then Konami,
 * ASCII16, ASCII8; ASCII8's count is docked by one (6000h and 7000h are
 * shared with the others), and no hits at all falls back to ASCII8.
 *
 * Two boards are recognised outright: a 384KB image is R-Type (the only
 * 384KB mega-ROM), and a 64KB image storing to 4045h is Cross Blaim. The
 * SRAM variants cannot be told from the code; pick them with the mapper
 * selector.
 */
export function guessMegaRomMapper(rom: Uint8Array): Exclude<MsxMapper, 'plain'> {
  if (rom.length === 0x60000) return 'rtype';
  let ascii8 = 0, ascii16 = 0, konami = 0, konamiScc = 0, crossBlaim = 0;
  for (let i = 0; i + 3 < rom.length; i++) {
    const op = rom[i];
    let addr: number;
    if (op === 0x32) addr = rom[i + 1] | (rom[i + 2] << 8);
    else if (op === 0x21 && rom[i + 3] === 0x77) addr = rom[i + 1] | (rom[i + 2] << 8);
    else continue;
    switch (addr) {
      case 0x5000: case 0x9000: case 0xB000: konamiScc++; break;
      case 0x4000: case 0x8000: case 0xA000: konami++; break;
      case 0x6800: case 0x7800: ascii8++; break;
      case 0x6000: konami++; ascii8++; ascii16++; break;
      case 0x7000: konamiScc++; ascii8++; ascii16++; break;
      case 0x77FF: ascii16++; break;
      case 0x4045: crossBlaim++; break;
    }
  }
  if (rom.length === 0x10000 && crossBlaim > 0) return 'crossblaim';
  if (ascii8 > 0) ascii8--;
  let best: Exclude<MsxMapper, 'plain'> = 'ascii8';
  let bestCount = ascii8;
  const rivals = [['ascii16', ascii16], ['konami', konami], ['konami-scc', konamiScc]] as const;
  for (const [type, count] of rivals) {
    if (count > 0 && count >= bestCount) { best = type; bestCount = count; }
  }
  return best;
}

/** Whether an image needs a mega-ROM mapper: anything over 64KB, or a 64KB
 *  image that starts with an "AB" header (a header-less 64KB image is a plain
 *  ROM filling all four pages). */
export function isMegaRom(rom: Uint8Array): boolean {
  if (rom.length > 0x10000) return true;
  return rom.length === 0x10000 && rom[0] === 0x41 && rom[1] === 0x42;
}

export class MsxCartridge {
  /** The image as inserted (null = empty slot). */
  rom: Uint8Array | null = null;
  mapper: MsxMapper = 'plain';

  /** Per-8KB-segment read views (null = not decoded there, reads 0xFF). */
  readonly seg: (Uint8Array | null)[] = new Array(SEGS).fill(null);
  /** Segments whose reads must go through {@link read} (the SCC window). */
  readonly slow = new Uint8Array(SEGS);

  /** Bank registers as last written (mapper-specific meaning, see applyBanks). */
  readonly regs = new Uint8Array(SEGS);

  /** Battery-backed SRAM (null when the board has none), held as whole 8KB
   *  blocks with a smaller chip mirrored through its block. */
  sram: Uint8Array | null = null;
  /** The real chip size; writes reach every mirror of a byte. */
  private sramBytes = 0;
  /** Segments where a write lands in SRAM. */
  private readonly sramWrite = new Uint8Array(SEGS);
  /** SRAM block mapped at each segment (valid where sramWrite or a view is SRAM). */
  private readonly sramBlock = new Uint8Array(SEGS);

  /** The SCC (Konami SCC boards only), and whether its window is switched in. */
  scc: Scc | null = null;
  sccActive = false;

  /** The mega-ROM padded to whole 8KB blocks, and its bank mask. */
  private image = new Uint8Array(0);
  private blocks8 = 0;
  private mask8 = 0;

  get isMega(): boolean { return this.rom !== null && this.mapper !== 'plain'; }

  /** Insert an image with the given mapper (power-on banking, SRAM cleared). */
  insert(data: Uint8Array | null, mapper: MsxMapper): void {
    this.rom = data && data.length > 0 ? data : null;
    this.mapper = this.rom ? mapper : 'plain';
    const size = sramSize(this.mapper);
    this.sramBytes = size;
    this.sram = size > 0 ? new Uint8Array(Math.max(size, SEG_SIZE)) : null;
    this.scc = this.mapper === 'konami-scc' ? new Scc() : null;
    this.sccActive = false;
    this.build();
  }

  /** Lay the image out: a plain ROM by its header, a mega-ROM at power-on banking. */
  private build(): void {
    this.seg.fill(null);
    this.slow.fill(0);
    this.sramWrite.fill(0);
    const rom = this.rom;
    if (!rom) return;
    if (this.mapper === 'plain') { this.buildPlain(rom); return; }
    const blocks = Math.ceil(rom.length / SEG_SIZE);
    this.image = new Uint8Array(blocks * SEG_SIZE).fill(0xFF);
    this.image.set(rom);
    this.blocks8 = blocks;
    let pow = 1;
    while (pow < blocks) pow <<= 1;
    this.mask8 = pow - 1;
    this.resetBanks();
  }

  /**
   * A plain image starts where its "AB" header says ({@link guessCartBase})
   * and covers as many 16KB pages as it needs, up to 0xFFFF. An 8KB image
   * mirrors across its 16KB page (only A0–A12 are decoded). A 64KB image
   * fills all four pages.
   */
  private buildPlain(rom: Uint8Array): void {
    const size = rom.length;
    const base = size >= 0x10000 ? 0 : guessCartBase(rom);
    const pages = Math.min(Math.ceil(size / PAGE_SIZE), 4 - (base >> 14));
    const image = new Uint8Array(pages * PAGE_SIZE).fill(0xFF);
    image.set(rom.subarray(0, image.length));
    if (size <= SEG_SIZE) image.set(rom, SEG_SIZE);
    const firstSeg = base >> 13;
    for (let i = 0; i < pages * 2; i++) {
      this.seg[firstSeg + i] = image.subarray(i * SEG_SIZE, (i + 1) * SEG_SIZE);
    }
  }

  /** Power-on bank registers (and /RESET: a reset reaches the cartridge). */
  resetBanks(): void {
    if (!this.isMega) return;
    this.regs.fill(0);
    switch (this.mapper) {
      case 'konami':
        this.regs[3] = 1; this.regs[4] = 2; this.regs[5] = 3;
        break;
      case 'konami-scc':
        this.regs[2] = 0; this.regs[3] = 1; this.regs[4] = 2; this.regs[5] = 3;
        break;
      default:
        break;
    }
    this.scc?.reset();
    this.applyBanks();
  }

  /** 8KB block `n` of the image (masked), or null past its end. */
  private block8(n: number): Uint8Array | null {
    n &= this.mask8;
    return n < this.blocks8 ? this.image.subarray(n * SEG_SIZE, (n + 1) * SEG_SIZE) : null;
  }

  private sramView(block: number): Uint8Array {
    const s = this.sram!;
    const blocks = s.length / SEG_SIZE;
    const b = block % blocks;
    return s.subarray(b * SEG_SIZE, (b + 1) * SEG_SIZE);
  }

  /** The SRAM-select bit of an ASCII8 SRAM board. */
  private ascii8SramBit(): number {
    return this.mapper === 'ascii8-sram8-b7' ? 0x80 : this.mask8 + 1;
  }

  /** Rebuild the read views from the bank registers. */
  applyBanks(): void {
    this.seg.fill(null);
    this.slow.fill(0);
    this.sramWrite.fill(0);
    const m = this.mapper;
    if (isAscii8(m)) {
      const bit = m === 'ascii8' ? 0 : this.ascii8SramBit();
      for (let s = 2; s < 6; s++) {
        const v = this.regs[s];
        if (bit && (v & bit)) {
          const block = v & ((this.sram!.length / SEG_SIZE) - 1);
          this.sramBlock[s] = block;
          this.seg[s] = this.sramView(block);
          if (s >= 4) this.sramWrite[s] = 1;   // writable at 8000h–BFFFh only
        } else {
          this.seg[s] = this.block8(v);
        }
      }
    } else if (isAscii16(m) || m === 'rtype' || m === 'crossblaim') {
      for (const s of [2, 4]) {
        let v = this.regs[s];
        if (m === 'rtype') v = s === 2 ? 0x0F : (v & 0x10 ? v & 0x17 : v & 0x1F);
        if (m === 'crossblaim') v = s === 2 ? 0 : v;
        if (m !== 'ascii16' && isAscii16(m) && (v & 0x10)) {
          // The SRAM fills the 16KB window, mirrored.
          this.sramBlock[s] = this.sramBlock[s + 1] = 0;
          this.seg[s] = this.seg[s + 1] = this.sramView(0);
          if (s === 4) this.sramWrite[4] = this.sramWrite[5] = 1;
        } else {
          this.seg[s] = this.block8(v * 2);
          this.seg[s + 1] = this.block8(v * 2 + 1);
        }
      }
    } else if (m === 'konami') {
      this.seg[2] = this.block8(0);
      for (let s = 3; s < 6; s++) this.seg[s] = this.block8(this.regs[s]);
    } else if (m === 'konami-scc') {
      for (let s = 2; s < 6; s++) this.seg[s] = this.block8(this.regs[s] & 0x3F);
      this.sccActive = (this.regs[4] & 0x3F) === 0x3F;
      // 9800h–9FFFh is the SCC while it is switched in: segment 4 goes slow.
      if (this.sccActive) this.slow[4] = 1;
    }
  }

  /** Slow-path read (segments flagged in {@link slow}): the SCC window. */
  read(addr: number): number {
    if (this.sccActive && addr >= 0x9800 && addr < 0xA000) return this.scc!.read(addr & 0xFF);
    const v = this.seg[addr >> 13];
    return v ? v[addr & 0x1FFF] : 0xFF;
  }

  /** Side-effect-free read for debug views (the SCC's registers have none). */
  peek(addr: number): number { return this.read(addr); }

  /** A CPU write into slot 1. Returns true when the read views changed. */
  write(addr: number, val: number): boolean {
    const m = this.mapper;
    const seg = addr >> 13;
    if (isAscii8(m)) {
      if (addr >= 0x6000 && addr < 0x8000) {
        this.regs[2 + ((addr >> 11) & 3)] = val;
        this.applyBanks();
        return true;
      }
      if (this.sramWrite[seg]) this.writeSram(this.sramBlock[seg] * SEG_SIZE + (addr & 0x1FFF), val);
      return false;
    }
    if (isAscii16(m) || m === 'rtype') {
      if (addr >= 0x6000 && addr < 0x7800 && !(addr & 0x0800)) {
        const s = (addr & 0x1000) ? 4 : 2;
        if (m === 'rtype' && s === 2) return false;   // 4000h–7FFFh is fixed
        this.regs[s] = val;
        this.applyBanks();
        return true;
      }
      if (this.sramWrite[seg]) this.writeSram(addr & 0x1FFF, val);
      return false;
    }
    switch (m) {
      case 'konami':
        if (addr < 0x6000 || addr >= 0xC000) return false;
        this.regs[seg] = val;
        this.applyBanks();
        return true;
      case 'konami-scc':
        if (this.sccActive && addr >= 0x9800 && addr < 0xA000) {
          this.scc!.write(addr & 0xFF, val);
          return false;
        }
        if (addr < 0x5000 || addr >= 0xC000 || (addr & 0x1800) !== 0x1000) return false;
        this.regs[seg] = val;
        this.applyBanks();
        return true;
      case 'crossblaim':
        if (addr !== 0x4045) return false;
        this.regs[4] = (val & 3) || 1;
        this.applyBanks();
        return true;
      default:
        return false;
    }
  }

  /** Write SRAM offset `off` (within its 8KB-block view), reaching every
   *  mirror of a chip smaller than the block. */
  private writeSram(off: number, val: number): void {
    const s = this.sram!;
    const size = this.sramBytes;
    if (size >= SEG_SIZE) { s[off % s.length] = val; return; }
    const base = off % size;
    for (let p = base; p < s.length; p += size) s[p] = val;
  }

  /** The chip's contents (its real size, without the mirrors), or null. */
  sramContents(): Uint8Array | null {
    return this.sram ? this.sram.slice(0, this.sramBytes) : null;
  }

  // ── Snapshot state (appended to the MEM section, see msx-machine.ts) ──

  saveExtra(w: StateWriter): void {
    w.u8(1);                    // extension version
    w.raw(this.regs);
    const sram = this.sramContents();
    w.bool(sram !== null);
    if (sram) w.bytes(sram);
    w.bool(this.scc !== null);
    if (this.scc) this.scc.saveState(w);
  }

  loadExtra(r: StateReader): void {
    if (r.u8() !== 1) throw new Error('Snapshot cartridge state has an unknown version');
    r.rawInto(this.regs);
    if (r.bool()) {
      const data = r.bytes(1 << 20);
      if (this.sram) {
        for (let i = 0; i < Math.min(data.length, this.sramBytes); i++) this.writeSram(i, data[i]);
      }
    }
    if (r.bool()) {
      if (!this.scc) this.scc = new Scc();
      this.scc.loadState(r);
    }
    if (this.isMega) this.applyBanks();
  }

  /** Old-style restore: an 8KB bank index per segment (-1 = unmapped), as a
   *  state written before the bank registers were saved records it. */
  applyBlockIndices(banks: readonly number[]): void {
    if (!this.isMega) return;
    for (let s = 0; s < SEGS; s++) this.seg[s] = banks[s] < 0 ? null : this.block8(banks[s]);
  }

  /** The 8KB ROM block index each segment shows (-1 when unmapped or SRAM). */
  blockIndex(s: number): number {
    const v = this.seg[s];
    if (!this.isMega || v === null || v.buffer !== this.image.buffer) return -1;
    return (v.byteOffset - this.image.byteOffset) / SEG_SIZE;
  }
}
