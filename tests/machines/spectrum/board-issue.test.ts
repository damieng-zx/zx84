/**
 * Issue 2 / Issue 3 boards: what port 0xFE bit 6 reads back after an OUT, per
 * model, and how the option travels through settings and snapshots.
 *
 * Hardware truth (comp.sys.sinclair FAQ / WoS 48K reference, Pera Putnik's ULA
 * pin 28 measurements): with no EAR input, bit 6 reads 1 after an OUT with
 * bit 4 set on any board, and after an OUT with only bit 3 (MIC) set on an
 * Issue 2 board but not an Issue 3. The 128K and +2 behave as Issue 3. The
 * +2A/+3 reads 0 whatever was written (WoS 128K reference).
 *
 * The SZX KEYB block (Spectaculator ZX-State spec) is dwFlags (ZXSTKF_ISSUE2 =
 * 1, "16K and 48K only, 0 for other models") then chKeyboardJoystick
 * (ZXSKJT_NONE = 8). The .z80 header's byte 29 bit 2 is "Issue 2 emulation".
 *
 * The ROM-run test uses the real 48K ROM: its BEEPER routine ORs 8 into the
 * border colour before toggling bit 4 (the FAQ's explanation for IN 254
 * reading 255 on an Issue 2 and 191 on an Issue 3 while BASIC clicks keys).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { SpectrumSnapshotService } from '@/machines/spectrum/services/snapshots.ts';
import type { MachineHost } from '@/machines/machine.ts';
import type { SpectrumModel } from '@/machines/spectrum/models.ts';

function machine(model: SpectrumModel): Spectrum {
  const s = new Spectrum(model, null);
  s.start = async () => {};   // headless: no AudioContext / rAF
  return s;
}

/** OUT (0xFE),val then IN A,(0xFE) with no key down; returns bit 6. */
function bit6After(s: Spectrum, val: number): number {
  s.cpu.portOutHandler!(0x00FE, val);
  return (s.cpu.portInHandler!(0xFFFE) >> 6) & 1;
}

const view = (issue2: boolean) => ({
  get<T>(key: string, fallback: T): T { return (key === 'spectrum-issue2' ? issue2 : fallback) as T; },
});

describe('Port 0xFE bit 6 per model', () => {
  it.each(['zx16k', 'zx48k'] as const)('%s defaults to an Issue 3 board', (model) => {
    const s = machine(model);
    expect(s.boardIssue2).toBe(false);
    expect(bit6After(s, 0x08)).toBe(0);
    expect(bit6After(s, 0x10)).toBe(1);
  });

  it.each(['zx16k', 'zx48k'] as const)('%s as an Issue 2 board reads MIC back too', (model) => {
    const s = machine(model);
    s.setBoardIssue2(true);
    expect(bit6After(s, 0x08)).toBe(1);
    expect(bit6After(s, 0x10)).toBe(1);
    expect(bit6After(s, 0x00)).toBe(0);
  });

  it.each(['zx128k', 'zx128kplus2'] as const)('%s is Issue 3 and ignores the option', (model) => {
    const s = machine(model);
    s.setBoardIssue2(true);
    expect(s.boardIssue2).toBe(false);
    expect(bit6After(s, 0x08)).toBe(0);
    expect(bit6After(s, 0x10)).toBe(1);
  });

  it.each(['zx128kplus2a', 'zx128kplus3'] as const)('%s reads 0 whatever was written', (model) => {
    const s = machine(model);
    for (const v of [0x00, 0x08, 0x10, 0x18]) expect(bit6After(s, v)).toBe(0);
  });

  it('follows the spectrum-issue2 setting', () => {
    const s = machine('zx48k');
    s.applySettings(view(true));
    expect(bit6After(s, 0x08)).toBe(1);
    s.applySettings(view(false));
    expect(bit6After(s, 0x08)).toBe(0);
  });
});

function hostRecording(): { host: MachineHost; flags: [string, boolean][] } {
  const flags: [string, boolean][] = [];
  return {
    flags,
    host: {
      setStatus: () => {}, requestModel: async () => false, persistMedia: () => {},
      setFlagSetting: (key, on) => { flags.push([key, on]); },
    },
  };
}

/** Payload offset and size of the first block with this id, or null. */
function findBlock(szx: Uint8Array, id: string): { at: number; size: number } | null {
  let o = 8;
  while (o + 8 <= szx.length) {
    const size = szx[o + 4] | (szx[o + 5] << 8) | (szx[o + 6] << 16) | (szx[o + 7] << 24);
    if (String.fromCharCode(...szx.subarray(o, o + 4)) === id) return { at: o + 8, size };
    o += 8 + size;
  }
  return null;
}

