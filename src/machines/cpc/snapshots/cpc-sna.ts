/**
 * Amstrad CPC `.SNA` snapshot loader and saver (the CPCEMU/WinAPE format).
 *
 * One 256-byte little-endian header followed by a memory image. Three header
 * versions exist and are all accepted on load:
 *
 *   - v1: 64K/128K memory dumped flat right after the header.
 *   - v2: adds a CPC-type byte (0x6D); memory still flat.
 *   - v3: the flat dump (sized by 0x6B–0x6C) is followed by optional chunks.
 *     WinAPE-style writers set the dump size to 0 and carry memory in
 *     "MEM0".."MEM8" chunks (64K each, optionally RLE-compressed); others
 *     (e.g. CPCEMU-lineage v3 writers) keep the flat dump. Unknown chunks skip.
 *
 * Save writes v2 (flat, uncompressed) or v3 (RLE-compressed MEM chunks). Unlike
 * the Spectrum loaders, this works on the whole CpcMachine: a CPC snapshot spans
 * the Z80, RAM banks, Gate Array, CRTC, PPI and PSG.
 */

import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { CpcModel } from '@/models.ts';
import type { Asic } from '@/machines/cpc/asic.ts';
import { cpcIsPlusClass } from '@/machines/cpc/models.ts';

const HEADER_SIZE = 256;
const SLOT_SIZE = 0x4000;   // 16KB bank
const BLOCK_SIZE = 0x10000; // 64KB MEM chunk
const RLE_MARKER = 0xE5;

/** "MV - SNA" signature bytes (offset 0x00). */
const SIGNATURE = [0x4D, 0x56, 0x20, 0x2D, 0x20, 0x53, 0x4E, 0x41];

export type CpcSnaModel = CpcModel;

export interface CpcSnaInfo {
  /** The CPC model the snapshot was taken on. */
  model: CpcSnaModel;
  version: number;
}

/** RAM banks for a model (4 = 64K for 464/664, 8 = 128K for 6128/Plus/GX4000). */
function banksFor(model: CpcModel): number {
  return model === 'cpc464' || model === 'cpc664' ? 4 : 8;
}

/** CPC type byte at offset 0x6D, per the published CPCEMU/WinAPE format
 *  (cpcwiki SNA File Format): 0=464, 1=664, 2=6128, 3=unknown, 4=6128 Plus,
 *  5=464 Plus, 6=GX4000. Values 3 and 5 have no corresponding CpcModel here
 *  (a plain "unknown" and the unmodelled 464 Plus respectively) and fall
 *  back to 6128 on load. Getting 4/6 wrong made WinAPE 6128 Plus snapshots
 *  load here as GX4000 and vice versa. */
const TYPE_464 = 0;
const TYPE_664 = 1;
const TYPE_6128 = 2;
const TYPE_6128PLUS = 4;
const TYPE_GX4000 = 6;

function typeByteOf(model: CpcModel): number {
  switch (model) {
    case 'cpc464': return TYPE_464;
    case 'cpc664': return TYPE_664;
    case 'cpc6128': return TYPE_6128;
    case 'cpc6128plus': return TYPE_6128PLUS;
    case 'gx4000': return TYPE_GX4000;
  }
}

function modelOfType(type: number): CpcModel {
  switch (type) {
    case TYPE_464: return 'cpc464';
    case TYPE_664: return 'cpc664';
    case TYPE_6128: return 'cpc6128';
    case TYPE_6128PLUS: return 'cpc6128plus';
    case TYPE_GX4000: return 'gx4000';
    default: return 'cpc6128';   // unknown → safest fallback
  }
}

function checkSignature(data: Uint8Array): void {
  if (data.length < HEADER_SIZE) {
    throw new Error(`SNA too small: ${data.length} bytes (need >= ${HEADER_SIZE})`);
  }
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (data[i] !== SIGNATURE[i]) throw new Error('Not a CPC .SNA file (bad signature)');
  }
}

/**
 * Peek at a snapshot's model + version without applying it, so the caller can
 * switch the running machine to the right model before applying state.
 */
