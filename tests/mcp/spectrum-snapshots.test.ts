/**
 * The MCP's Spectrum snapshot path (`mcp/spectrum-loader.ts`).
 *
 * Two faults lived here, both from the bench path keeping its own copy of
 * knowledge the machine already holds:
 *
 *  - it had a private SZX machine-id table that omitted the Timex ids, so a
 *    Timex snapshot loaded on whatever the bench was running;
 *  - it called loadSNA/loadZ80 without `selectSnapshot48KRom()`, which the
 *    machine's own SnapshotService does and which `spectrum/memory.ts`
 *    documents as the thing that stops a 48K snapshot on a 128K-class machine
 *    crashing at its first interrupt (the 128K editor ROM's 0x0038 vector jumps
 *    through a RAM stub the snapshot never fills).
 *
 * These check the loader answers from the canonical table and leaves the
 * machine able to take an interrupt.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { machineIdOf } from '@/machines/spectrum/snapshots/szx.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { state } from '../../mcp/state.ts';
import { loadFileInto } from '../../mcp/spectrum-loader.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => { state.spec = null as unknown as typeof state.spec; });

/** A minimal 48K .sna: 27-byte header + 48K of RAM. */
function sna48k(): Uint8Array {
  const out = new Uint8Array(27 + 0xC000);
  // SP at $4000 (in the snapshot's RAM region), PC at $8000, IFF1 off.
  out[23] = 0x00; out[24] = 0x40;
  out[25] = 0x00; out[26] = 0x80;
  return out;
}

function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'zx84-mcp-'));
  return body(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('MCP SZX machine ids', () => {
  it('names every id the snapshot writer uses, plus the Timex PAL build', () => {
    // 0-7 and 10/12/13/14 are the ids the writer emits; 8/9 are the Timex pair
    // and 12 is the TS2068 — the ones the loader's private table had missed.
    expect(machineIdOf(new Uint8Array([0x5A, 0x58, 0x53, 0x54, 1, 0, 0]))).toBe('zx16k');
    expect(machineIdOf(new Uint8Array([0x5A, 0x58, 0x53, 0x54, 1, 0, 1]))).toBe('zx48k');
    expect(machineIdOf(new Uint8Array([0x5A, 0x58, 0x53, 0x54, 1, 0, 2]))).toBe('zx128k');
    expect(machineIdOf(new Uint8Array([0x5A, 0x58, 0x53, 0x54, 1, 0, 4]))).toBe('zx128kplus2a');
    expect(machineIdOf(new Uint8Array([0x5A, 0x58, 0x53, 0x54, 1, 0, 5]))).toBe('zx128kplus3');
    expect(machineIdOf(new Uint8Array([0x5A, 0x58, 0x53, 0x54, 1, 0, 8]))).toBe('tc2048');
    expect(machineIdOf(new Uint8Array([0x5A, 0x58, 0x53, 0x54, 1, 0, 9]))).toBe('ts2068');
    expect(machineIdOf(new Uint8Array([0x5A, 0x58, 0x53, 0x54, 1, 0, 12]))).toBe('ts2068');
    expect(machineIdOf(new Uint8Array([0x5A, 0x58, 0x53, 0x54, 1, 0, 14]))).toBe('pentagon1024');
  });

  it('falls back to the 48K for a short file or an unknown id', () => {
    expect(machineIdOf(new Uint8Array(4))).toBe('zx48k');
    expect(machineIdOf(new Uint8Array([0x5A, 0x58, 0x53, 0x54, 1, 0, 200]))).toBe('zx48k');
  });
});

describe('MCP snapshot loading', () => {
  it('selects the 48K ROM when a 48K .sna lands on a 128K-class machine', async () => {
    // The bug: the loader ran loadSNA without selectSnapshot48KRom(), leaving
    // the 128K editor ROM paged in with its interrupt vector pointing at an
    // unfilled RAM stub. The machine's own service does select it, so the two
    // paths disagreed about the same file.
    await withTempDir(async (dir) => {
      const file = join(dir, 'game.sna');
      writeFileSync(file, sna48k());
      const m = new Spectrum('zx128k', null);
      state.model = 'zx128k';
      state.spec = m;
      try {
        const msg = await loadFileInto(m, file);
        expect(msg).toContain('SNA loaded');
        const mem = m.memory;
        // The 48K BASIC ROM page is selected and paging is locked, which is
        // what selectSnapshot48KRom() does (and what stops the crash).
        expect(mem.currentROM, 'the 48K BASIC ROM is paged in').toBe(mem.basicRomPage);
        expect(mem.pagingLocked, 'and paging is locked as the snapshot left it').toBe(true);
      } finally { m.destroy(); }
    });
  });
});
