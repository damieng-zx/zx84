/**
 * SZX (ZX-State) snapshot loader.
 *
 * Block-based format from Spectaculator, also used by Fuse and others.
 * Reference: https://www.spectaculator.com/docs/zx-state/intro.shtml
 *
 * Header (8 bytes):
 *   [0..3] = 'ZXST' magic
 *   [4]    = major version, [5] = minor version
 *   [6]    = machine ID, [7] = flags
 *
 * Each block: 4-byte ID + 4-byte LE payload size, then payload.
 */

import { Z80 } from '@/cores/z80.ts';
import { SpectrumMemory } from '@/machines/spectrum/memory.ts';
import type { SpectrumModel } from '@/machines/spectrum/spectrum.ts';

export interface SZXResult {
  is128K: boolean;
  port7FFD: number;
  port1FFD: number;
  /** Source machine had a 0x1FFD register (+2A/+2B, +3, +3e). False for a
   *  128K/+2/Pentagon-class snapshot, whose ROM select must be mapped onto a
   *  4-ROM target (see SpectrumMemory.selectSnapshot128KRom). */
  sourceHas1FFD: boolean;
  borderColor: number;
  /** SPCR chFe: the last byte written to port 0xFE (border, MIC, EAR), or
   *  undefined when the file has no SPCR block. */
  portFE?: number;
  /** KEYB ZXSTKF_ISSUE2, or undefined when the file has no KEYB block. The
   *  spec defines it for the 16K and 48K only. */
  issue2?: boolean;
  ayRegs?: Uint8Array;
  ayCurrentReg?: number;
}

/** Board state beyond the CPU and memory that an SZX records. */
export interface SZXBoard {
  /** Last byte written to port 0xFE. */
  portFE: number;
  /** Issue 2 keyboard emulation (16K/48K only). */
  issue2: boolean;
}

/** KEYB dwFlags bit: Issue 2 keyboard emulation. */
const ZXSTKF_ISSUE2 = 1;
/** KEYB chKeyboardJoystick: the host keyboard emulates no joystick. */
const ZXSKJT_NONE = 8;

// ── Helpers ─────────────────────────────────────────────────────────────

function r16(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function r32(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | ((d[o + 3] << 24) >>> 0);
}

function blockId(d: Uint8Array, o: number): string {
  return String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
}

/** Deflate data using browser CompressionStream. */
async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();

  writer.write(raw as unknown as BufferSource);
  writer.close();

  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.byteLength;
  }

  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const chunk of chunks) {
    result.set(chunk, off);
    off += chunk.byteLength;
  }
  return result;
}

/** Inflate zlib (deflate) data using browser DecompressionStream. */
async function inflate(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressed as unknown as BufferSource);
  writer.close();

  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.byteLength;
  }

  if (chunks.length === 1) return chunks[0];

  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// ── Machine ID mapping ──────────────────────────────────────────────────

/** SZX machine ID: 0=16K, 1=48K, 2=128K, 3=+2, 4=+2A/+2B, 5=+3, 6=+3e, 7=Pentagon 128,
 *  10=Scorpion ZS-256, 13=Pentagon 512, 14=Pentagon 1024 */
const MODEL_TO_MACHINE_ID: Record<SpectrumModel, number> = {
  'zx16k': 0,
  'zx48k': 1,
  'zx128k': 2,
  'zx128kplus2': 3,
  'zx128kplus2a': 4,
  'zx128kplus3': 5,
  pentagon128: 7,
  pentagon512: 13,
  pentagon1024: 14,
  scorpion256: 10,
};

function machineIs128K(machineId: number): boolean {
  // 128K-class machines have 8+ RAM banks. Per the ZXSTMID_* enum,
  // IDs 2-7 (128K..Pentagon128), 10-11 (Scorpion256, SE), and 13-16
  // (Pentagon 512/1024, 128Ke) are 128K+. The Timex variants (TC2048=8,
  // TC2068=9, TS2068=12) and the NTSC 48K (15) are 48K-class.
  if (machineId < 2) return false;
  if (machineId === 8 || machineId === 9 || machineId === 12 || machineId === 15) return false;
  return true;
}

// ── Main loader ─────────────────────────────────────────────────────────

