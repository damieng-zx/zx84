/**
 * The NewBrain, proved against its real firmware: the Z80 OS, the COP420's
 * keyboard / cassette / display program and the character generator.
 *
 * Needs the five ROM images the registry names (grundy/newbrain-a.rom,
 * -cd.rom, -ef.rom, -cop.rom, -char.rom): place them in mcp/.cache (the MCP
 * server fetches them there) or point NEWBRAIN_ROM_DIR at a folder holding
 * them. Skipped without them.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NewBrainMachine } from '@/machines/newbrain/newbrain-machine.ts';
import { wavToPulseBlocks } from '@/media/tape/wav.ts';
import { entryForModel } from '@/machines/registry.ts';

const DIR = process.env.NEWBRAIN_ROM_DIR ?? join(import.meta.dirname, '../../mcp/.cache');
const NAMES = entryForModel('newbrain').romSources('newbrain').map(s => s.split('/').pop()!);
const HAVE_ROMS = NAMES.every(n => existsSync(join(DIR, n)));

function image(): Uint8Array {
  const parts = NAMES.map(n => new Uint8Array(readFileSync(join(DIR, n))));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function boot(): NewBrainMachine {
  const m = new NewBrainMachine('newbrain', null);
  m.loadROM(image());
  m.reset();
  for (let i = 0; i < 300; i++) m.tick();
  return m;
}

/** Type text through the host-keyboard path, a frame at a time. */
function type(m: NewBrainMachine, text: string): void {
  for (const c of text) {
    const code = c === ' ' ? 'Space' : c === '\n' ? 'Enter' : `Key${c}`;
    m.keyboard.handleKeyEvent(code, true, c);
    for (let i = 0; i < 8; i++) m.tick();
    m.keyboard.handleKeyEvent(code, false, c);
    for (let i = 0; i < 6; i++) m.tick();
  }
}

const screen = (m: NewBrainMachine) => m.ocrScreenForMcp().split('\n').slice(1);

describe.skipIf(!HAVE_ROMS)('NewBrain firmware', () => {
  it('boots to the BASIC prompt', () => {
    const m = boot();
    expect(screen(m).slice(0, 2)).toEqual(['NEWBRAIN BASIC', 'READY']);
  });

  it('draws the text into the picture, not just into RAM', () => {
    const m = boot();
    // "NEWBRAIN BASIC" starts at the third byte of the first row. Draw the
    // frame and look for ink in the first character cell (an N has its left
    // stem lit on most rows), then nothing out past the end of the line.
    let ink = 0;
    const px = new Uint32Array(m.pixels.buffer);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 16; x++) if (px[y * 640 + x] !== 0xff000000) ink++;
    expect(ink).toBeGreaterThan(10);
    for (let x = 400; x < 640; x++) expect(px[x]).toBe(0xff000000);
  });

  it('types a program through the COP420 keyboard scan, SHIFT included, and runs it', () => {
    const m = boot();
    type(m, '10 PRINT "HELLO"\n');
    type(m, 'run\n');
    for (let i = 0; i < 60; i++) m.tick();
    const rows = screen(m);
    expect(rows).toContain('10 PRINT "HELLO"');
    expect(rows).toContain('HELLO');
  });

  it('saves to cassette through the COP420 and loads the recording back into a fresh machine', () => {
    const a = boot();
    type(a, '10 PRINT "ROUND TRIP"\n');
    type(a, 'save "t"\n');
    for (let i = 0; i < 1500; i++) a.tick();
    const saved = a.services.tape.recordedBytes!();
    expect(saved, 'a SAVE leaves a recording behind').not.toBeNull();

    const b = boot();
    (b.services.tape as unknown as { mountBlocks(blocks: unknown, name: string): void })
      .mountBlocks(wavToPulseBlocks(saved!.data), saved!.filename);
    type(b, 'load "t"\n');
    for (let i = 0; i < 1500; i++) b.tick();
    type(b, 'list\n');
    for (let i = 0; i < 60; i++) b.tick();
    expect(screen(b)).toContain('10 PRINT "ROUND TRIP"');
  }, 60_000);
});
