/**
 * Amstrad CPC `.SNA` snapshot loader and saver (the CPCEMU/WinAPE format).
 *
 * One 256-byte little-endian header followed by a memory image. Three header
 * versions exist and are all accepted on load:
 *
 *   - v1: 64K/128K memory dumped flat right after the header.
 *   - v2: adds a CPC-type byte (0x6D); memory still flat.
 *   - v3: memory moved into "MEM0".."MEM8" chunks (64K each) after the header,
 *     each optionally RLE-compressed; plus optional device chunks we skip.
 *
 * Save writes v2 (flat, uncompressed) or v3 (RLE-compressed MEM chunks). Unlike
 * the Spectrum loaders, this works on the whole CpcMachine: a CPC snapshot spans
 * the Z80, RAM banks, Gate Array, CRTC, PPI and PSG.
 */

import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { CpcModel } from '@/models.ts';

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

/** RAM banks for a model (4 = 64K for 464/664, 8 = 128K for 6128). */
function banksFor(model: CpcModel): number {
  return model === 'cpc6128' ? 8 : 4;
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
    const type = data[0x6D];
    model = type === 0 ? 'cpc464' : type === 1 ? 'cpc664' : 'cpc6128';
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

/** Write `block` (up to 64K) into the four RAM banks starting at `baseBank`. */
function applyBlock(m: CpcMachine, baseBank: number, block: Uint8Array): void {
  for (let s = 0; s < 4; s++) {
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

/** Apply v1/v2 flat memory (banks in physical order right after the header). */
function applyFlatMemory(m: CpcMachine, data: Uint8Array, banks: number): void {
  for (let bank = 0; bank < banks; bank++) {
    const off = HEADER_SIZE + bank * SLOT_SIZE;
    if (off >= data.length) break;
    m.memory.getRamBank(bank).set(data.subarray(off, off + SLOT_SIZE));
  }
}

/** Apply v3 chunked memory ("MEM0".."MEM8", each a 64K block). */
function applyChunkedMemory(m: CpcMachine, data: Uint8Array): void {
  let p = HEADER_SIZE;
  while (p + 8 <= data.length) {
    const id = String.fromCharCode(data[p], data[p + 1], data[p + 2], data[p + 3]);
    const len = data[p + 4] | (data[p + 5] << 8) | (data[p + 6] << 16) | (data[p + 7] << 24);
    p += 8;
    const body = data.subarray(p, p + len);
    p += len;
    const mem = /^MEM([0-9])$/.exec(id);
    if (mem) {
      const baseBank = Number(mem[1]) * 4;
      const block = len === BLOCK_SIZE ? body : rleDecode(body, BLOCK_SIZE);
      applyBlock(m, baseBank, block);
    }
    // Unknown chunks (CRTC/FDC/tape device state we don't model) are skipped.
  }
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
  for (let i = 0; i < 18; i++) m.crtc.regs[i] = data[0x43 + i];
  m.crtc.selectRegister(data[0x42]);

  // PPI 8255: port A/C latches + control (port B at 0x57 is input-only).
  m.ppi.setState({ portA: data[0x56], portC: data[0x58], control: data[0x59] });

  // PSG: 16 registers (0x5B–0x6A) then the selected register (0x5A). setRegisters
  // recomputes the derived tone/noise/envelope state.
  m.ay.setRegisters(data.subarray(0x5B, 0x5B + 16));
  m.ay.selectedReg = data[0x5A] & 0x0F;

  // Memory image.
  if (version >= 3) applyChunkedMemory(m, data);
  else applyFlatMemory(m, data, banksFor(m.model));
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

  header[0x55] = paging.selectedUpperRom & 0xFF;

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
  // CPC type byte (v2+): 464=0, 664=1, 6128=2.
  header[0x6D] = m.model === 'cpc464' ? 0 : m.model === 'cpc664' ? 1 : 2;

  if (version >= 3) {
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
