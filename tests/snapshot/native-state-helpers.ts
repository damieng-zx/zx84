/**
 * Shared pieces for the native-snapshot tests (`.bbcstate`, `.elkstate`,
 * `.a1state`, `.a2state`): a small 6502 assembler for the synthetic firmware
 * the tests run, and the "carry on, or restore and carry on" comparison.
 *
 * Exactness is the point of a native snapshot, so each machine test runs two
 * machines from the same instant and compares them frame for frame: the
 * original carries on from where it was saved, the other is a fresh machine
 * restored from the file. They must not differ in a CPU register, a cycle, a
 * pixel or a byte of state.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import { crc32 } from '@/machines/shared/state-io.ts';
import type { SnapshotService } from '@/machines/machine.ts';

/** A 6502 machine as the comparison sees it. */
export interface Steppable {
  readonly cpu: { a: number; x: number; y: number; sp: number; pc: number; p: number; tStates: number };
  readonly pixels: Uint8Array;
  readonly services: { readonly snapshots: SnapshotService | null };
  tick(): void;
  destroy(): void;
}

/** Everything observable after a frame: the CPU, the picture, and the whole
 *  machine state as the refresh snapshot records it. */
export function fingerprint(m: Steppable, picture = true): string {
  const c = m.cpu;
  const state = m.services.snapshots!.saveSync!()!;
  return [
    `pc=${c.pc} a=${c.a} x=${c.x} y=${c.y} sp=${c.sp} p=${c.p} t=${c.tStates}`,
    picture ? `picture=${crc32(m.pixels).toString(16)}` : '',
    `state=${crc32(state).toString(16)}`,
  ].join(' ');
}

/** Run `frames` frames, fingerprinting each. */
export function trace(m: Steppable, frames: number): string[] {
  const out: string[] = [];
  for (let f = 0; f < frames; f++) {
    m.tick();
    out.push(fingerprint(m));
  }
  return out;
}

/**
 * Save `m` as a file, carry it on for `frames` frames, restore the file into
 * `fresh` and run that as long: both runs must match frame for frame.
 */
export async function expectExactFromFile(
  m: Steppable, fresh: Steppable, ext: string, frames: number,
): Promise<void> {
  const file = await m.services.snapshots!.save(ext);
  // The picture on show right after a restore is drawn from the restored
  // state, not left over from a frame drawn as the beam went, so only the
  // machine itself is compared at that instant.
  const before = fingerprint(m, false);
  const original = trace(m, frames);
  const result = await fresh.services.snapshots!.apply(file, `test${ext}`);
  expect(result.ok, result.message).toBe(true);
  expect(fingerprint(fresh, false), 'the restored machine is where the original was').toBe(before);
  const restored = trace(fresh, frames);
  for (let f = 0; f < frames; f++) expect(restored[f], `frame ${f + 1} after the restore`).toBe(original[f]);
}

/**
 * A file that is not intact is refused and leaves the machine exactly as it
 * was: truncated, altered in its body, with another family's magic, or from
 * a future version.
 */
export async function expectRefusedUntouched(m: Steppable, file: Uint8Array, ext: string): Promise<void> {
  const before = fingerprint(m);
  const truncated = file.subarray(0, file.length - 7);
  const altered = file.slice();
  altered[altered.length >> 1] ^= 0x10;
  const wrongMagic = file.slice();
  wrongMagic[0] ^= 0x20;
  const future = file.slice();
  future[4] = 99;
  for (const [what, data] of [
    ['truncated', truncated], ['altered', altered], ['wrong magic', wrongMagic], ['future version', future],
    ['header only', file.subarray(0, 14)], ['empty', new Uint8Array(0)],
  ] as const) {
    const r = await m.services.snapshots!.apply(data, `bad${ext}`);
    expect(r.ok, `${what} is refused`).toBe(false);
    expect(fingerprint(m), `${what} leaves the machine alone`).toBe(before);
  }
}

