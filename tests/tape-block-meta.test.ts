/**
 * Tape-pane block formatting.
 *
 * The Lynx .tap carries a quoted name entry and a typed data entry. The pane
 * must show them as one file line (name + load command + type), and hide the
 * data child behind its name header when "combine paired blocks" is on — the
 * same shape the Spectrum's header/data pairs get.
 */

import { describe, expect, it } from 'vitest';
import type { DataBlock, TapeFileInfo } from '@/media/tape/tap.ts';
import { parseTapeBlockMeta } from '@/ui/panes/tape-block-meta.ts';

function fileBlock(file: TapeFileInfo): DataBlock {
  return {
    kind: 'data', flag: 0, data: new Uint8Array(), file,
    pause: 0, pilotPulse: 0, syncPulse1: 0, syncPulse2: 0,
    bit0Pulse: 1, bit1Pulse: 2, pilotCount: 0, usedBits: 8, source: 'pure-data',
  };
}

const HEADER = fileBlock({ name: 'INVADERS', type: 'M', typeName: 'CODE', command: 'MLOAD', size: 12299, header: true });
const DATA = fileBlock({ name: 'INVADERS', type: 'M', typeName: 'CODE', command: 'MLOAD', size: 12299, header: false });

describe('tape block meta — Lynx file entries', () => {
  it('shows a name header as the load line with its type and size', () => {
    const meta = parseTapeBlockMeta(HEADER, 0, [HEADER, DATA], false);
    expect(meta.line).toBe('0: MLOAD "INVADERS"');
    expect(meta.detail).toBe('CODE · 12299 bytes');
    expect(meta.hidden).toBe(false);
    expect(meta.absorbsNext).toBe(false);   // combining is off
  });

  it('absorbs the data child when combining paired blocks', () => {
    expect(parseTapeBlockMeta(HEADER, 0, [HEADER, DATA], true).absorbsNext).toBe(true);
    expect(parseTapeBlockMeta(DATA, 1, [HEADER, DATA], true).hidden).toBe(true);
  });

  it('keeps the data block listed when combining is off', () => {
    const meta = parseTapeBlockMeta(DATA, 1, [HEADER, DATA], false);
    expect(meta.hidden).toBe(false);
    expect(meta.line).toBe('1: MLOAD "INVADERS"');
  });

  it('shows a nameless entry as its own load line', () => {
    const only = fileBlock({ name: '', type: 'B', typeName: 'BASIC', command: 'LOAD', size: 9, header: true });
    const meta = parseTapeBlockMeta(only, 0, [only], true);
    expect(meta.line).toBe('0: LOAD');
    expect(meta.detail).toBe('BASIC · 9 bytes');
    expect(meta.absorbsNext).toBe(false);
  });
});