export function readCpcSnaModel(data: Uint8Array): CpcSnaInfo {
  checkSignature(data);
  const version = data[0x10];
  let model: CpcSnaModel;
  if (version >= 2) {
    model = modelOfType(data[0x6D]);
  } else {
    // v1 has no type byte; infer from the RAM dump size in KB.
    const sizeKB = data[0x6B] | (data[0x6C] << 8);
    model = sizeKB > 64 ? 'cpc6128' : 'cpc464';
  }
  return { model, version };
}

// ── RLE codec (v3 MEM chunks) ──────────────────────────────────────────────

/**
 * Decode a v3 RLE stream into exactly `expected` bytes. A `0xE5` marker is
 * followed by a count: count 0 emits a single literal `0xE5`, otherwise the
 * next byte is the value to repeat `count` times. Non-marker bytes are literal.
 */
function rleDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let o = 0;
  let i = 0;
  while (i < src.length && o < expected) {
    const b = src[i++];
    if (b === RLE_MARKER) {
      const count = src[i++];
      if (count === 0) {
        out[o++] = RLE_MARKER;
      } else {
        const v = src[i++];
        for (let k = 0; k < count && o < expected; k++) out[o++] = v;
      }
    } else {
      out[o++] = b;
    }
  }
  return out;
}

/**
 * RLE-encode a 64K block. Runs of >= 4 identical bytes (and any `0xE5`, which
 * must be escaped) become `0xE5 count value`, split into runs of at most 255.
 */
function rleEncode(block: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const n = block.length;
  while (i < n) {
    const b = block[i];
    let run = 1;
    while (i + run < n && block[i + run] === b && run < 255) run++;
    if (b === RLE_MARKER || run >= 4) {
      out.push(RLE_MARKER, run, b);
    } else {
      for (let k = 0; k < run; k++) out.push(b);
    }
    i += run;
  }
  return Uint8Array.from(out);
}

// ── Memory image ────────────────────────────────────────────────────────────

/** Write `block` (up to 64K) into the four RAM banks starting at `baseBank`.
 *  Banks the machine does not have are skipped (getRamBank would otherwise
 *  alias them onto bank 0 and clobber base RAM). */
function applyBlock(m: CpcMachine, baseBank: number, block: Uint8Array): void {
  for (let s = 0; s < 4; s++) {
    if (baseBank + s >= m.memory.ramBankCount) break;
    const bank = m.memory.getRamBank(baseBank + s);
    bank.set(block.subarray(s * SLOT_SIZE, (s + 1) * SLOT_SIZE));
  }
}

/** Build a 64K block from the four RAM banks starting at `baseBank`. */
function readBlock(m: CpcMachine, baseBank: number): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  for (let s = 0; s < 4; s++) {
    block.set(m.memory.getRamBank(baseBank + s), s * SLOT_SIZE);
  }
  return block;
}

/** Memory dump size in bytes, from the header's KB count (0x6B–0x6C). */
function dumpBytes(data: Uint8Array): number {
  return (data[0x6B] | (data[0x6C] << 8)) * 1024;
}

/** Apply the flat memory dump that follows the header (every version): banks
 *  in physical order, base 64K first. Banks beyond the machine's RAM (or past
 *  the end of a truncated file) are skipped. */
function applyFlatMemory(m: CpcMachine, data: Uint8Array, bytes: number): void {
  const banks = Math.min(Math.ceil(bytes / SLOT_SIZE), m.memory.ramBankCount);
  for (let bank = 0; bank < banks; bank++) {
    const off = HEADER_SIZE + bank * SLOT_SIZE;
    if (off >= data.length) break;
    const end = Math.min(off + SLOT_SIZE, HEADER_SIZE + bytes);
    m.memory.getRamBank(bank).set(data.subarray(off, end));
  }
}

/** Apply the v3 chunks that follow the flat memory dump: "MEM0".."MEM8"
 *  (each a 64K block, used when the dump size is 0) and any Plus "ASIC"
 *  extension chunk. */