// ── ROMs ───────────────────────────────────────────────────────────────────

/** Where real firmware may be found: `ZX84_ROM_DIR`, then the MCP cache. */
const ROM_DIRS = [process.env.ZX84_ROM_DIR, resolve(__dirname, '../../mcp/.cache')]
  .filter((d): d is string => !!d);

export function romImage(name: string): Uint8Array | null {
  for (const dir of ROM_DIRS) {
    const p = resolve(dir, name);
    if (existsSync(p)) return new Uint8Array(readFileSync(p));
  }
  return null;
}

// ── A small 6502 assembler ────────────────────────────────────────────────

/**
 * Just enough to write the synthetic firmware readably: raw bytes, labels,
 * absolute operands that may name a label, and relative branches.
 */
export class Asm {
  private readonly bytes: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly fixups: { at: number; label: string; kind: 'abs' | 'rel' }[] = [];

  constructor(readonly origin: number) {}

  get pc(): number { return this.origin + this.bytes.length; }

  /** Raw bytes. */
  b(...bytes: number[]): this {
    for (const v of bytes) this.bytes.push(v & 0xFF);
    return this;
  }

  label(name: string): this {
    this.labels.set(name, this.pc);
    return this;
  }

  /** An instruction with a 16-bit operand: an address or a label. */
  abs(opcode: number, target: number | string): this {
    this.bytes.push(opcode);
    if (typeof target === 'number') {
      this.bytes.push(target & 0xFF, (target >> 8) & 0xFF);
    } else {
      this.fixups.push({ at: this.bytes.length, label: target, kind: 'abs' });
      this.bytes.push(0, 0);
    }
    return this;
  }

  /** A relative branch to a label. */
  br(opcode: number, label: string): this {
    this.bytes.push(opcode);
    this.fixups.push({ at: this.bytes.length, label, kind: 'rel' });
    this.bytes.push(0);
    return this;
  }

  addr(label: string): number {
    const a = this.labels.get(label);
    if (a === undefined) throw new Error(`no label ${label}`);
    return a;
  }

  assemble(): Uint8Array {
    for (const f of this.fixups) {
      const target = this.addr(f.label);
      if (f.kind === 'abs') {
        this.bytes[f.at] = target & 0xFF;
        this.bytes[f.at + 1] = (target >> 8) & 0xFF;
      } else {
        const off = target - (this.origin + f.at + 1);
        if (off < -128 || off > 127) throw new Error(`branch to ${f.label} out of range`);
        this.bytes[f.at] = off & 0xFF;
      }
    }
    return Uint8Array.from(this.bytes);
  }
}

// Opcodes the synthetic firmware uses.
export const OP = {
  LDA_IMM: 0xA9, LDA_ZP: 0xA5, LDA_ABS: 0xAD, LDA_ABSX: 0xBD, LDA_INDY: 0xB1,
  LDX_IMM: 0xA2, LDY_IMM: 0xA0,
  STA_ZP: 0x85, STA_ABS: 0x8D, STA_INDY: 0x91, STX_ABS: 0x8E,
  INC_ZP: 0xE6, INX: 0xE8, INY: 0xC8, DEX: 0xCA,
  AND_IMM: 0x29, ORA_IMM: 0x09, EOR_ZP: 0x45, CMP_IMM: 0xC9, CPX_IMM: 0xE0,
  ADC_ZP: 0x65, CLC: 0x18, LSR_A: 0x4A,
  BNE: 0xD0, BEQ: 0xF0, BCC: 0x90, BCS: 0xB0, BPL: 0x10, BMI: 0x30,
  JMP: 0x4C, JSR: 0x20, RTS: 0x60, RTI: 0x40,
  PHA: 0x48, PLA: 0x68, SEI: 0x78, CLI: 0x58, CLD: 0xD8, TXS: 0x9A,
} as const;
