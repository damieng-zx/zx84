/**
 * SAM Coupé native machine state.
 *
 * This is NOT an interchange format. It exists only so a browser refresh can
 * resume where it left off (`SnapshotService.saveSync` / `restoreSync`), and
 * it is never written to a file the user sees. There is deliberately no `.sna`
 * or similar here: SimCoupe, the reference SAM emulator, has no snapshot
 * handling at all, so there is nothing to interoperate with and inventing a
 * plausible-looking file format would be worse than having none.
 *
 * The shell base64-encodes the result into localStorage, which is a ~5 MB
 * budget for the whole origin. A 512K machine would be ~700 KB encoded raw,
 * and a 1 MB-expanded one over 2 MB, so the RAM blocks are packed first. RAM
 * is overwhelmingly repetitive after boot — mostly zeros, plus a screen — and
 * PackBits handles that in a few lines with a bounded worst case (+1 byte per
 * 128), which matters because `saveSync` runs from a `beforeunload` handler
 * and cannot use the async CompressionStream.
 */

import type { Z80 } from '@/cores/z80.ts';
import type { SamMemory } from '../sam-memory.ts';
import type { SamAsic } from '../asic.ts';
import type { SAA1099 } from '@/cores/saa1099.ts';
import { SAM_PAGE_SIZE } from '../constants.ts';

/** Magic + version. Bump the version if the layout below ever changes. */
const MAGIC = 'ZX84SAM1';
const VERSION = 1;

// ── PackBits ────────────────────────────────────────────────────────────────
//
// Control byte: high bit set means a run — (c & 0x7F) + 1 copies of the next
// byte. High bit clear means a literal — c + 1 bytes follow verbatim.

const MAX_SPAN = 128;

export function pack(src: Uint8Array): Uint8Array {
  // Worst case is all-literal: one control byte per 128 data bytes.
  const out = new Uint8Array(src.length + Math.ceil(src.length / MAX_SPAN) + 1);
  let o = 0;
  let i = 0;
  while (i < src.length) {
    // How long is the run starting here?
    let run = 1;
    while (run < MAX_SPAN && i + run < src.length && src[i + run] === src[i]) run++;

    if (run >= 2) {
      out[o++] = 0x80 | (run - 1);
      out[o++] = src[i];
      i += run;
      continue;
    }

    // No run worth encoding: gather literals until one starts.
    let lit = 1;
    while (
      lit < MAX_SPAN
      && i + lit < src.length
      && !(i + lit + 1 < src.length && src[i + lit] === src[i + lit + 1])
    ) lit++;

    out[o++] = lit - 1;
    out.set(src.subarray(i, i + lit), o);
    o += lit;
    i += lit;
  }
  return out.subarray(0, o);
}

export function unpack(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let o = 0;
  let i = 0;
  while (i < src.length && o < expected) {
    const c = src[i++];
    if (c & 0x80) {
      const n = (c & 0x7F) + 1;
      const v = src[i++];
      out.fill(v, o, Math.min(o + n, expected));
      o += n;
    } else {
      const n = c + 1;
      out.set(src.subarray(i, i + Math.min(n, expected - o)), o);
      i += n;
      o += n;
    }
  }
  return out;
}

// ── Cursor over a growable byte buffer ──────────────────────────────────────

