/**
 * Tape State - tape deck control signals.
 *
 * Tracks tape loading, playback, and position:
 * - Tape loaded/name/blocks
 * - Playback state (playing/paused)
 * - Position within tape
 */

import { createSignal } from 'solid-js';
import type { TapeBlock } from '@/media/tape/tap.ts';
import type { CasBlock } from '@/machines/msx/msx-tape.ts';

const _tapeLoaded = createSignal(false);
export const tapeLoaded = _tapeLoaded[0];
export const setTapeLoaded = _tapeLoaded[1];

const _tapeName = createSignal('');
export const tapeName = _tapeName[0];
export const setTapeName = _tapeName[1];

const _tapeBlocks = createSignal<TapeBlock[]>([]);
export const tapeBlocks = _tapeBlocks[0];
export const setTapeBlocks = _tapeBlocks[1];

// MSX .cas blocks (the MSX cassette is instant-load, so it has its own simple
// block list separate from the pulse-level TapeBlock[] above).
const _casBlocks = createSignal<CasBlock[]>([]);
export const casBlocks = _casBlocks[0];
export const setCasBlocks = _casBlocks[1];

// Index of the .cas block currently being read (-1 = none / not loading).
const _casPosition = createSignal(-1);
export const casPosition = _casPosition[0];
export const setCasPosition = _casPosition[1];

const _tapePosition = createSignal(0);
export const tapePosition = _tapePosition[0];
export const setTapePosition = _tapePosition[1];

const _tapePaused = createSignal(true);
export const tapePaused = _tapePaused[0];
export const setTapePaused = _tapePaused[1];

const _tapePlaying = createSignal(false);
export const tapePlaying = _tapePlaying[0];
export const setTapePlaying = _tapePlaying[1];