function applyChunks(m: CpcMachine, data: Uint8Array, start: number): void {
  let p = start;
  while (p + 8 <= data.length) {
    const id = String.fromCharCode(data[p], data[p + 1], data[p + 2], data[p + 3]);
    const len = (data[p + 4] | (data[p + 5] << 8) | (data[p + 6] << 16) | (data[p + 7] << 24)) >>> 0;
    p += 8;
    const body = data.subarray(p, p + len);
    p += len;
    const mem = /^MEM([0-9])$/.exec(id);
    if (mem) {
      const baseBank = Number(mem[1]) * 4;
      const block = len === BLOCK_SIZE ? body : rleDecode(body, BLOCK_SIZE);
      applyBlock(m, baseBank, block);
    } else if (id === 'ASIC' && cpcIsPlusClass(m.model)) {
      applyAsicChunk(m.gateArray as Asic, body);
    } else if (id === 'CPC+' && cpcIsPlusClass(m.model)) {
      applyCpcPlusChunk(m.gateArray as Asic, body);
    }
    // Other unknown chunks (CRTC/FDC/tape device state we don't model) are
    // skipped, matching the standard SNA chunk-skip behaviour.
  }
}

/** Layout of the "ASIC" chunk body:
 *    [0]     locked (1 byte)
 *    [1..0x4000]  registerPage (16 KB)
 *    [0x4001..0x4080]  asicPalette (32 × 4-byte ABGR = 128 bytes)
 *    [0x4081..0x4095]  DMA dynamic state (21 bytes, captureDmaState())
 *  Total: 0x4096 bytes. */
const ASIC_CHUNK_LOCKED_OFF = 0;
const ASIC_CHUNK_PAGE_OFF = 1;
const ASIC_CHUNK_PAGE_BYTES = 0x4000;
const ASIC_CHUNK_PAL_OFF = ASIC_CHUNK_PAGE_OFF + ASIC_CHUNK_PAGE_BYTES;
const ASIC_CHUNK_PAL_BYTES = 32 * 4;
const ASIC_CHUNK_DMA_OFF = ASIC_CHUNK_PAL_OFF + ASIC_CHUNK_PAL_BYTES;
const ASIC_CHUNK_DMA_BYTES = 21;

function applyAsicChunk(asic: Asic, body: Uint8Array): void {
  if (body.length < ASIC_CHUNK_DMA_OFF) return;
  const locked = body[ASIC_CHUNK_LOCKED_OFF] !== 0;
  const page = body.subarray(ASIC_CHUNK_PAGE_OFF, ASIC_CHUNK_PAGE_OFF + ASIC_CHUNK_PAGE_BYTES);
  const pal = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    const o = ASIC_CHUNK_PAL_OFF + i * 4;
    pal[i] = (body[o] | (body[o + 1] << 8) | (body[o + 2] << 16) | (body[o + 3] << 24)) >>> 0;
  }
  asic.restoreCoreState(locked, page, pal);
  if (body.length >= ASIC_CHUNK_DMA_OFF + ASIC_CHUNK_DMA_BYTES) {
    asic.restoreDmaState(body.subarray(ASIC_CHUNK_DMA_OFF, ASIC_CHUNK_DMA_OFF + ASIC_CHUNK_DMA_BYTES));
  }
}

/**
 * Apply the standard "CPC+" chunk (WinAPE and other v3 writers; layout per the
 * SNA v3 spec / cpcwiki). Offsets within the chunk body:
 *   000–7FF  sprite bitmaps, two 4-bit pixels per byte (bits 7–4 first) → &4000
 *   800–87F  16 × 8-byte sprite attributes (X 2, Y 2, mag 1, 3 unused) → &6000
 *   880–8BF  32 × 2-byte palette                                       → &6400
 *   8C0–8C5  PRI, split line, split address (hi, lo), scroll, vector   → &6800
 *   8C8–8CF  analogue inputs                                           → &6808
 *   8D0–8DB  3 × 4-byte DMA channel attributes (addr 2, prescaler 1)   → &6C00
 *   8DF      DMA control/status                                        → &6C0F
 *   8E0–8F4  3 × 7-byte DMA internals (loop count 2, loop addr 2,
 *            pause count 2, pause prescaler count 1)
 *   8F5      last RMR2 (gate array A0) value; 8F6 lock (1 = unlocked)
 * Registers go through the ASIC's own write decode so derived state (palette,
 * scroll, split, DMA sources) is rebuilt exactly as a live write would.
 */
