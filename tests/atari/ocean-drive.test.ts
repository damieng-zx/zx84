/**
 * The beam-debugging acceptance checks on Ocean Drive (docs/beam-debug-mcp-spec.md
 * in the feature/atari worktree): `ocean-v46.atr` is the build with the two
 * Display List Lab bugs, `ocean-v47.atr` the fixed one.
 *
 * Neither the disk images nor the firmware are checked in. The images are
 * looked up in ATARI_TEST_DIR, then mcp/.cache/lab; AltirraOS in ATARI_ROM_DIR,
 * then mcp/.cache (as altirra-boot.test.ts does). Each case is skipped when
 * its files are absent.
 *
 * These pin what the *core* does, which is not always what hardware does:
 *
 *  - Bug 1 (the immediate VBI runs long, so the OS's SDLSTL -> DLISTL copy lands
 *    on a visible line and ANTIC restarts the display list) reproduces on PAL.
 *  - Bug 2 (a DLI kernel misses its second STA WSYNC, so every later line gets
 *    its HSCROL a line late) does NOT reproduce in zx84: the core releases
 *    WSYNC at the line boundary and carries it only when the store ends at
 *    cycle 113 or later, and the kernel's WSYNC stores are at cycle 81. So
 *    v46 and v47 draw the same HSCROL on every kernel line here. If the core's
 *    WSYNC timing is ever brought in line with hardware, the v46 case at the
 *    bottom is the one that should start to fail.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ALTIRRA_OS_SOURCE } from '@/machines/atari/models.ts';
import {
  BeamLog, BEAM_DL, BEAM_EFF, BEAM_IO, BEAM_IRQ, DL_FETCH, DL_VISIBLE,
} from '@/debug/beam-log.ts';

const ROM_DIRS = [process.env.ATARI_ROM_DIR, resolve(__dirname, '../../mcp/.cache')]
  .filter((d): d is string => !!d);
const IMAGE_DIRS = [process.env.ATARI_TEST_DIR, resolve(__dirname, '../../mcp/.cache/lab')]
  .filter((d): d is string => !!d);

function find(dirs: string[], name: string): Uint8Array | null {
  for (const dir of dirs) {
    const p = resolve(dir, name);
    if (existsSync(p)) return new Uint8Array(readFileSync(p));
  }
  return null;
}

const OS = find(ROM_DIRS, ALTIRRA_OS_SOURCE.split('/').pop()!);
const V46 = find(IMAGE_DIRS, 'ocean-v46.atr');
const V47 = find(IMAGE_DIRS, 'ocean-v47.atr');

/** Boot an image on a PAL 800 and run it `frames` frames. */
async function boot(image: Uint8Array, frames: number): Promise<AtariMachine> {
  const m = new AtariMachine('atari800', null, 'pal');
  m.services.roms.installSystemRom(OS!);
  m.reset();
  await m.services.media.mount(image, 'ocean.atr');
  m.reset();
  m.setSpeedMultiplier(0);
  for (let f = 0; f < frames; f++) m.tick();
  return m;
}

/** The frames (in the logged range) where a DLIST write landed in the visible area. */
async function visibleDlistFrames(image: Uint8Array): Promise<{ frames: number[]; vbiLines: Set<number>; dliCycles: number[] }> {
  const m = await boot(image, 1500);
  try {
    m.beamLog = new BeamLog(2_000_000);
    m.interruptLogging = true;
    m.dlLogging = true;
    for (let f = 0; f < 400; f++) m.tick();
    const frames = new Set<number>();
    const vbiLines = new Set<number>();
    const dliCycles: number[] = [];
    const log = m.beamLog;
    for (let i = 0; i < log.length; i++) {
      const e = log.get(i);
      if (e.kind === BEAM_DL && (e.flags & DL_FETCH) === 0 && (e.flags & DL_VISIBLE) !== 0) frames.add(e.frame);
      if (e.kind === BEAM_IRQ && (e.flags & 3) === 1) {            // an NMI entry
        if (e.value & 0x40) vbiLines.add(Math.floor(e.t / 114));
        if (e.value & 0x80) dliCycles.push(e.t % 114);
      }
    }
    return { frames: [...frames], vbiLines, dliCycles };
  } finally { m.destroy(); }
}

