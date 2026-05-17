/**
 * tape-state — six createSignal wrappers driving the tape pane UI.
 *
 * The non-obvious default worth pinning: `tapePaused` starts TRUE while
 * `tapePlaying` starts FALSE. The deck auto-unpauses when the user hits
 * LOAD (spectrum.ts wires this through the ROM trap and LoaderDetector).
 * If a refactor ever flips `tapePaused` to default-false the audio mixer
 * would start trying to feed an empty deck immediately on first frame.
 *
 * `tapePlaying = true` AND `tapePaused = true` simultaneously is the
 * "loaded, ready, halted" state — both flags are independent on purpose,
 * not a state-machine pair.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as tape from '@/state/tape-state.ts';
import type { TapeBlock } from '@/tape/tap.ts';

afterEach(() => {
  tape.setTapeLoaded(false);
  tape.setTapeName('');
  tape.setTapeBlocks([]);
  tape.setTapePosition(0);
  tape.setTapePaused(true);
  tape.setTapePlaying(false);
});

describe('tape-state — defaults', () => {
  it('no tape loaded, no name, no blocks, position 0', () => {
    expect(tape.tapeLoaded()).toBe(false);
    expect(tape.tapeName()).toBe('');
    expect(tape.tapeBlocks()).toEqual([]);
    expect(tape.tapePosition()).toBe(0);
  });

  it('starts paused but NOT playing — the "no deck activity" combo', () => {
    expect(tape.tapePaused()).toBe(true);
    expect(tape.tapePlaying()).toBe(false);
  });
});

describe('tape-state — independence of paused/playing', () => {
  it('both flags can be true simultaneously (loaded + halted state)', () => {
    tape.setTapePlaying(true);
    tape.setTapePaused(true);
    expect(tape.tapePlaying()).toBe(true);
    expect(tape.tapePaused()).toBe(true);
  });

  it('both flags can be false simultaneously (stopped state)', () => {
    tape.setTapePlaying(false);
    tape.setTapePaused(false);
    expect(tape.tapePlaying()).toBe(false);
    expect(tape.tapePaused()).toBe(false);
  });

  it('flipping one does not move the other', () => {
    tape.setTapePaused(false);
    expect(tape.tapePlaying()).toBe(false); // playing untouched
    tape.setTapePlaying(true);
    expect(tape.tapePaused()).toBe(false); // paused untouched
  });
});

describe('tape-state — getter/setter pairing', () => {
  it('tapeLoaded round-trips', () => {
    tape.setTapeLoaded(true);
    expect(tape.tapeLoaded()).toBe(true);
  });

  it('tapeName round-trips', () => {
    tape.setTapeName('Manic Miner.tap');
    expect(tape.tapeName()).toBe('Manic Miner.tap');
  });

  it('tapeBlocks round-trips with the array reference preserved', () => {
    const blocks: TapeBlock[] = [
      { kind: 'pause', duration: 1000 },
      { kind: 'group-end' },
    ];
    tape.setTapeBlocks(blocks);
    expect(tape.tapeBlocks()).toBe(blocks); // same ref, not a copy
  });

  it('tapePosition round-trips integers including 0', () => {
    tape.setTapePosition(42);
    expect(tape.tapePosition()).toBe(42);
    tape.setTapePosition(0);
    expect(tape.tapePosition()).toBe(0);
  });
});