function applyCpcPlusChunk(asic: Asic, body: Uint8Array): void {
  if (body.length < 0x8F7) return;
  const unlocked = body[0x8F6] !== 0;
  const page = new Uint8Array(0x4000);
  for (let i = 0; i < 0x800; i++) {
    page[i * 2] = body[i] >> 4;
    page[i * 2 + 1] = body[i] & 0x0F;
  }
  for (let spr = 0; spr < 16; spr++) {
    for (let k = 0; k < 5; k++) page[0x2000 + spr * 8 + k] = body[0x800 + spr * 8 + k];
  }
  for (let i = 0; i < 8; i++) page[0x2808 + i] = body[0x8C8 + i];
  asic.restoreCoreState(!unlocked, page, asic.asicPalette);

  for (let i = 0; i < 64; i++) asic.cpuWrite(0x2400 + i, body[0x880 + i]);
  for (let i = 0; i < 6; i++) asic.cpuWrite(0x2800 + i, body[0x8C0 + i]);
  for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 3; k++) asic.cpuWrite(0x2C00 + c * 4 + k, body[0x8D0 + c * 4 + k]);
  }

  // DMA dynamic state, in captureDmaState() layout (pause ticks 2, loops 1,
  // loop address 2, enabled 1, int pending 1). The pause is kept as a count
  // of HSYNC ticks, so the spec's pause count scales by the prescaler.
  const dcsr = body[0x8DF];
  const dma = new Uint8Array(21);
  for (let c = 0; c < 3; c++) {
    const src = 0x8E0 + c * 7;
    const prescaler = body[0x8D0 + c * 4 + 2];
    const pause = (body[src + 4] | (body[src + 5] << 8)) & 0x0FFF;
    const ticks = pause * (prescaler + 1);
    const o = c * 7;
    dma[o] = ticks & 0xFF;
    dma[o + 1] = (ticks >> 8) & 0xFF;
    dma[o + 2] = body[src];                       // loop count (≤ 0x7FF, low byte kept)
    dma[o + 3] = body[src + 2];
    dma[o + 4] = body[src + 3];
    dma[o + 5] = (dcsr >> c) & 1;
    dma[o + 6] = (dcsr >> (4 + c)) & 1;
  }
  asic.restoreDmaState(dma);

  // RMR2 (only meaningful — and only decoded — while unlocked).
  const rmr2 = body[0x8F5];
  if (unlocked && (rmr2 & 0xE0) === 0xA0) asic.write(rmr2);
}

/** Serialise the ASIC chunk body for saveCpcSna. */
function buildAsicChunk(asic: Asic): Uint8Array {
  const out = new Uint8Array(ASIC_CHUNK_DMA_OFF + ASIC_CHUNK_DMA_BYTES);
  out[ASIC_CHUNK_LOCKED_OFF] = asic.locked ? 1 : 0;
  out.set(asic.registerPage, ASIC_CHUNK_PAGE_OFF);
  for (let i = 0; i < 32; i++) {
    const v = asic.asicPalette[i] >>> 0;
    const o = ASIC_CHUNK_PAL_OFF + i * 4;
    out[o] = v & 0xFF;
    out[o + 1] = (v >>> 8) & 0xFF;
    out[o + 2] = (v >>> 16) & 0xFF;
    out[o + 3] = (v >>> 24) & 0xFF;
  }
  const dma = asic.captureDmaState();
  out.set(dma, ASIC_CHUNK_DMA_OFF);
  return out;
}

// ── Load ─────────────────────────────────────────────────────────────────────

/**
 * Apply a parsed `.SNA` to a machine that already matches the snapshot's model
 * (call readCpcSnaModel + switchModel first). The caller stops/starts the loop.
 */