export async function loadSZX(
  data: Uint8Array,
  cpu: Z80,
  memory: SpectrumMemory
): Promise<SZXResult> {
  if (data.length < 8) {
    throw new Error('SZX file too small');
  }

  // Validate magic: ZXST
  if (data[0] !== 0x5A || data[1] !== 0x58 || data[2] !== 0x53 || data[3] !== 0x54) {
    throw new Error('Not a valid SZX file (bad magic)');
  }

  const machineId = data[6];
  const is128K = machineIs128K(machineId);

  const result: SZXResult = {
    is128K,
    port7FFD: 0,
    port1FFD: 0,
    sourceHas1FFD: machineId === 4 || machineId === 5 || machineId === 6,
    borderColor: 7,
  };

  // ── Block iteration ─────────────────────────────────────────────────

  let offset = 8; // past header

  while (offset + 8 <= data.length) {
    const id = blockId(data, offset);
    const dwSize = r32(data, offset + 4);
    const blockStart = offset + 8;
    const blockEnd = blockStart + dwSize;

    if (blockEnd > data.length) break; // truncated block

    switch (id) {
      case 'Z80R':
        parseZ80R(data, blockStart, cpu);
        break;

      case 'SPCR':
        parseSPCR(data, blockStart, result);
        break;

      case 'RAMP':
        await parseRAMP(data, blockStart, dwSize, memory);
        break;

      case 'AY\0\0':
        parseAY(data, blockStart, result);
        break;

      case CLONE_BLOCK:
        // zx84's own block (other readers skip it): bit 0 = Scorpion Turbo+ 7 MHz.
        if (dwSize >= 1) memory.cpuTurbo = memory.scheme === 'scorpion' && (data[blockStart] & 0x01) !== 0;
        break;

      case 'KEYB':
        // dwFlags (4) + chKeyboardJoystick (1, from v1.1); only the flags matter.
        if (dwSize >= 4) result.issue2 = (r32(data, blockStart) & ZXSTKF_ISSUE2) !== 0;
        break;

      // Unknown blocks: skip
    }

    offset = blockEnd;
  }

  // For 48K snapshots, flush RAM banks into flat memory
  if (!is128K) {
    // Banks 5, 2, 0 map to 0x4000, 0x8000, 0xC000
    memory.load48KRAM(build48KRAM(memory));
  }

  return result;
}

/**
 * Apply the paging state from a parsed SZX result to memory. Shared by every
 * SZX consumer (file load + the browser-refresh resume) so the bank/ROM selection
 * can't drift between them.
 *
 * `hasSpecialPaging` must be true for +2A/+3-class machines: there the ROM page
 * is a 2-bit value — 1FFD bit 2 (high) | 7FFD bit 4 (low) — and 1FFD bit 0
 * enables all-RAM special paging. On plain 128K/+2 the ROM is just 7FFD bit 4.
 * Getting this wrong pages in the wrong ROM, which silently breaks any game
 * whose interrupt routine calls into ROM (frozen music / colour effects).
 */
export function applySZXPaging(memory: SpectrumMemory, hasSpecialPaging: boolean, result: SZXResult): void {
  if (!result.is128K) return;
  // The 1024's EFF7 shares the 1FFD byte and decides how 7FFD is read, so it
  // must be restored first. A no-op latch on every other machine.
  if (memory.scheme === 'pentagon1024') {
    memory.portEFF7 = result.port1FFD;
    memory.ramAtZero = (result.port1FFD & 0x08) !== 0;
  }
  if (memory.scheme === 'scorpion') {
    // 1FFD carries RAM-at-0000, the ROM page's high bit and RAM page bit 3, and
    // must be latched first because it feeds the page 7FFD selects.
    memory.port1FFD = result.port1FFD;
    memory.ramAtZero = (result.port1FFD & 0x01) !== 0;
    memory.latch7FFD(result.port7FFD);
    memory.currentROM = memory.romIndexFor(result.port7FFD, result.port1FFD);
    memory.applyBanking();
    return;
  }
  memory.latch7FFD(result.port7FFD);
  if (hasSpecialPaging && !result.sourceHas1FFD) {
    memory.applyBanking();
    memory.selectSnapshot128KRom();
    return;
  }
  if (hasSpecialPaging) {
    memory.port1FFD = result.port1FFD;
    memory.specialPaging = (result.port1FFD & 1) !== 0;
    memory.currentROM = (((result.port1FFD >> 2) & 1) << 1) | ((result.port7FFD >> 4) & 1);
  } else {
    memory.currentROM = (result.port7FFD >> 4) & 1;
  }
  memory.applyBanking();
}

// ── Block parsers ───────────────────────────────────────────────────────