describe('SZX: KEYB block and SPCR chFe', () => {
  it('writes ZXSTKF_ISSUE2 for an Issue 2 48K, the last OUT in chFe', async () => {
    const s = machine('zx48k');
    s.setBoardIssue2(true);
    s.cpu.portOutHandler!(0x00FE, 0x0D);          // border 5, MIC set
    const szx = await new SpectrumSnapshotService(s, () => null).save('szx');
    const keyb = findBlock(szx, 'KEYB')!;
    expect(keyb.size).toBe(5);
    expect(Array.from(szx.subarray(keyb.at, keyb.at + 5))).toEqual([1, 0, 0, 0, 8]);
    const spcr = findBlock(szx, 'SPCR')!;
    expect(szx[spcr.at]).toBe(5);                 // chBorder
    expect(szx[spcr.at + 3]).toBe(0x0D);          // chFe
  });

  it('writes the flag clear on an Issue 3 board and on models the flag is not defined for', async () => {
    for (const model of ['zx48k', 'zx128k'] as const) {
      const s = machine(model);
      s.setBoardIssue2(true);
      if (model === 'zx48k') s.setBoardIssue2(false);
      const szx = await new SpectrumSnapshotService(s, () => null).save('szx');
      const keyb = findBlock(szx, 'KEYB')!;
      expect(szx[keyb.at] & 1).toBe(0);
    }
  });

  it('loading an Issue 2 48K snapshot fits an Issue 2 board and tells the host', async () => {
    const src = machine('zx48k');
    src.setBoardIssue2(true);
    src.cpu.portOutHandler!(0x00FE, 0x08);
    const szx = await new SpectrumSnapshotService(src, () => null).save('szx');

    const dst = machine('zx48k');
    const { host, flags } = hostRecording();
    const r = await new SpectrumSnapshotService(dst, () => host).apply(szx, 'a.szx');
    expect(r.ok).toBe(true);
    expect(dst.boardIssue2).toBe(true);
    expect(flags).toEqual([['spectrum-issue2', true]]);
    expect(dst.ula.lastOut).toBe(0x08);           // chFe restored: MIC high
    expect((dst.cpu.portInHandler!(0xFFFE) >> 6) & 1).toBe(1);
  });

  it('an Issue 3 snapshot puts an Issue 2 board back to Issue 3', async () => {
    const szx = await new SpectrumSnapshotService(machine('zx48k'), () => null).save('szx');
    const dst = machine('zx48k');
    dst.setBoardIssue2(true);
    const { host, flags } = hostRecording();
    await new SpectrumSnapshotService(dst, () => host).apply(szx, 'b.szx');
    expect(dst.boardIssue2).toBe(false);
    expect(flags).toEqual([['spectrum-issue2', false]]);
  });

  it('a file without a KEYB block leaves the board alone', async () => {
    const szx = await new SpectrumSnapshotService(machine('zx48k'), () => null).save('szx');
    const keyb = findBlock(szx, 'KEYB')!;
    const stripped = new Uint8Array([...szx.subarray(0, keyb.at - 8), ...szx.subarray(keyb.at + keyb.size)]);
    expect(findBlock(stripped, 'KEYB')).toBeNull();
    const dst = machine('zx48k');
    dst.setBoardIssue2(true);
    const { host, flags } = hostRecording();
    await new SpectrumSnapshotService(dst, () => host).apply(stripped, 'c.szx');
    expect(dst.boardIssue2).toBe(true);
    expect(flags).toEqual([]);
  });
});

describe('.z80: byte 29 bit 2', () => {
  it('is written for an Issue 2 48K and read back', async () => {
    const src = machine('zx48k');
    src.setBoardIssue2(true);
    src.cpu.im = 1;
    const z80 = await new SpectrumSnapshotService(src, () => null).save('z80');
    expect(z80[29]).toBe(0x01 | 0x04);

    const dst = machine('zx48k');
    const { host, flags } = hostRecording();
    await new SpectrumSnapshotService(dst, () => host).apply(z80, 'd.z80');
    expect(dst.boardIssue2).toBe(true);
    expect(flags).toEqual([['spectrum-issue2', true]]);
  });

  it('is never written for a 128K', async () => {
    const s = machine('zx128k');
    s.setBoardIssue2(true);
    const z80 = await new SpectrumSnapshotService(s, () => null).save('z80');
    expect(z80[29] & 0x04).toBe(0);
  });
});

// ── The real 48K ROM ───────────────────────────────────────────────────────

const ROM48 = [process.env.SPECTRUM_ROM_DIR, resolve(__dirname, '../../../mcp/.cache')]
  .filter((d): d is string => !!d)
  .map(d => resolve(d, '48.rom'))
  .find(p => existsSync(p));

describe.skipIf(!ROM48)('48K ROM BEEPER leaves MIC high: IN 254 reads 255 on Issue 2, 191 on Issue 3', { timeout: 30_000 }, () => {
  if (!ROM48) console.warn('48.rom not found (SPECTRUM_ROM_DIR or mcp/.cache): skipping the ROM run');

  const STUB = 0x8000;
  const LOOP = STUB + 9;

  /** LD HL,pitch ; LD DE,cycles ; CALL BEEPER (0x03B5) ; JR $ — then IN from 0xFFFE. */
  function runBeeper(issue2: boolean): { lastOut: number; read: number } {
    const s = machine('zx48k');
    try {
      s.loadROM(new Uint8Array(readFileSync(ROM48!)));
      s.reset();
      for (let f = 0; f < 150; f++) s.tick();     // to the BASIC editor
      s.setBoardIssue2(issue2);
      const code = [
        0x21, 0x00, 0x01,                         // LD HL,0x0100
        0x11, 0x08, 0x00,                         // LD DE,8 cycles
        0xCD, 0xB5, 0x03,                         // CALL BEEPER
        0x18, 0xFE,                               // LOOP: JR $
      ];
      code.forEach((b, i) => s.memory.writeByte(STUB + i, b));
      s.cpu.pc = STUB;
      for (let f = 0; f < 50 && s.cpu.pc !== LOOP; f++) s.tick();
      expect(s.cpu.pc).toBe(LOOP);
      // No keys down and no rows selected: only bits 5-7 and bit 6's feedback vary.
      return { lastOut: s.ula.lastOut, read: s.cpu.portInHandler!(0xFFFE) };
    } finally { s.destroy(); }
  }

  it('the ROM leaves bit 4 low and bit 3 high after BEEPER', () => {
    expect(runBeeper(false).lastOut & 0x18).toBe(0x08);
  });

  it('Issue 3 reads 191, Issue 2 reads 255', () => {
    expect(runBeeper(false).read).toBe(191);
    expect(runBeeper(true).read).toBe(255);
  });
});
