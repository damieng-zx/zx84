/**
 * Headless Enterprise 128 boots against the real EXOS 2.1, IS-BASIC 2.1 and
 * EXDOS 1.3 ROMs.
 *
 * The ROMs are not redistributable. Place them in mcp/.cache as
 * `exos21.rom` (32K), `basic21.rom` (16K) and `exdos13.rom` (32K) — the
 * names the MCP server caches them under — or point EP_ROM_DIR at a folder
 * holding them; the suite is skipped when they are absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EnterpriseMachine } from '@/machines/enterprise/enterprise-machine.ts';
import { buildFatImage, serializeFatImage } from '@/media/floppy/fat-image.ts';

const DIR = process.env.EP_ROM_DIR ?? resolve(__dirname, '../../mcp/.cache');
const ROMS = ['exos21.rom', 'basic21.rom', 'exdos13.rom'];
const haveRoms = ROMS.every(r => existsSync(resolve(DIR, r)));

function boot(exdos: boolean): EnterpriseMachine {
  const m = new EnterpriseMachine('ep128', null);
  const view = { get: <T>(key: string, fallback: T): T => (key === 'enterprise-exdos' ? exdos as unknown as T : fallback) };
  for (const req of m.prepare(view)) req.apply(new Uint8Array(readFileSync(resolve(DIR, 'exdos13.rom'))));
  m.loadROM(new Uint8Array([
    ...readFileSync(resolve(DIR, 'exos21.rom')),
    ...readFileSync(resolve(DIR, 'basic21.rom')),
  ]));
  m.applySettings({ get: <T>(_k: string, d: T): T => d });
  m.reset();
  m.setSpeedMultiplier(2);    // no audio in a headless run
  return m;
}

/** Run until `done` holds or `frames` pass; returns whether it held. */
function runUntil(m: EnterpriseMachine, frames: number, done: () => boolean): boolean {
  for (let f = 0; f < frames; f++) {
    m.tick();
    if (done()) return true;
  }
  return false;
}

/**
 * An EXOS "new application" (module type 5): a 16-byte header with the code
 * length, then code EXOS loads and starts at 0x0100. This one sets Nick's
 * border to 0x55 and stops.
 */
function borderProgram(): Uint8Array {
  const code = [0x3E, 0x55, 0xD3, 0x81, 0x18, 0xFE];    // LD A,55h; OUT (81h),A; JR $
  return Uint8Array.from([0x00, 0x05, code.length, 0x00, ...new Array(12).fill(0), ...code]);
}

describe.skipIf(!haveRoms)('Enterprise 128 with real ROMs', () => {
  it('starts IS-BASIC and evaluates an expression', () => {
    const m = boot(false);
    m.typeText('PRINT 6*7\n', { delayScans: 30, skipSplash: true });
    const ok = runUntil(m, 2000, () => !m.typing && /\b42\b/.test(m.ocrScreenForMcp()));
    expect(m.ocrScreenForMcp()).toContain('IS-BASIC');
    expect(ok).toBe(true);
  });

  it('runs a program from the FILE: device', async () => {
    const m = boot(false);
    const res = await m.services.media.mount(borderProgram(), 'BORDER.COM');
    expect(res.ok).toBe(true);
    expect(runUntil(m, 3000, () => m.nick.border === 0x55)).toBe(true);
  });

  it('runs a program from an EXDOS disk in drive A:', async () => {
    const m = boot(true);
    const disk = buildFatImage([{ name: 'BORDER.COM', data: borderProgram() }]);
    expect(disk).not.toBeNull();
    const res = await m.services.media.mount(serializeFatImage(disk!.image), 'border.img');
    expect(res.ok).toBe(true);
    expect(runUntil(m, 4000, () => m.nick.border === 0x55)).toBe(true);
  });
});
