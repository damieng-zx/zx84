/**
 * FrameProbe contract tests (re-architecture Phase 5, §6 performance rules).
 *
 * The probe's sample() runs once per rAF into ONE shared FrameIndicators
 * struct and must not allocate: the preallocated typed arrays must be
 * overwritten in place (never replaced), and repeated calls must be
 * idempotent reads (no machine mutation). These tests run against real
 * headless machines, not mocks.
 */

import { describe, it, expect } from 'vitest';
import { createFrameIndicators } from '@/machines/machine.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { blankMgtDisk } from '@/media/floppy/mgt-image.ts';
import { parseFloppyImage } from '@/media/floppy/hfe.ts';

/** Minimal valid TAP: one 3-byte block (flag, one payload byte, checksum). */
function tinyTap(): Uint8Array {
  const flag = 0xff, payload = 0x41;
  return new Uint8Array([3, 0, flag, payload, flag ^ payload]);
}

function headless(model: '48k' | '+3'): Spectrum {
  const s = new Spectrum(model, null);
  s.start = async () => {};
  return s;
}

describe('FrameIndicators struct', () => {
  it('preallocates the four drive telemetry arrays with absent (-1) leds', () => {
    const ind = createFrameIndicators();
    expect(Array.from(ind.driveLed)).toEqual([-1, -1, -1, -1]);
    expect(ind.driveTrack.length).toBe(4);
    expect(ind.driveSector.length).toBe(4);
    expect(ind.driveDirty.length).toBe(4);
  });
});

describe('SpectrumFrameProbe.sample', () => {
  it('never replaces the preallocated arrays (in-place overwrite only)', () => {
    const s = headless('+3');
    const ind = createFrameIndicators();
    const led = ind.driveLed, track = ind.driveTrack, sector = ind.driveSector, dirty = ind.driveDirty;
    s.services.probe.sample(ind);
    s.services.probe.sample(ind);
    expect(ind.driveLed).toBe(led);
    expect(ind.driveTrack).toBe(track);
    expect(ind.driveSector).toBe(sector);
    expect(ind.driveDirty).toBe(dirty);
  });

  it('is a pure read: repeated samples yield identical results and leave the deck alone', async () => {
    const s = headless('48k');
    await s.services.media.mount(tinyTap(), 'probe.tap');
    const posBefore = s.tape.position;
    const pausedBefore = s.tape.paused;
    const ind = createFrameIndicators();
    s.services.probe.sample(ind);
    const first = { loaded: ind.tapeLoaded, playing: ind.tapePlaying, paused: ind.tapePaused, pos: ind.tapePosition };
    s.services.probe.sample(ind);
    expect(ind.tapeLoaded).toBe(first.loaded);
    expect(ind.tapePlaying).toBe(first.playing);
    expect(ind.tapePaused).toBe(first.paused);
    expect(ind.tapePosition).toBe(first.pos);
    expect(s.tape.position).toBe(posBefore);
    expect(s.tape.paused).toBe(pausedBefore);
  });

  it('48K: no FDC → all four drive slots absent, no floppy sound feed', () => {
    const s = headless('48k');
    const ind = createFrameIndicators();
    s.services.probe.sample(ind);
    expect(Array.from(ind.driveLed)).toEqual([-1, -1, -1, -1]);
    expect(ind.floppySlot).toBe(-1);
    expect(ind.mdvCount).toBe(0);
  });

  it('+3: uPD765A fills slots A/B; 3" profile derived from a 180KB CF2 disk', () => {
    const s = headless('+3');
    const img = parseFloppyImage(serializeDSK(blankMgtDisk(40, 1)));
    s.loadDisk(img, 0);
    const ind = createFrameIndicators();
    s.services.probe.sample(ind);
    expect(ind.driveLed[0]).toBeGreaterThanOrEqual(0);
    expect(ind.driveLed[1]).toBeGreaterThanOrEqual(0);
    expect(ind.driveLed[2]).toBe(-1);      // no +D/Beta fitted
    expect(ind.floppySlot).toBe(0);        // drive A selected at power-on
    expect(ind.floppyProfile).toBe(0);     // 40 tracks × 1 side ≈ 180KB → 3" CF2
  });

  it('mounted tape reports transport state (loaded, play-paused at block 0)', async () => {
    const s = headless('48k');
    await s.services.media.mount(tinyTap(), 'probe.tap');
    const ind = createFrameIndicators();
    s.services.probe.sample(ind);
    expect(ind.tapeLoaded).toBe(true);
    expect(ind.tapePlaying).toBe(true);
    expect(ind.tapePaused).toBe(true);
    expect(ind.tapePosition).toBe(0);
  });

  it('frameTick auto-rewinds a finished tape only when tapeAutoRewind is set', async () => {
    const s = headless('48k');
    await s.services.media.mount(tinyTap(), 'probe.tap');
    // Run-out deck: position past the last block (finished is derived from
    // position >= blocks.length) with playback stopped.
    s.tape.position = s.tape.blocks.length;
    s.tape.paused = false;
    s.tape.stopPlayback();
    expect(s.tape.finished).toBe(true);
    const ind = createFrameIndicators();

    s.tapeAutoRewind = false;
    s.services.probe.frameTick(ind);
    expect(s.tape.position).toBe(1);       // untouched

    s.tapeAutoRewind = true;
    s.services.probe.frameTick(ind);
    expect(s.tape.position).toBe(0);       // rewound to start, play-paused
    expect(s.tape.paused).toBe(true);
  });

  it('frameTick consumes the uPD765A format latch into formattedSlot exactly once', () => {
    const s = headless('+3');
    const img = parseFloppyImage(serializeDSK(blankMgtDisk(40, 1)));
    s.loadDisk(img, 1);
    s.fdc.formattedUnit = 1;
    const ind = createFrameIndicators();
    ind.formattedSlot = -1;
    s.services.probe.frameTick(ind);
    expect(ind.formattedSlot).toBe(1);
    expect(s.fdc.formattedUnit).toBe(-1);  // latch cleared
    expect(s.services.probe.diskImageForSlot(1)).toBe(img);
    ind.formattedSlot = -1;
    s.services.probe.frameTick(ind);
    expect(ind.formattedSlot).toBe(-1);    // one-shot: does not re-fire
  });
});