function parseZ80R(data: Uint8Array, o: number, cpu: Z80): void {
  // Z80R block layout (37 bytes minimum):
  // 0:  AF, 2: BC, 4: DE, 6: HL       (LE words)
  // 8:  AF', 10: BC', 12: DE', 14: HL'
  // 16: IX, 18: IY, 20: SP, 22: PC
  // 24: I, 25: R, 26: IFF1, 27: IFF2
  // 28: IM
  // 29: dwCyclesStart (4 bytes)
  // 33: chHoldIntReqCycles (1 byte) — skip
  // 34: chFlags (1 byte) — bit 1 = halted
  // 35: wMemPtr (2 bytes) — internal WZ register, skip

  const af  = r16(data, o + 0);
  const bc  = r16(data, o + 2);
  const de  = r16(data, o + 4);
  const hl  = r16(data, o + 6);
  const af_ = r16(data, o + 8);
  const bc_ = r16(data, o + 10);
  const de_ = r16(data, o + 12);
  const hl_ = r16(data, o + 14);

  cpu.a = (af >> 8) & 0xFF;
  cpu.f = af & 0xFF;
  cpu.b = (bc >> 8) & 0xFF;
  cpu.c = bc & 0xFF;
  cpu.d = (de >> 8) & 0xFF;
  cpu.e = de & 0xFF;
  cpu.h = (hl >> 8) & 0xFF;
  cpu.l = hl & 0xFF;

  cpu.a_ = (af_ >> 8) & 0xFF;
  cpu.f_ = af_ & 0xFF;
  cpu.b_ = (bc_ >> 8) & 0xFF;
  cpu.c_ = bc_ & 0xFF;
  cpu.d_ = (de_ >> 8) & 0xFF;
  cpu.e_ = de_ & 0xFF;
  cpu.h_ = (hl_ >> 8) & 0xFF;
  cpu.l_ = hl_ & 0xFF;

  cpu.ix = r16(data, o + 16);
  cpu.iy = r16(data, o + 18);
  cpu.sp = r16(data, o + 20);
  cpu.pc = r16(data, o + 22);

  cpu.i = data[o + 24];
  cpu.r = data[o + 25];

  cpu.iff1 = data[o + 26] !== 0;
  cpu.iff2 = data[o + 27] !== 0;

  cpu.im = data[o + 28] & 0x03;

  // T-states since the frame's INT. The caller must resume the machine at
  // this frame offset (Spectrum.resumeAtFrameOffset) so the next INT lands
  // tpf - dwCyclesStart later rather than immediately.
  const dwCyclesStart = r32(data, o + 29);
  cpu.tStates = dwCyclesStart;

  // chFlags at offset 34 — bit 1 = halted
  if (o + 34 < data.length) {
    cpu.halted = (data[o + 34] & 0x02) !== 0;
  }
}

function parseSPCR(data: Uint8Array, o: number, result: SZXResult): void {
  // SPCR block: border(1), 7FFD(1), 1FFD(1), FE(1)
  result.borderColor = data[o] & 0x07;
  result.port7FFD = data[o + 1];
  result.port1FFD = data[o + 2];
  result.portFE = data[o + 3];
}

async function parseRAMP(
  data: Uint8Array,
  blockStart: number,
  dwSize: number,
  memory: SpectrumMemory
): Promise<void> {
  // RAMP block: wFlags(2), chPageNo(1), then page data
  const wFlags = r16(data, blockStart);
  const chPageNo = data[blockStart + 2];
  const pageDataStart = blockStart + 3;
  const pageDataLen = dwSize - 3;

  if (chPageNo >= memory.ramBankCount) return; // invalid bank number

  if (wFlags & 1) {
    // Compressed (zlib/deflate)
    const compressed = data.subarray(pageDataStart, pageDataStart + pageDataLen);
    const decompressed = await inflate(compressed);
    memory.setBankFromSnapshot(chPageNo, decompressed);
  } else {
    // Uncompressed — 16384 bytes
    memory.setBankFromSnapshot(chPageNo,
      data.subarray(pageDataStart, pageDataStart + Math.min(pageDataLen, 16384))
    );
  }
}

function parseAY(data: Uint8Array, o: number, result: SZXResult): void {
  // AY block: chFlags(1), chCurrentRegister(1), chAyRegs[16]
  result.ayCurrentReg = data[o + 1];
  result.ayRegs = data.slice(o + 2, o + 2 + 16);
}

/** Build a contiguous 48K RAM image from banks 5, 2, 0. */
function build48KRAM(memory: SpectrumMemory): Uint8Array {
  const ram = new Uint8Array(49152);
  ram.set(memory.getRamBank(5), 0);       // 0x4000
  ram.set(memory.getRamBank(2), 16384);   // 0x8000
  ram.set(memory.getRamBank(0), 32768);   // 0xC000
  return ram;
}

// ── SZX Writer ──────────────────────────────────────────────────────────

