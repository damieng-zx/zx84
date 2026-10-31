/**
 * UEF (Unified Emulator Format) cassette images — the tape format of the BBC
 * Micro and Acorn Electron.
 *
 * A UEF file is the 10-byte signature `UEF File!\0`, a two-byte version, then a
 * list of chunks (u16 id, u32 length, payload), optionally gzip-wrapped. The
 * tape chunks describe the cassette at the level of Kansas City / BYTE
 * modulation: a `0` bit is one cycle of the base frequency (1200 Hz) and a `1`
 * bit is two cycles of twice that, at 1200 baud (four and eight cycles at 300).
 *
 * This codec turns the chunk list into the deck's pulse blocks: every data and
 * carrier chunk becomes a `csw` block of half-cycle lengths and every gap a
 * `pause`, so a UEF plays through the same pulse-level `TapeDeck` as a CSW
 * capture and the machine's own receiver decodes the tone. The BBC's serial ULA
 * and the Electron's ULA both do exactly that on the real hardware.
 *
 * Supported chunks: 0100 (8N1 data), 0102 (explicit bits), 0104 (defined
 * format), 0110/0111 (carrier, with dummy byte), 0112/0116 (integer and float
 * gap), 0113 (base frequency), 0117 (baud rate) and 0000 (origin text). The
 * remaining chunks (security cycles, phase change, markers, disc images) carry
 * nothing the receiver needs and are skipped.
 *
 * References: https://beebwiki.mdfs.net/UEF (chunk definitions), the BBC
 * Microcomputer User Guide (cassette format).
 */

import type { CswBlock, PauseBlock, TapeBlock } from '@/media/tape/tap.ts';
import { TAPE_REF_HZ } from '@/media/tape/tap.ts';
import type { StateSink, StateSource } from '@/utils/state-stream.ts';

const UEF_SIGNATURE = [0x55, 0x45, 0x46, 0x20, 0x46, 0x69, 0x6C, 0x65, 0x21, 0x00];

/** Default tape speed and base (zero-bit) frequency. */
export const UEF_DEFAULT_BAUD = 1200;
export const UEF_DEFAULT_BASE_HZ = 1200;

export interface UefChunk {
  readonly id: number;
  readonly data: Uint8Array;
}

export function isGzip(data: Uint8Array): boolean {
  return data.length > 2 && data[0] === 0x1F && data[1] === 0x8B;
}

/** True when `data` (plain or gzip-wrapped) looks like a UEF image. Gzip is
 *  only sniffed, not inflated: the signature check happens after unwrapping. */