export function applyCpcSna(data: Uint8Array, m: CpcMachine): void {
  checkSignature(data);
  const version = data[0x10];
  const cpu = m.cpu;

  // Z80 registers (0x11–0x2D).
  cpu.f = data[0x11];  cpu.a = data[0x12];
  cpu.c = data[0x13];  cpu.b = data[0x14];
  cpu.e = data[0x15];  cpu.d = data[0x16];
  cpu.l = data[0x17];  cpu.h = data[0x18];
  cpu.r = data[0x19];  cpu.i = data[0x1A];
  cpu.iff1 = (data[0x1B] & 1) !== 0;
  cpu.iff2 = (data[0x1C] & 1) !== 0;
  cpu.ix = data[0x1D] | (data[0x1E] << 8);
  cpu.iy = data[0x1F] | (data[0x20] << 8);
  cpu.sp = data[0x21] | (data[0x22] << 8);
  cpu.pc = data[0x23] | (data[0x24] << 8);
  cpu.im = data[0x25] & 0x03;
  cpu.f_ = data[0x26]; cpu.a_ = data[0x27];
  cpu.c_ = data[0x28]; cpu.b_ = data[0x29];
  cpu.e_ = data[0x2A]; cpu.d_ = data[0x2B];
  cpu.l_ = data[0x2C]; cpu.h_ = data[0x2D];
  cpu.halted = false;
  cpu.eiDelay = false;

  // Gate Array: selected pen (bit4 = border), 17 pen colours, screen mode + ROM
  // enable (from the RMR byte at 0x40).
  const penByte = data[0x2E];
  const selectedPen = (penByte & 0x10) ? 16 : (penByte & 0x0F);
  const pens = data.subarray(0x2F, 0x2F + 17);
  const rmr = data[0x40];
  m.gateArray.restoreState(selectedPen, rmr & 0x03, pens);

  // Memory paging: RAM config (0x41) + ROM enable (from RMR) + upper ROM (0x55).
  const ramByte = data[0x41];
  m.memory.restorePaging({
    ramConfig: ramByte & 0x07,
    ram64kBlock: (ramByte >> 3) & 0x07,
    lowerRomEnabled: (rmr & 0x04) === 0,
    upperRomEnabled: (rmr & 0x08) === 0,
    selectedUpperRom: data[0x55],
  });

  // CRTC: 18 registers (0x43–0x54) then the selected register index (0x42).
  // R0–R15 go through the chip's write path so each keeps only its
  // implemented bits; R16/R17 (light pen, CPU read-only) are set directly.
  for (let i = 0; i < 16; i++) { m.crtc.selectRegister(i); m.crtc.writeRegister(data[0x43 + i]); }
  m.crtc.regs[16] = data[0x43 + 16] & 0x3F;
  m.crtc.regs[17] = data[0x43 + 17];
  m.crtc.selectRegister(data[0x42]);

  // PPI 8255: port A/C latches + control (port B at 0x57 is input-only).
  m.ppi.setState({ portA: data[0x56], portC: data[0x58], control: data[0x59] });

  // PSG: 16 registers (0x5B–0x6A) then the selected register (0x5A). setRegisters
  // recomputes the derived tone/noise/envelope state.
  m.ay.setRegisters(data.subarray(0x5B, 0x5B + 16));
  m.ay.selectedReg = data[0x5A] & 0x0F;

  // v3 Gate Array interrupt state: the HSYNC-after-VSYNC delay counter (0xB2),
  // the 52-line interrupt counter (0xB3) and the pending request (0xB4). The
  // CRTC's internal counters (0xA9–0xB1) are not restored: the frame loop
  // restarts the CRTC raster at each host frame, so it can only resume at a
  // frame boundary (which is where this emulator's own saves are taken).
  if (version >= 3) {
    m.gateArray.rasterCount = Math.min(data[0xB3], 51);
    m.gateArray.interruptRequested = data[0xB4] !== 0;
    m.vsyncResyncCountdown = resyncCountdownOf(data[0xB2]);
  }

  // Memory image. Every version carries a flat dump sized by 0x6B–0x6C right
  // after the header (v1 CPCEMU files may leave the size at 0; assume the
  // model's full RAM then). In v3 the chunks follow that dump — a writer that
  // uses "MEMn" chunks sets the dump size to 0 so they start at 0x100.
  if (version >= 3) {
    const bytes = dumpBytes(data);
    applyFlatMemory(m, data, bytes);
    applyChunks(m, data, HEADER_SIZE + bytes);
  } else {
    const bytes = dumpBytes(data) || banksFor(m.model) * SLOT_SIZE;
    applyFlatMemory(m, data, bytes);
  }
}