class Writer {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private need(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void { this.need(1); this.buf[this.pos++] = v & 0xFF; }
  u16(v: number): void { this.need(2); this.view.setUint16(this.pos, v & 0xFFFF); this.pos += 2; }
  u32(v: number): void { this.need(4); this.view.setUint32(this.pos, v >>> 0); this.pos += 4; }
  bytes(b: Uint8Array): void { this.need(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  ascii(s: string): void { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  result(): Uint8Array { return this.buf.slice(0, this.pos); }
}

class Reader {
  private view: DataView;
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8(): number { return this.buf[this.pos++]; }
  u16(): number { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  bytes(n: number): Uint8Array { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  get exhausted(): boolean { return this.pos >= this.buf.length; }
}

/** What a save/restore operates on — the machine's own pieces. The two latches
 *  are mutable because they live on the machine rather than in any chip. */
export interface SamStateTarget {
  readonly cpu: Z80;
  readonly memory: SamMemory;
  readonly asic: SamAsic;
  readonly psg: SAA1099;
  beeperBit: number;
  micBit: number;
}

/** Model ids, so a restore refuses state saved on differently-sized hardware. */
const MODEL_ID: Record<string, number> = { sam256: 0, sam512: 1, sam1m: 2 };

function packedBlock(w: Writer, data: Uint8Array): void {
  const packed = pack(data);
  w.u32(data.length);
  w.u32(packed.length);
  w.bytes(packed);
}

function readPackedBlock(r: Reader): Uint8Array {
  const raw = r.u32();
  const len = r.u32();
  return unpack(r.bytes(len), raw);
}

export function serializeSamState(m: SamStateTarget, model: string): Uint8Array {
  const w = new Writer();
  w.ascii(MAGIC);
  w.u8(VERSION);
  w.u8(MODEL_ID[model] ?? 0xFF);
  w.u16(0);                                   // reserved

  // ── CPU ──
  const c = m.cpu;
  for (const v of [c.a, c.f, c.b, c.c, c.d, c.e, c.h, c.l]) w.u8(v);
  for (const v of [c.a_, c.f_, c.b_, c.c_, c.d_, c.e_, c.h_, c.l_]) w.u8(v);
  for (const v of [c.ix, c.iy, c.sp, c.pc, c.memptr]) w.u16(v);
  w.u8(c.i); w.u8(c.r); w.u8(c.im);
  w.u8((c.iff1 ? 1 : 0) | (c.iff2 ? 2 : 0) | (c.halted ? 4 : 0) | (c.eiDelay ? 8 : 0));
  w.u32(c.tStates);
  w.u8(c._qReg); w.u8(c._prevQ);

  // ── ASIC ──
  w.bytes(m.asic.clut);
  w.u8(m.asic.borderIndex);
  w.u8(m.asic.screenOff ? 1 : 0);
  w.u8(m.asic.status);
  w.u16(m.asic.lineReg & 0xFFFF);             // -1 stores as 0xFFFF
  w.u8(m.beeperBit);
  w.u8(m.micBit);

  // ── Sound ──
  w.bytes(m.psg.registerFile());

  // ── Paging ──
  const mem = m.memory;
  w.u8(mem.lmpr); w.u8(mem.hmpr); w.u8(mem.vmpr); w.u8(mem.lepr); w.u8(mem.hepr);

  // ── RAM ──
  const internal = new Uint8Array(mem.internalPageCount * SAM_PAGE_SIZE);
  for (let p = 0; p < mem.internalPageCount; p++) {
    internal.set(mem.getRamBank(p), p * SAM_PAGE_SIZE);
  }
  packedBlock(w, internal);

  const extCount = mem.externalPageCount;
  const external = new Uint8Array(extCount * SAM_PAGE_SIZE);
  for (let p = 0; p < extCount; p++) {
    external.set(mem.externalPage(p)!, p * SAM_PAGE_SIZE);
  }
  packedBlock(w, external);

  return w.result();
}

/** Restore state onto the SAME model. Returns false when it does not apply. */
export function applySamState(m: SamStateTarget, model: string, data: Uint8Array): boolean {
  if (data.length < MAGIC.length + 4) return false;
  const r = new Reader(data);
  if (r.ascii(MAGIC.length) !== MAGIC) return false;
  if (r.u8() !== VERSION) return false;
  // State only restores on the hardware it was taken from: the models differ
  // in how many pages answer, so page counts would not line up.
  if (r.u8() !== (MODEL_ID[model] ?? 0xFF)) return false;
  r.u16();

  const c = m.cpu;
  c.a = r.u8(); c.f = r.u8(); c.b = r.u8(); c.c = r.u8();
  c.d = r.u8(); c.e = r.u8(); c.h = r.u8(); c.l = r.u8();
  c.a_ = r.u8(); c.f_ = r.u8(); c.b_ = r.u8(); c.c_ = r.u8();
  c.d_ = r.u8(); c.e_ = r.u8(); c.h_ = r.u8(); c.l_ = r.u8();
  c.ix = r.u16(); c.iy = r.u16(); c.sp = r.u16(); c.pc = r.u16(); c.memptr = r.u16();
  c.i = r.u8(); c.r = r.u8(); c.im = r.u8();
  const flags = r.u8();
  c.iff1 = (flags & 1) !== 0;
  c.iff2 = (flags & 2) !== 0;
  c.halted = (flags & 4) !== 0;
  c.eiDelay = (flags & 8) !== 0;
  c.tStates = r.u32();
  c._qReg = r.u8(); c._prevQ = r.u8();

  const asic = m.asic;
  asic.clut.set(r.bytes(16));
  asic.borderIndex = r.u8();
  asic.screenOff = r.u8() !== 0;
  asic.status = r.u8();
  const line = r.u16();
  asic.lineReg = line === 0xFFFF ? -1 : line;
  m.beeperBit = r.u8();
  m.micBit = r.u8();

  m.psg.restoreRegisterFile(r.bytes(32));

  const mem = m.memory;
  const lmpr = r.u8(), hmpr = r.u8(), vmpr = r.u8(), lepr = r.u8(), hepr = r.u8();

  const internal = readPackedBlock(r);
  for (let p = 0; p < mem.internalPageCount; p++) {
    const off = p * SAM_PAGE_SIZE;
    if (off >= internal.length) break;
    mem.getRamBank(p).set(internal.subarray(off, off + SAM_PAGE_SIZE));
  }

  const external = r.exhausted ? new Uint8Array(0) : readPackedBlock(r);
  for (let p = 0; p < mem.externalPageCount; p++) {
    const off = p * SAM_PAGE_SIZE;
    if (off >= external.length) break;
    mem.externalPage(p)!.set(external.subarray(off, off + SAM_PAGE_SIZE));
  }

  // Paging last, so the section pointers are rebuilt against restored RAM.
  mem.setLepr(lepr);
  mem.setHepr(hepr);
  mem.setHmpr(hmpr);
  mem.setLmpr(lmpr);
  mem.setVmpr(vmpr);

  return true;
}