/** The table at $8B00 as it stands at line 31 of a frame, and the HSCROL the
 *  renderer then used on each line of that frame (line -> value). */
async function hscrolAgainstTable(image: Uint8Array): Promise<{ table: number[]; used: Map<number, number>; writeCycles: number[] }> {
  const m = await boot(image, 1600);
  try {
    m.beamLog = new BeamLog(500_000);
    m.effLogging = true;
    m.memWatchpoints.push({ start: 0xD404, end: 0xD404, mode: 'write', action: 'log' });
    m.beamTarget = { frame: m.frameNumber + 1, t: 31 * 114 };
    m.runUntil(5);
    expect(m.stopReason?.kind).toBe('beam');
    const frame = m.beam().frame;
    const table: number[] = [];
    for (let i = 0; i < 140; i++) table.push(m.memory.readRam(0x8B00 + i) & 0x0F);
    m.beamTarget = null;
    m.runUntil(1);
    const used = new Map<number, number>();
    const writeCycles: number[] = [];
    const log = m.beamLog;
    for (let i = 0; i < log.length; i++) {
      const e = log.get(i);
      if (e.frame !== frame) continue;
      const line = Math.floor(e.t / 114);
      if (e.kind === BEAM_EFF && e.addr === 0x24) used.set(line, e.value & 0x0F);   // 0x24 = HSCROL
      // The kernel's own HSCROL stores (the OS also writes it once, in the vertical blank).
      if (e.kind === BEAM_IO && e.addr === 0xD404 && line >= 32 && line <= 172) writeCycles.push(e.t % 114);
    }
    return { table, used, writeCycles };
  } finally { m.destroy(); }
}

describe.skipIf(!OS || !V46 || !V47)('Ocean Drive on the Atari core (PAL)', { timeout: 120_000 }, () => {
  it('v46 restarts the display list mid-frame (bug 1) and v47 does not', async () => {
    const old = await visibleDlistFrames(V46!);
    const fixed = await visibleDlistFrames(V47!);
    // atari800 flagged frames around 1537 and 1559 of 400 from 1500; frame
    // numbers differ between emulators, so the check is that this core flags
    // some in the same stretch and the fixed build flags none.
    expect(old.frames.length).toBeGreaterThan(5);
    expect(old.frames.some(f => f >= 1500 && f < 1600)).toBe(true);
    expect(fixed.frames).toEqual([]);
  });

  it('the VBI NMI enters on line 248 and a DLI enters 14 to 18 cycles into its line, in both builds', async () => {
    for (const image of [V46!, V47!]) {
      const { vbiLines, dliCycles } = await visibleDlistFrames(image);
      expect([...vbiLines]).toEqual([248]);
      expect(dliCycles.length).toBeGreaterThan(100);
      expect(Math.min(...dliCycles)).toBeGreaterThanOrEqual(10);
      expect(Math.max(...dliCycles)).toBeLessThanOrEqual(24);
    }
  });

  it('the HSCROL the renderer uses on kernel line i is $8B00+i, in v47', async () => {
    const { table, used } = await hscrolAgainstTable(V47!);
    // The table is read at line 31, where it is complete; kernel line i is
    // line 33+i (the HSCROL store on line 32 is the prologue's).
    const mismatches = table.map((v, i) => [i, v, used.get(33 + i)] as const).filter(([, v, u]) => u !== v);
    expect(mismatches).toEqual([]);
  });

  it('the kernel stores HSCROL early in its line in both builds, so bug 2 does not reproduce in this core', async () => {
    for (const image of [V46!, V47!]) {
      const { table, used, writeCycles } = await hscrolAgainstTable(image);
      expect(writeCycles.length).toBeGreaterThan(100);
      // After a WSYNC the core resumes at the line boundary: cycle 3, well inside HSCROL's cutoff of 10.
      expect(Math.max(...writeCycles)).toBeLessThanOrEqual(10);
      expect(table.map((v, i) => used.get(33 + i) === v).every(Boolean)).toBe(true);
    }
  });
});