/** The .SNA "GA vsync delay counter" counts HSYNCs since VSYNC began (1 or 2
 *  while active, 0 idle); the machine counts down the HSYNCs still to come
 *  before the re-sync fires on the 2nd one. 1 → 2 to go, 2 → 1 to go. */
function resyncCountdownOf(snaCount: number): number {
  return snaCount === 1 || snaCount === 2 ? 3 - snaCount : 0;
}

function snaResyncCountOf(countdown: number): number {
  return countdown === 1 || countdown === 2 ? 3 - countdown : 0;
}

/** .SNA v3 CRTC type byte (0xA4): 0 = HD6845S/UM6845, 1 = UM6845R, 2 = MC6845,
 *  3 = the CPC+ ASIC's 6845 (our type 4). */
function snaCrtcTypeOf(type: number): number {
  return type === 4 ? 3 : type === 3 ? 4 : type;
}

// ── Save ─────────────────────────────────────────────────────────────────────

/**
 * Serialise a machine to `.SNA` v2 (flat memory) or v3 (RLE-compressed MEM
 * chunks).
 */
export function saveCpcSna(m: CpcMachine, version: 2 | 3): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  header.set(SIGNATURE, 0);
  header[0x10] = version;

  const cpu = m.cpu;
  header[0x11] = cpu.f;  header[0x12] = cpu.a;
  header[0x13] = cpu.c;  header[0x14] = cpu.b;
  header[0x15] = cpu.e;  header[0x16] = cpu.d;
  header[0x17] = cpu.l;  header[0x18] = cpu.h;
  header[0x19] = cpu.r;  header[0x1A] = cpu.i;
  header[0x1B] = cpu.iff1 ? 1 : 0;
  header[0x1C] = cpu.iff2 ? 1 : 0;
  header[0x1D] = cpu.ix & 0xFF; header[0x1E] = (cpu.ix >> 8) & 0xFF;
  header[0x1F] = cpu.iy & 0xFF; header[0x20] = (cpu.iy >> 8) & 0xFF;
  header[0x21] = cpu.sp & 0xFF; header[0x22] = (cpu.sp >> 8) & 0xFF;
  header[0x23] = cpu.pc & 0xFF; header[0x24] = (cpu.pc >> 8) & 0xFF;
  header[0x25] = cpu.im & 0x03;
  header[0x26] = cpu.f_; header[0x27] = cpu.a_;
  header[0x28] = cpu.c_; header[0x29] = cpu.b_;
  header[0x2A] = cpu.e_; header[0x2B] = cpu.d_;
  header[0x2C] = cpu.l_; header[0x2D] = cpu.h_;

  // Gate Array.
  const sel = m.gateArray.selectedPenIndex;
  header[0x2E] = sel === 16 ? 0x10 : (sel & 0x0F);
  for (let i = 0; i < 17; i++) header[0x2F + i] = m.gateArray.pens[i] & 0x1F;

  const paging = m.memory.pagingState();
  // RMR byte: function 0x80, mode in bits 0–1, ROM disables in bits 2–3.
  header[0x40] = 0x80 |
    (paging.upperRomEnabled ? 0 : 0x08) |
    (paging.lowerRomEnabled ? 0 : 0x04) |
    (m.gateArray.mode & 0x03);
  // RAM config byte: function 0xC0, 64K block in bits 3–5, config in bits 0–2.
  header[0x41] = 0xC0 | ((paging.ram64kBlock & 0x07) << 3) | (paging.ramConfig & 0x07);

  // CRTC.
  header[0x42] = m.crtc.selectedRegister & 0x1F;
  for (let i = 0; i < 18; i++) header[0x43 + i] = m.crtc.regs[i];

  // pagingState().selectedUpperRom is already the physical cartridge page
  // (post logical→physical translation — see selectUpperRom). On the Plus,
  // .SNA byte 0x55 must carry the raw OUT &DFxx form: bit 7 set selects a
  // page directly (n & 0x1F), which round-trips exactly through the loader's
  // translation. Writing the physical page as a bare (bit7-clear) byte would
  // instead be reinterpreted as a firmware ROM number on load. Non-Plus
  // models have no translation to begin with, so the raw value round-trips
  // as-is.
  header[0x55] = cpcIsPlusClass(m.model)
    ? (0x80 | (paging.selectedUpperRom & 0x1F))
    : (paging.selectedUpperRom & 0xFF);

  // PPI.
  const ppi = m.ppi.getState();
  header[0x56] = ppi.portA;
  header[0x57] = m.ppi.readB();
  header[0x58] = ppi.portC;
  header[0x59] = ppi.control;

  // PSG.
  header[0x5A] = m.ay.selectedReg & 0x0F;
  for (let i = 0; i < 16; i++) header[0x5B + i] = m.ay.regs[i];

  const banks = banksFor(m.model);
  const sizeKB = banks * 16;
  header[0x6D] = typeByteOf(m.model);

  if (version >= 3) {
    // v3 device state: CRTC type and the Gate Array interrupt counters.
    header[0xA4] = snaCrtcTypeOf(m.config.crtcType);
    header[0xB2] = snaResyncCountOf(m.vsyncResyncCountdown);
    header[0xB3] = m.gateArray.rasterCount & 0x3F;
    header[0xB4] = m.gateArray.interruptRequested ? 1 : 0;
    // v3: memory size 0 in the header; memory follows as MEM chunks.
    header[0x6B] = 0; header[0x6C] = 0;
    const parts: Uint8Array[] = [header];
    const blocks = banks / 4; // 64K per chunk
    for (let blk = 0; blk < blocks; blk++) {
      const block = readBlock(m, blk * 4);
      const enc = rleEncode(block);
      const compressed = enc.length < BLOCK_SIZE;
      const body = compressed ? enc : block;
      const len = body.length;
      const chunkHeader = new Uint8Array(8);
      chunkHeader[0] = 0x4D; chunkHeader[1] = 0x45; chunkHeader[2] = 0x4D; // "MEM"
      chunkHeader[3] = 0x30 + blk;                                          // '0' + n
      chunkHeader[4] = len & 0xFF;
      chunkHeader[5] = (len >> 8) & 0xFF;
      chunkHeader[6] = (len >> 16) & 0xFF;
      chunkHeader[7] = (len >> 24) & 0xFF;
      parts.push(chunkHeader, body);
    }
    // Plus extension: an "ASIC" chunk after the MEM chunks carries the ASIC
    // register page, palette, and DMA dynamic state. Non-Plus models omit
    // it; older loaders skip unknown chunks (standard SNA behaviour).
    if (cpcIsPlusClass(m.model)) {
      const body = buildAsicChunk(m.gateArray as Asic);
      const chunkHeader = new Uint8Array(8);
      chunkHeader[0] = 0x41; chunkHeader[1] = 0x53; chunkHeader[2] = 0x49; chunkHeader[3] = 0x43; // "ASIC"
      chunkHeader[4] = body.length & 0xFF;
      chunkHeader[5] = (body.length >> 8) & 0xFF;
      chunkHeader[6] = (body.length >> 16) & 0xFF;
      chunkHeader[7] = (body.length >> 24) & 0xFF;
      parts.push(chunkHeader, body);
    }
    return concat(parts);
  }

  // v2: flat memory dump.
  header[0x6B] = sizeKB & 0xFF; header[0x6C] = (sizeKB >> 8) & 0xFF;
  const out = new Uint8Array(HEADER_SIZE + banks * SLOT_SIZE);
  out.set(header, 0);
  for (let bank = 0; bank < banks; bank++) {
    out.set(m.memory.getRamBank(bank), HEADER_SIZE + bank * SLOT_SIZE);
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
