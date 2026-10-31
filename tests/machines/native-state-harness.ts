/**
 * Shared checks for zx84's native machine snapshots (machines/shared/
 * native-state.ts), used by each machine's snapshot test.
 *
 * The point of a native format is that a restore is exact, so the central
 * check runs two machines from the same instant and compares them: one
 * carries on from where it was saved, the other is restored from the file
 * into a machine that had been somewhere else entirely (a different number of
 * frames in, with its RAM scribbled on). After the same number of frames they
 * must agree on every register, the cycle count, the RAM and every pixel.
 */

import { expect } from 'vitest';
import type { SnapshotService } from '@/machines/machine.ts';
import { crc32 } from '@/machines/shared/state-io.ts';

/** The Z80 fields compared between the two runs. */
interface Z80Like {
  a: number; f: number; b: number; c: number; d: number; e: number; h: number; l: number;
  a_: number; f_: number; b_: number; c_: number; d_: number; e_: number; h_: number; l_: number;
  ix: number; iy: number; sp: number; pc: number; i: number; r: number;
  iff1: boolean; iff2: boolean; im: number; halted: boolean; tStates: number; memptr: number;
}

export interface StateTestMachine {
  readonly cpu: Z80Like;
  readonly pixels: Uint8Array;
  readonly services: {
    readonly snapshots: SnapshotService | null;
    readonly debug: { ramExport(): { data: Uint8Array } | null };
  };
  tick(): void;
  destroy(): void;
}

export function registers(cpu: Z80Like): Record<string, number | boolean> {
  return {
    a: cpu.a, f: cpu.f, b: cpu.b, c: cpu.c, d: cpu.d, e: cpu.e, h: cpu.h, l: cpu.l,
    a_: cpu.a_, f_: cpu.f_, b_: cpu.b_, c_: cpu.c_, d_: cpu.d_, e_: cpu.e_, h_: cpu.h_, l_: cpu.l_,
    ix: cpu.ix, iy: cpu.iy, sp: cpu.sp, pc: cpu.pc, i: cpu.i, r: cpu.r,
    iff1: cpu.iff1, iff2: cpu.iff2, im: cpu.im, halted: cpu.halted,
    tStates: cpu.tStates, memptr: cpu.memptr,
  };
}

/** Everything the two runs are compared on. */
export function observe(m: StateTestMachine): { regs: Record<string, number | boolean>; ram: number; picture: number } {
  const ram = m.services.debug.ramExport();
  return { regs: registers(m.cpu), ram: ram ? crc32(ram.data) : 0, picture: crc32(m.pixels) };
}

function run(m: StateTestMachine, frames: number): void {
  for (let f = 0; f < frames; f++) m.tick();
}

export interface ExactResumeOptions<M extends StateTestMachine> {
  /** A fresh machine, ROM installed and reset. */
  make(): M;
  /** The snapshot extension (with the dot). */
  ext: string;
  /** Frames to run before saving. */
  before: number;
  /** Frames both runs make after the save/restore. */
  after: number;
  /** Put the target somewhere else before the restore (beyond running it a
   *  different number of frames). */
  scramble?(m: M): void;
  /** Make the saved run's state interesting just before saving (e.g. mount a
   *  disk and start a command). */
  prepare?(m: M): void | Promise<void>;
}

/**
 * Save after `before` frames, then check that a machine restored from the file
 * (and, separately, from the refresh blob) runs the next `after` frames
 * exactly as the original does. Repeated at a few consecutive frames, so the
 * save lands on frames whose last instruction overran the frame end by
 * different amounts.
 */
export async function expectExactResume<M extends StateTestMachine>(o: ExactResumeOptions<M>): Promise<void> {
  for (let k = 0; k < 3; k++) await exactResumeAt({ ...o, before: o.before + k });
}

async function exactResumeAt<M extends StateTestMachine>(o: ExactResumeOptions<M>): Promise<void> {
  const src = o.make();
  const dstFile = o.make();
  const dstSync = o.make();
  try {
    run(src, o.before);
    await o.prepare?.(src);
    const file = await src.services.snapshots!.save(o.ext);
    const sync = src.services.snapshots!.saveSync!()!;
    // The save itself must not disturb the machine it was taken from.
    run(src, o.after);
    const expected = observe(src);

    for (const [dst, data, how] of [[dstFile, file, 'file'], [dstSync, sync, 'refresh']] as const) {
      run(dst, Math.max(1, (o.before >> 1) + 3));
      o.scramble?.(dst);
      if (how === 'file') {
        const result = await dst.services.snapshots!.apply(data, `test${o.ext}`);
        expect(result.ok, result.message).toBe(true);
      } else {
        expect(await dst.services.snapshots!.restoreSync!(data)).toBe(true);
      }
      run(dst, o.after);
      const got = observe(dst);
      expect(got.regs, `registers after a ${how} restore saved at frame ${o.before}`).toEqual(expected.regs);
      expect(got.ram, `RAM after a ${how} restore`).toBe(expected.ram);
      expect(got.picture, `picture after a ${how} restore`).toBe(expected.picture);
    }
  } finally {
    src.destroy();
    dstFile.destroy();
    dstSync.destroy();
  }
}

/**
 * A damaged file (truncated, a flipped bit, the wrong magic, a future
 * version) is refused with a message, and the machine it was offered to is
 * left exactly as it was.
 */
export async function expectDamagedRefused<M extends StateTestMachine>(
  make: () => M, ext: string, frames = 5,
): Promise<void> {
  const src = make();
  const dst = make();
  try {
    run(src, frames);
    const file = await src.services.snapshots!.save(ext);
    const sync = src.services.snapshots!.saveSync!()!;
    run(dst, frames + 7);
    const before = observe(dst);

    const flipped = sync.slice();
    flipped[flipped.length >> 1] ^= 0x10;
    const magic = sync.slice();
    magic[0] ^= 0xFF;
    const future = sync.slice();
    future[4] = 99;
    const damaged: [Uint8Array, RegExp][] = [
      [file.subarray(0, file.length - 9), /corrupt/],
      [sync.subarray(0, sync.length - 9), /corrupt or truncated/],
      [flipped, /corrupt or truncated/],
      [magic, /Not a zx84/],
      [future, /version 99/],
      [new Uint8Array(6), /Not a zx84/],
    ];
    for (const [data, why] of damaged) {
      const result = await dst.services.snapshots!.apply(data, `bad${ext}`);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(why);
      expect(await dst.services.snapshots!.restoreSync!(data)).toBe(false);
      expect(observe(dst)).toEqual(before);
    }
  } finally {
    src.destroy();
    dst.destroy();
  }
}