export function looksLikeUef(data: Uint8Array): boolean {
  if (isGzip(data)) return true;
  if (data.length < 12) return false;
  return UEF_SIGNATURE.every((b, i) => data[i] === b);
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(data as unknown as BufferSource).catch(() => {});
  writer.close().catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Split an inflated UEF image into its chunks. Throws on a bad signature; a
 *  truncated final chunk is kept as far as it goes. */
export function parseUefChunks(raw: Uint8Array): UefChunk[] {
  if (raw.length < 12 || !UEF_SIGNATURE.every((b, i) => raw[i] === b)) {
    throw new Error('Not a UEF file');
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const chunks: UefChunk[] = [];
  let pos = 12;
  while (pos + 6 <= raw.length) {
    const id = view.getUint16(pos, true);
    const len = view.getUint32(pos + 2, true);
    pos += 6;
    chunks.push({ id, data: raw.subarray(pos, Math.min(raw.length, pos + len)) });
    pos += len;
  }
  return chunks;
}

/** Growable pulse list. */
class PulseBuf {
  private buf = new Uint32Array(1024);
  length = 0;
  push(v: number): void {
    if (this.length === this.buf.length) {
      const bigger = new Uint32Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.length++] = v;
  }
  take(): Uint32Array {
    const out = this.buf.slice(0, this.length);
    this.length = 0;
    return out;
  }
}

/** Describe a data chunk that holds a BBC/Electron cassette-filing-system
 *  block: `*` sync, a zero-terminated name, then load/exec/block number/length/
 *  flags. Returns null for anything that isn't one. */
export function describeCfsBlock(bytes: Uint8Array): { label: string; detail: string } | null {
  let p = bytes.indexOf(0x2A);
  if (p < 0 || p > 8) return null;                 // allow a leading dummy byte or two
  p++;
  let name = '';
  while (p < bytes.length && bytes[p] !== 0 && name.length < 10) name += String.fromCharCode(bytes[p++]);
  if (p >= bytes.length || bytes[p] !== 0) return null;
  p++;
  if (p + 17 > bytes.length) return null;
  const u32 = (o: number): number => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  const u16 = (o: number): number => bytes[o] | (bytes[o + 1] << 8);
  const load = u32(p), exec = u32(p + 4), block = u16(p + 8), len = u16(p + 10), flag = bytes[p + 12];
  const hex = (n: number, w: number): string => n.toString(16).toUpperCase().padStart(w, '0');
  const last = (flag & 0x80) !== 0;
  const label = `${name || '(no name)'} block ${hex(block, 2)}${last ? ' (last)' : ''}`;
  const detail = block === 0
    ? `${len} bytes · load &${hex(load, 8)} exec &${hex(exec, 8)}`
    : `${len} bytes`;
  return { label, detail };
}

function readFloat(d: Uint8Array, off = 0): number {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getFloat32(off, true);
}

/** Convert a chunk list to pulse blocks. */
export function uefChunksToBlocks(chunks: readonly UefChunk[]): TapeBlock[] {
  const blocks: TapeBlock[] = [];
  let baud = UEF_DEFAULT_BAUD;
  let baseHz = UEF_DEFAULT_BASE_HZ;
  const pb = new PulseBuf();
  // Running ideal vs emitted time (3.5MHz ticks), so rounding each half-cycle
  // to whole ticks never accumulates into tone drift.
  let ideal = 0;
  let emitted = 0;

  const half = (hz: number): void => {
    ideal += TAPE_REF_HZ / (2 * hz);
    const p = Math.max(1, Math.round(ideal) - emitted);
    emitted += p;
    pb.push(p);
  };
  const cycles = (n: number, hz: number): void => { for (let i = 0; i < n * 2; i++) half(hz); };
  const bit = (b: number): void => {
    if (b) cycles(Math.max(1, Math.round((2 * baseHz) / baud)), 2 * baseHz);
    else cycles(Math.max(1, Math.round(baseHz / baud)), baseHz);
  };
  const frame = (byte: number, bits: number, parity: string, stop: number): void => {
    bit(0);
    let ones = 0;
    for (let i = 0; i < bits; i++) { const v = (byte >> i) & 1; ones += v; bit(v); }
    if (parity === 'E') bit(ones & 1);
    else if (parity === 'O') bit((ones & 1) ^ 1);
    for (let i = 0; i < stop; i++) bit(1);
  };
  const flush = (extra: Partial<CswBlock>): void => {
    if (pb.length === 0) return;
    blocks.push({ kind: 'csw', pulses: pb.take(), ...extra });
  };
  const gap = (seconds: number): void => {
    const ms = Math.max(1, Math.round(seconds * 1000));
    blocks.push({ kind: 'pause', duration: ms } satisfies PauseBlock);
    ideal = 0; emitted = 0;
  };
  const carrier = (n: number): void => cycles(n, 2 * baseHz);
  const carrierSeconds = (n: number): string => `${(n / (2 * baseHz)).toFixed(n / (2 * baseHz) < 10 ? 1 : 0)}s`;

  for (const { id, data } of chunks) {
    switch (id) {
      case 0x0100: {                                  // 8N1 data
        for (const byte of data) frame(byte, 8, 'N', 1);
        const cfs = describeCfsBlock(data);
        flush({
          role: 'data',
          label: cfs?.label ?? `Data`,
          detail: cfs?.detail ?? `${data.length} bytes`,
        });
        break;
      }
      case 0x0104: {                                  // defined-format data
        if (data.length < 3) break;
        const bits = data[0];
        const parity = String.fromCharCode(data[1]);
        const stop = Math.abs((data[2] << 24) >> 24) || 1;
        const payload = data.subarray(3);
        for (const byte of payload) frame(byte, bits, parity, stop);
        flush({ role: 'data', label: 'Data', detail: `${payload.length} bytes` });
        break;
      }
      case 0x0102: {                                  // explicit bit stream
        if (data.length < 2) break;
        const pad = data[0] & 7;
        const totalBits = (data.length - 1) * 8 - pad;
        for (let i = 0; i < totalBits; i++) bit((data[1 + (i >> 3)] >> (i & 7)) & 1);
        flush({ role: 'data', label: 'Data', detail: `${totalBits} bits` });
        break;
      }
      case 0x0110: {                                  // carrier tone
        if (data.length < 2) break;
        const n = data[0] | (data[1] << 8);
        carrier(n);
        flush({ role: 'tone', label: `Carrier ${carrierSeconds(n)}`, detail: `${n} cycles` });
        break;
      }
      case 0x0111: {                                  // carrier / dummy byte / carrier
        if (data.length < 4) break;
        const before = data[0] | (data[1] << 8);
        const after = data[2] | (data[3] << 8);
        carrier(before);
        frame(0xAA, 8, 'N', 1);
        carrier(after);
        flush({ role: 'tone', label: `Carrier ${carrierSeconds(before + after)}`, detail: 'with dummy byte' });
        break;
      }
      case 0x0112: {                                  // integer gap, in 1/(2*base) units
        if (data.length < 2) break;
        flush({});
        gap((data[0] | (data[1] << 8)) / (2 * baseHz));
        break;
      }
      case 0x0116: {                                  // float gap, seconds
        if (data.length < 4) break;
        const s = readFloat(data);
        if (s > 0) { flush({}); gap(s); }
        break;
      }
      case 0x0113:                                    // base frequency
        if (data.length >= 4) {
          const f = readFloat(data);
          if (f > 0 && Number.isFinite(f)) baseHz = f;
        }
        break;
      case 0x0117:                                    // baud rate
        if (data.length >= 2) {
          const b = data[0] | (data[1] << 8);
          if (b > 0) baud = b;
        }
        break;
      default: break;
    }
  }
  flush({});
  return blocks;
}

/** Parse a (possibly gzipped) UEF into pulse blocks. */
export async function parseUEF(data: Uint8Array): Promise<TapeBlock[]> {
  const raw = isGzip(data) ? await gunzip(data) : data;
  return uefChunksToBlocks(parseUefChunks(raw));
}

// ── Writing ────────────────────────────────────────────────────────────────

export function buildUef(chunks: readonly UefChunk[]): Uint8Array {
  let size = 12;
  for (const c of chunks) size += 6 + c.data.length;
  const out = new Uint8Array(size);
  out.set(UEF_SIGNATURE, 0);
  out[10] = 10;                                       // version 0.10
  out[11] = 0;
  const view = new DataView(out.buffer);
  let pos = 12;
  for (const c of chunks) {
    view.setUint16(pos, c.id, true);
    view.setUint32(pos + 2, c.data.length, true);
    out.set(c.data, pos + 6);
    pos += 6 + c.data.length;
  }
  return out;
}

/**
 * Collects what a machine writes to its cassette port as a UEF.
 *
 * Machines hand it each transmitted byte with the CPU cycle it started on. The
 * line idles at carrier tone between bytes, so any gap longer than a frame is
 * recorded as a carrier chunk and back-to-back bytes as data.
 */
export class UefRecorder {
  private readonly chunks: UefChunk[] = [];
  private pending: number[] = [];
  private lastEnd = -1;
  private motorOnAt = -1;
  private baud = UEF_DEFAULT_BAUD;

  /** @param cpuClock CPU cycles per second */
  constructor(private readonly cpuClock: number) {}

  get empty(): boolean { return this.chunks.length === 0 && this.pending.length === 0; }

  private get frameCycles(): number { return (this.cpuClock / this.baud) * 10; }

  reset(): void {
    this.chunks.length = 0;
    this.pending = [];
    this.lastEnd = -1;
    this.motorOnAt = -1;
    this.baud = UEF_DEFAULT_BAUD;
  }

  /** The motor relay switched. The tape stands still while it is off, so a
   *  byte after a stop is measured from the restart, not from the last byte. */
  motor(on: boolean, cycle: number): void {
    if (on) {
      if (this.motorOnAt < 0) { this.motorOnAt = cycle; this.lastEnd = -1; }
    } else {
      this.flushData();
      this.motorOnAt = -1;
      this.lastEnd = -1;
    }
  }

  /** The machine is transmitting at `baud`; a change is recorded as chunk 0117. */
  setBaud(baud: number): void {
    if (baud === this.baud) return;
    this.flushData();
    this.baud = baud;
    this.chunks.push({ id: 0x0117, data: Uint8Array.of(baud & 0xFF, (baud >> 8) & 0xFF) });
  }

  byte(value: number, startCycle: number): void {
    const from = this.lastEnd >= 0 ? this.lastEnd : this.motorOnAt;
    if (from >= 0) {
      const gap = startCycle - from;
      // More than half a frame beyond back-to-back means the line sat at carrier.
      if (gap > this.frameCycles / 2) this.carrier(gap);
    }
    this.pending.push(value & 0xFF);
    this.lastEnd = startCycle + this.frameCycles;
  }

  private carrier(cycles: number): void {
    this.flushData();
    // Carrier chunks count cycles of the 2400 Hz tone.
    const n = Math.min(0xFFFF, Math.round((cycles / this.cpuClock) * 2 * UEF_DEFAULT_BASE_HZ));
    if (n > 0) this.chunks.push({ id: 0x0110, data: Uint8Array.of(n & 0xFF, n >> 8) });
  }

  private flushData(): void {
    if (this.pending.length === 0) return;
    this.chunks.push({ id: 0x0100, data: Uint8Array.from(this.pending) });
    this.pending = [];
  }

  /** The recording as a UEF, or null when nothing was written. */
  toUef(): Uint8Array | null {
    if (this.empty) return null;
    this.flushData();
    const origin = new TextEncoder().encode('ZX84 ');
    return buildUef([{ id: 0x0000, data: origin }, ...this.chunks]);
  }

  // ── Snapshot state ────────────────────────────────────────────────────────

  /** Write what has been recorded so far and where the recorder is in it. */
  saveState(w: StateSink): void {
    w.u32(this.chunks.length);
    for (const c of this.chunks) { w.u16(c.id); w.bytes(c.data); }
    w.bytes(Uint8Array.from(this.pending));
    w.f64(this.lastEnd); w.f64(this.motorOnAt); w.f64(this.baud);
  }

  loadState(r: StateSource): void {
    this.chunks.length = 0;
    for (let n = r.u32(); n > 0; n--) {
      const id = r.u16();
      this.chunks.push({ id, data: r.bytes() });
    }
    this.pending = Array.from(r.bytes());
    this.lastEnd = r.f64(); this.motorOnAt = r.f64(); this.baud = r.f64();
  }
}