function w16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xFF;
  data[offset + 1] = (value >> 8) & 0xFF;
}

function w32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xFF;
  data[offset + 1] = (value >> 8) & 0xFF;
  data[offset + 2] = (value >> 16) & 0xFF;
  data[offset + 3] = (value >> 24) & 0xFF;
}

/** zx84's block for clone state the SZX specification has no field for. One
 *  flags byte: bit 0 = the Scorpion ZS-256 Turbo+ clock is at 7 MHz. Written
 *  only for the Scorpion; readers that do not know it skip it, as the format
 *  requires of unknown blocks. */
const CLONE_BLOCK = 'Z84C';

function writeBlockHeader(data: Uint8Array, offset: number, id: string, size: number): number {
  // 4-byte ID — all callers pass a 4-char literal (Z80R, SPCR, RAMP, AY\0\0, KEYB, Z84C).
  for (let i = 0; i < 4; i++) {
    data[offset + i] = id.charCodeAt(i);
  }
  // 4-byte size (LE)
  w32(data, offset + 4, size);
  return offset + 8;
}

/** One RAM page ready for the RAMP block — already compressed or raw. */
interface SZXPage { page: number; data: Uint8Array; compressed: boolean; }

/** RAM bank numbers a snapshot of this memory must include. */
function snapshotPages(memory: SpectrumMemory): number[] {
  // For 48K, pages 0, 2, 5 are used. For 16K, only page 5. For 128K, all 8
  // (32 on the Pentagon 512, 64 on the 1024).
  return memory.is128K
    ? Array.from({ length: memory.ramBankCount }, (_, i) => i)
    : memory.is16K
      ? [5]
      : [0, 2, 5];
}

export async function saveSZX(cpu: Z80, memory: SpectrumMemory, borderColor: number, model: SpectrumModel, frameStartTStates: number, ayRegs?: Uint8Array, ayCurrentReg?: number, board?: SZXBoard): Promise<Uint8Array> {
  // Flush live flat[] to banks (built into flushBanks — cannot be forgotten).
  const banks = memory.flushBanks();

  // Compress each page
  const compressedPages: SZXPage[] = [];
  for (const page of snapshotPages(memory)) {
    const raw = banks[page];
    const zipped = await deflate(raw);
    // Only use compressed version if it's actually smaller
    if (zipped.length < raw.length) {
      compressedPages.push({ page, data: zipped, compressed: true });
    } else {
      compressedPages.push({ page, data: raw, compressed: false });
    }
  }

  return assembleSZX(cpu, memory, borderColor, model, frameStartTStates, compressedPages, ayRegs, ayCurrentReg, board);
}

/**
 * Synchronous SZX writer with no compression. Identical output to saveSZX
 * except RAMP blocks are stored raw, so it needs no async CompressionStream.
 *
 * This is the only safe way to snapshot during `beforeunload`: that handler
 * can't await, so an async deflate never finishes before the page tears down
 * and the snapshot is silently lost. Raw pages cost ~128KB for a 128K machine
 * (well within localStorage quota); the loader reads compressed and raw RAMP
 * blocks identically, so restore is unchanged.
 */
export function saveSZXSync(cpu: Z80, memory: SpectrumMemory, borderColor: number, model: SpectrumModel, frameStartTStates: number, ayRegs?: Uint8Array, ayCurrentReg?: number, board?: SZXBoard): Uint8Array {
  const banks = memory.flushBanks();
  const rawPages: SZXPage[] = snapshotPages(memory).map(page => ({
    page, data: banks[page], compressed: false,
  }));
  return assembleSZX(cpu, memory, borderColor, model, frameStartTStates, rawPages, ayRegs, ayCurrentReg, board);
}

