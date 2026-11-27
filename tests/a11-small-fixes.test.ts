/**
 * The small faults from the A11 group: a picker that rejected a format the
 * service accepts, a hard-coded server version, a core that built its audio
 * device twice, a snapshot latch that assumed "D5 means locked", a controller
 * reset that left its lost-data window armed, a status line that fired on every
 * settings change, and a cache key that could never change.
 *
 * Each expectation is a statement about the hardware or the contract between
 * two modules, not a description of the current code.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spectrumDescriptor } from '@/machines/spectrum/descriptor.ts';
import { WD179x } from '@/cores/wd179x.ts';
import { MtxMemory } from '@/machines/mtx/mtx-memory.ts';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';

const ROOT = resolve(__dirname, '..');

describe('Spectrum tape picker', () => {
  it('offers every extension the media service accepts', () => {
    // The service routes .cdt exactly like .tzx (both are TZX containers), but
    // the picker's extension list left it out, so a .cdt could not be chosen.
    const list = spectrumDescriptor('zx48k').ui.tapeExtensions;
    for (const ext of ['.tap', '.tzx', '.cdt', '.csw', '.wav', '.zip']) {
      expect(list, `${ext} is accepted and must be selectable`).toContain(ext);
    }
  });
});

describe('MCP server version', () => {
  it('is read from package.json rather than hard-coded', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string };
    const source = readFileSync(resolve(ROOT, 'mcp/server.ts'), 'utf8');
    // The server must not carry its own literal: AGENTS.md names package.json as
    // the single source of the app version.
    expect(source, 'no hard-coded version literal').not.toMatch(/version:\s*'\d+\.\d+\.\d+'/);
    expect(source, 'reads package.json').toContain('package.json');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('Atari audio', () => {
  it('builds one audio device, not two', () => {
    // A field initialiser plus a constructor assignment made a second `Audio`
    // and threw the first away (on a `readonly` field, so it was also a lie).
    const source = readFileSync(resolve(ROOT, 'src/machines/atari/atari-machine.ts'), 'utf8');
    const constructions = source.match(/new Audio\(\)/g) ?? [];
    expect(constructions, 'one construction site').toHaveLength(1);
  });
});

describe('Snapshot 7FFD latch', () => {
  it('does not treat D5 as a lock on a Pentagon 1024 in 1MB mode', () => {
    // In 1MB mode D5 is a page bit, so it cannot lock paging — the rule the
    // machine itself applies in `locksPaging()`. The snapshot loaders hard-coded
    // `(port7FFD & 0x20) !== 0` instead.
    for (const file of ['sna.ts', 'sp.ts', 'z80format.ts']) {
      const source = readFileSync(resolve(ROOT, 'src/machines/spectrum/snapshots', file), 'utf8');
      expect(source, `${file} latches through the machine's own rule`).toContain('latch7FFD(');
      expect(source, `${file} has no bare D5 check`).not.toMatch(/pagingLocked\s*=\s*\(port7FFD\s*&\s*0x20\)/);
    }
  });
});

describe('WD179x reset', () => {
  it('clears the lost-data window with the command that opened it', () => {
    // The window belongs to an in-flight write. Leaving it armed past a reset
    // let a later poll raise LOST DATA for a command that no longer existed.
    const fdc = new WD179x({
      statusBit7: 'motor-on', formatSectorsPerTrack: 9, lostDataPolls: 1,
    });
    const armed = fdc as unknown as { awaitingFirstByte: boolean; idlePolls: number };
    // A write command would arm it; arm it directly to isolate the reset.
    armed.awaitingFirstByte = true;
    armed.idlePolls = 0;
    fdc.reset();
    expect(armed.awaitingFirstByte, 'reset disarms it').toBe(false);
    expect(armed.idlePolls, 'and drops its poll count').toBe(0);
    fdc.readStatus();
    fdc.pollForLostData();
    expect(fdc.readStatus() & 0x04, 'no LOST DATA after a reset').toBe(0);
  });
});

describe('MTX 512K status line', () => {
  it('says nothing when the board is already in the state asked for', () => {
    const m = new MtxMachine('rs128', null);
    try {
      const said: string[] = [];
      m.onStatus = (msg: string) => said.push(msg);
      m.set512kRamEnabled(true);
      expect(said[0], 'the first call reports the fit').toContain('512 KiB RAM expansion enabled');
      // A second call with the same value (which every settings change makes)
      // must not repaint the status line.
      m.set512kRamEnabled(true);
      expect(said, 'the repeat is silent').toHaveLength(1);
      // A real change still speaks.
      m.set512kRamEnabled(false);
      expect(said).toHaveLength(2);
      expect(said[1]).toContain('disabled');
    } finally { m.destroy(); }
  });
});

describe('MTX memory expansion', () => {
  it('keeps the base RAM blocks and adds the expansion', () => {
    const mem = new MtxMemory('rs128');
    const base = mem.ramSizeBytes;
    mem.set512kRamExpansionEnabled(true);
    expect(mem.ramSizeBytes).toBe(base + 512 * 1024);
    mem.set512kRamExpansionEnabled(false);
    expect(mem.ramSizeBytes).toBe(base);
  });
});
