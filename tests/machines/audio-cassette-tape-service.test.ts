/** The audio-cassette deck and its tape transport, shared by the Apple I and Apple II. */

import { describe, it, expect } from 'vitest';
import { AudioCassette } from '@/machines/shared/audio-cassette.ts';
import { AudioCassetteTapeService } from '@/machines/shared/audio-cassette-tape-service.ts';

/** An 8-bit mono 44.1 kHz WAV of `n` samples, alternating full-scale halves of `len` samples. */
function squareWav(n: number, len = 4): Uint8Array {
  const out = new Uint8Array(44 + n);
  const v = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); v.setUint32(4, 36 + n, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20], 8);
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 44100, true); v.setUint32(28, 44100, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) out[44 + i] = Math.floor(i / len) % 2 === 0 ? 0xE0 : 0x20;
  return out;
}

function deckAndService() {
  const machine = { cassette: new AudioCassette() };
  return { machine, tape: new AudioCassetteTapeService(machine) };
}

describe('AudioCassetteTapeService', () => {
  it('shows no blocks and no position with nothing mounted', () => {
    const { tape } = deckAndService();
    expect(tape.loaded).toBe(false);
    expect(tape.blocks).toEqual([]);
    expect(tape.position).toBe(-1);
  });

  it('presents a mounted recording as one audio block named after the file', () => {
    const { tape } = deckAndService();
    expect(tape.mountWav(squareWav(100), 'game.wav')).toBe(true);
    expect(tape.loaded).toBe(true);
    expect(tape.blocks).toEqual([
      { index: 0, label: 'game.wav', detail: 'audio recording', kind: 'audio' },
    ]);
    expect(tape.position).toBe(0);
  });

  it('refuses a file that is not a WAV and leaves the deck empty', () => {
    const { tape } = deckAndService();
    expect(tape.mountWav(new Uint8Array(64), 'junk.wav')).toBe(false);
    expect(tape.loaded).toBe(false);
  });

  it('play and stop drive the deck; pause is the inverse of playing', () => {
    const { tape, machine } = deckAndService();
    tape.mountWav(squareWav(100), 't.wav');
    expect(tape.paused).toBe(true);
    tape.play();
    expect(machine.cassette.playing).toBe(true);
    expect(tape.paused).toBe(false);
    tape.stop();
    expect(machine.cassette.playing).toBe(false);
  });

  it('rewinds a finished tape when play is pressed', () => {
    const { tape, machine } = deckAndService();
    tape.mountWav(squareWav(44), 't.wav');
    machine.cassette.playing = true;
    machine.cassette.advanceTo(1);            // runs far past the 1 ms recording
    expect(machine.cassette.finished).toBe(true);
    tape.play();
    expect(machine.cassette.finished).toBe(false);
    expect(machine.cassette.playing).toBe(true);
  });

  it('stashes the recording it was given and restores it on another deck', () => {
    const { tape } = deckAndService();
    const wav = squareWav(100);
    tape.mountWav(wav, 'a.wav');
    const stash = tape.stashState();
    expect(stash?.casData).toEqual(wav);

    const other = deckAndService();
    other.tape.restoreStash(stash!, 'a.wav');
    expect(other.tape.loaded).toBe(true);
    expect(other.tape.name).toBe('a.wav');
  });

  it('has nothing to stash after eject', () => {
    const { tape } = deckAndService();
    tape.mountWav(squareWav(100), 'a.wav');
    tape.eject();
    expect(tape.loaded).toBe(false);
    expect(tape.stashState()).toBeNull();
  });
});