/** Assemble the SZX byte stream from already-prepared (compressed or raw) pages. */
function assembleSZX(cpu: Z80, memory: SpectrumMemory, borderColor: number, model: SpectrumModel, frameStartTStates: number, compressedPages: SZXPage[], ayRegs?: Uint8Array, ayCurrentReg?: number, board?: SZXBoard): Uint8Array {
  // Calculate total size
  const headerSize = 8;
  const z80rSize = 8 + 37;
  const spcrSize = 8 + 8; // 4 fields + 4 reserved bytes
  const rampSize = compressedPages.reduce((sum, p) => sum + 8 + 3 + p.data.length, 0);
  const aySize = ayRegs ? 8 + 18 : 0;
  const cloneSize = memory.scheme === 'scorpion' ? 8 + 1 : 0;
  const keybSize = 8 + 5;
  const totalSize = headerSize + z80rSize + spcrSize + rampSize + aySize + keybSize + cloneSize;

  const data = new Uint8Array(totalSize);
  let offset = 0;

  // ── Header ──────────────────────────────────────────────────────────
  data[offset++] = 0x5A; // 'Z'
  data[offset++] = 0x58; // 'X'
  data[offset++] = 0x53; // 'S'
  data[offset++] = 0x54; // 'T'
  data[offset++] = 1;    // major version
  data[offset++] = 4;    // minor version
  data[offset++] = MODEL_TO_MACHINE_ID[model]; // machine ID
  data[offset++] = 0;    // flags

  // ── Z80R block (CPU registers) ──────────────────────────────────────
  offset = writeBlockHeader(data, offset, 'Z80R', 37);

  w16(data, offset + 0, (cpu.a << 8) | cpu.f);   // AF
  w16(data, offset + 2, (cpu.b << 8) | cpu.c);   // BC
  w16(data, offset + 4, (cpu.d << 8) | cpu.e);   // DE
  w16(data, offset + 6, (cpu.h << 8) | cpu.l);   // HL
  w16(data, offset + 8, (cpu.a_ << 8) | cpu.f_); // AF'
  w16(data, offset + 10, (cpu.b_ << 8) | cpu.c_); // BC'
  w16(data, offset + 12, (cpu.d_ << 8) | cpu.e_); // DE'
  w16(data, offset + 14, (cpu.h_ << 8) | cpu.l_); // HL'
  w16(data, offset + 16, cpu.ix);
  w16(data, offset + 18, cpu.iy);
  w16(data, offset + 20, cpu.sp);
  w16(data, offset + 22, cpu.pc);
  data[offset + 24] = cpu.i;
  data[offset + 25] = cpu.r;
  data[offset + 26] = cpu.iff1 ? 1 : 0;
  data[offset + 27] = cpu.iff2 ? 1 : 0;
  data[offset + 28] = cpu.im;
  // dwCyclesStart: frame-relative T-states (0 to tStatesPerFrame)
  w32(data, offset + 29, cpu.tStates - frameStartTStates);
  data[offset + 33] = 0; // chHoldIntReqCycles
  data[offset + 34] = cpu.halted ? 0x02 : 0; // chFlags
  w16(data, offset + 35, 0); // wMemPtr
  offset += 37;

  // ── SPCR block (Spectrum-specific) ──────────────────────────────────
  offset = writeBlockHeader(data, offset, 'SPCR', 8);
  data[offset++] = borderColor & 0x07;  // chBorder
  data[offset++] = memory.port7FFD;     // ch7ffd
  data[offset++] = memory.scheme === 'pentagon1024' ? memory.portEFF7 : memory.port1FFD; // ch1ffd / chEff7
  data[offset++] = board ? board.portFE & 0xFF : borderColor & 0x07; // chFe: last OUT to 0xFE
  w32(data, offset, 0);                 // chReserved (4 bytes, must be 0)
  offset += 4;

  // ── RAMP blocks (RAM pages) ─────────────────────────────────────────
  for (const { page, data: pageData, compressed } of compressedPages) {
    offset = writeBlockHeader(data, offset, 'RAMP', 3 + pageData.length);
    w16(data, offset, compressed ? 1 : 0); // wFlags: bit 0 = zlib compressed
    offset += 2;
    data[offset++] = page; // chPageNo
    data.set(pageData, offset);
    offset += pageData.length;
  }

  // ── AY block (AY chip state) ────────────────────────────────────────
  if (ayRegs) {
    offset = writeBlockHeader(data, offset, 'AY\0\0', 18);
    data[offset++] = 0; // chFlags
    data[offset++] = ayCurrentReg ?? 0; // chCurrentRegister
    data.set(ayRegs.slice(0, 16), offset);
    offset += 16;
  }

  // ── KEYB block (v1.1 layout) ────────────────────────────────────────
  // ZXSTKF_ISSUE2 is defined for the 16K and 48K only and must be 0 elsewhere.
  offset = writeBlockHeader(data, offset, 'KEYB', 5);
  const issue2 = !!board?.issue2 && (model === 'zx16k' || model === 'zx48k');
  w32(data, offset, issue2 ? ZXSTKF_ISSUE2 : 0);
  data[offset + 4] = ZXSKJT_NONE;
  offset += 5;

  // ── Z84C block (zx84 clone state) ───────────────────────────────────
  if (cloneSize > 0) {
    offset = writeBlockHeader(data, offset, CLONE_BLOCK, 1);
    data[offset++] = memory.cpuTurbo ? 0x01 : 0;
  }

  return data;
}
