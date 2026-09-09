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
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { SamMachine } from '@/machines/sam/sam-machine.ts';
import type { WD179x } from '@/cores/wd179x.ts';
import { DRIVE_PROFILE } from '@/media/floppy/floppy-sound.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { blankMgtDisk } from '@/media/floppy/mgt-image.ts';
import { parseFloppyImage } from '@/media/floppy/hfe.ts';
import { BLOCK_LEN } from '@/machines/spectrum/peripherals/microdrive.ts';

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

  it('reports the active Interface 1 microdrive sector for the block viewer', async () => {
    const s = headless('48k');
    s.interface1.enabled = true;
    await s.services.media.mount(new Uint8Array(BLOCK_LEN * 2), 'probe.mdr');
    s.interface1.drives[0].motorOn = true;
    s.interface1.drives[0].headPos = BLOCK_LEN + 15;
    const ind = createFrameIndicators();

    s.services.probe.sample(ind);

    expect(ind.mdvCount).toBe(8);
    expect(ind.mdvSector[0]).toBe(1);
    expect(ind.mdvSector[1]).toBe(-1);
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

// ─────────────────────────────────────────────────────────────────────────
// Drive-sound feed on the machines that were silent
//
// The synth is fed from floppySlot/Motor/Track/Profile alone: slot picks the
// per-drive sound setting (and -1 means "no drive to hear"), profile picks
// the drive the synth models. See media/floppy/floppy-sound.ts.
// ─────────────────────────────────────────────────────────────────────────

describe('MtxFrameProbe drive-sound feed', () => {
  function mtx(): MtxMachine {
    const m = new MtxMachine('mtx512', null);
    m.reset();
    return m;
  }

  it('reports the FDX as 5.25", silent until the drive latch runs the motor', () => {
    const m = mtx();
    const ind = createFrameIndicators();
    m.services.probe.sample(ind);
    expect(ind.floppySlot).toBe(0);
    expect(ind.floppyProfile).toBe(DRIVE_PROFILE.fiveAndAQuarterInch);
    expect(ind.floppyMotor).toBe(false);
  });

  it('follows the port-14h latch: drive 1 selected, motor on', () => {
    const m = mtx();
    m.cpu.portOut(0x14, 0x1F);          // drive 1, side 1, motor on, DD
    const ind = createFrameIndicators();
    m.services.probe.sample(ind);
    expect(ind.floppySlot).toBe(1);
    expect(ind.floppyMotor).toBe(true);
    expect(ind.floppyProfile).toBe(DRIVE_PROFILE.fiveAndAQuarterInch);
  });

  it('stays 5.25" for an 80-track image, where the capacity test would say 3.5"', () => {
    const m = mtx();
    m.loadDisk(parseFloppyImage(serializeDSK(blankMgtDisk(80, 2))), 0);
    const ind = createFrameIndicators();
    m.services.probe.sample(ind);
    expect(ind.floppyProfile).toBe(DRIVE_PROFILE.fiveAndAQuarterInch);
  });
});

describe('CpcFrameProbe drive-sound feed', () => {
  it('6128: drive A is a 3" CF2 from a 180KB image', () => {
    const c = new CpcMachine('cpc6128', null);
    c.loadDisk(parseFloppyImage(serializeDSK(blankMgtDisk(40, 1))), 0);
    const ind = createFrameIndicators();
    c.services.probe.sample(ind);
    expect(ind.floppySlot).toBe(0);
    expect(ind.floppyProfile).toBe(DRIVE_PROFILE.threeInch);
    expect(ind.floppyMotor).toBe(false);
  });

  it('6128: an 800KB image in the selected drive means a 3.5" was fitted', () => {
    const c = new CpcMachine('cpc6128', null);
    c.loadDisk(parseFloppyImage(serializeDSK(blankMgtDisk(80, 2))), 0);
    const ind = createFrameIndicators();
    c.services.probe.sample(ind);
    expect(ind.floppyProfile).toBe(DRIVE_PROFILE.threeAndAHalfInch);
  });

  it('464: no drive fitted → no sound feed at all', () => {
    const c = new CpcMachine('cpc464', null);
    const ind = createFrameIndicators();
    c.services.probe.sample(ind);
    expect(ind.floppySlot).toBe(-1);
    expect(ind.floppyProfile).toBe(DRIVE_PROFILE.keep);
  });
});

describe('EinsteinFrameProbe drive-sound feed', () => {
  it('feeds slot A as a 3" drive, tracking the WD1770 head and motor', () => {
    const m = new EinsteinMachine('einstein-tc01', null);
    m.turbo = true;
    m.reset();
    m.loadDisk(parseFloppyImage(serializeDSK(blankMgtDisk(40, 1))), 0);
    const ind = createFrameIndicators();
    m.services.probe.sample(ind);
    expect(ind.floppySlot).toBe(0);
    expect(ind.floppyProfile).toBe(DRIVE_PROFILE.threeInch);
    expect(ind.floppyMotor).toBe(m.fdc.motorOn);
    expect(ind.floppyTrack).toBe(m.fdc.getUnitTrack(0));
  });
});

describe('CpcFrameProbe drive panel', () => {
  function cpc6128(): CpcMachine {
    const c = new CpcMachine('cpc6128', null);
    c.loadDisk(parseFloppyImage(serializeDSK(blankMgtDisk(40, 1))), 0);
    return c;
  }

  it('fills slots A:/B: from the uPD765A and leaves C:/D: absent', () => {
    const c = cpc6128();
    const ind = createFrameIndicators();
    c.services.probe.sample(ind);
    expect(ind.driveLed[0]).toBe(0);        // motor off → LED off
    expect(ind.driveLed[1]).toBe(0);
    expect(ind.driveLed[2]).toBe(-1);       // no +D/Beta on a CPC
    expect(ind.driveLed[3]).toBe(-1);
    expect(ind.driveSector[0]).toBe(-1);    // idle → '--'
    expect(ind.driveDirty[0]).toBe(0);      // freshly inserted image
  });

  it('464: cassette only, so all four slots stay absent', () => {
    const c = new CpcMachine('cpc464', null);
    const ind = createFrameIndicators();
    c.services.probe.sample(ind);
    expect(Array.from(ind.driveLed)).toEqual([-1, -1, -1, -1]);
  });

  it('lights the motor LED on the selected drive alone', () => {
    const c = cpc6128();
    c.fdc.motorOn = true;
    const ind = createFrameIndicators();
    c.services.probe.sample(ind);
    expect(ind.driveLed[0]).toBe(1);        // drive A selected at power-on
    expect(ind.driveLed[1]).toBe(0);        // B: shares the motor line but is not selected
  });

  it('shows write then falls back to motor once the access latch decays', () => {
    const c = cpc6128();
    c.fdc.motorOn = true;
    c.fdc.latchAccess(5, 0, true);          // as a BIOS-trap write leaves it
    const ind = createFrameIndicators();

    c.services.probe.sample(ind);
    expect(ind.driveLed[0]).toBe(3);        // write
    expect(ind.driveSector[0]).toBe(5);

    // The latch runs 25 frames; frameTick is what decays it, and nothing else
    // on the CPC ticks the FDC.
    for (let i = 0; i < 25; i++) c.services.probe.frameTick(ind);
    c.services.probe.sample(ind);
    expect(ind.driveLed[0]).toBe(1);        // back to plain motor
    expect(ind.driveSector[0]).toBe(-1);
  });

  it('publishes a completed FORMAT once, with the image behind the slot', () => {
    const c = cpc6128();
    const ind = createFrameIndicators();
    c.fdc.formattedUnit = 0;

    c.services.probe.frameTick(ind);
    expect(ind.formattedSlot).toBe(0);
    expect(c.services.probe.diskImageForSlot?.(0)).toBe(c.fdc.getDiskImage(0));

    ind.formattedSlot = -1;                 // the bridge clears it each frame
    c.services.probe.frameTick(ind);
    expect(ind.formattedSlot).toBe(-1);     // latch consumed, not re-reported
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Post-FORMAT metadata refresh
//
// A completed WRITE TRACK leaves formattedUnit on the controller; the probe's
// frameTick hands it to the bridge as formattedSlot, which re-detects the
// image's geometry and republishes it to the drive panel. These drive a real
// format through the controller rather than poking the latch.
// ─────────────────────────────────────────────────────────────────────────

/** Feed a WRITE TRACK's format stream: `count` ID fields (0xFE, C,H,R,N) each
 *  followed by a data field (0xFB + payload). The core finalises the track
 *  once it has the controller's configured sectors-per-track. */
function formatTrack(wd: WD179x, count: number, n: number): void {
  wd.writeCommand(0xF0);
  for (let r = 1; r <= count; r++) {
    wd.writeData(0xFE);
    wd.writeData(0);      // C
    wd.writeData(0);      // H
    wd.writeData(r);      // R
    wd.writeData(n);      // N
    wd.writeData(0xFB);   // data address mark
    for (let b = 0; b < (128 << n); b++) wd.writeData(r);
  }
}

describe('post-FORMAT metadata refresh', () => {
  it('MTX: a formatted FDX disk is republished to its panel slot', () => {
    const m = new MtxMachine('mtx512', null);
    m.reset();
    const img = parseFloppyImage(serializeDSK(blankMgtDisk(40, 1)));
    m.loadDisk(img, 0);
    m.cpu.portOut(0x14, 0x1C);            // drive 0, side 0, motor on + ready
    formatTrack(m.fdc, 16, 1);            // the FDX formats 16 sectors a track
    expect(m.fdc.formattedUnit).toBe(0);

    const ind = createFrameIndicators();
    m.services.probe.frameTick!(ind);
    expect(ind.formattedSlot).toBe(0);
    expect(m.services.probe.diskImageForSlot?.(0)).toBe(img);
    expect(m.fdc.formattedUnit).toBe(-1);  // consumed, so it cannot re-fire

    ind.formattedSlot = -1;
    m.services.probe.frameTick!(ind);
    expect(ind.formattedSlot).toBe(-1);
  });

  it('Einstein: the same, through its WD1770', () => {
    const m = new EinsteinMachine('einstein-tc01', null);
    m.turbo = true;
    m.reset();
    const img = parseFloppyImage(serializeDSK(blankMgtDisk(40, 1)));
    m.loadDisk(img, 0);
    m.fdc.selectDrive(0);
    m.fdc.setSide(0);
    formatTrack(m.fdc, 10, 2);            // Xtal DOS: 10 × 512
    expect(m.fdc.formattedUnit).toBe(0);

    const ind = createFrameIndicators();
    m.services.probe.frameTick!(ind);
    expect(ind.formattedSlot).toBe(0);
    expect(m.services.probe.diskImageForSlot?.(0)).toBe(img);
    expect(m.fdc.formattedUnit).toBe(-1);
  });

  it('SAM: the slot is the drive, since each drive is its own controller', () => {
    const m = new SamMachine('sam512', null);
    const img = parseFloppyImage(serializeDSK(blankMgtDisk(80, 2)));
    m.disk.insert(1, img);                // drive 2 → panel slot B:
    const fdc = m.disk.fdc[1];
    fdc.selectDrive(0);
    fdc.setSide(0);
    formatTrack(fdc, 10, 2);
    expect(fdc.formattedUnit).toBe(0);    // the controller's own unit is 0

    const ind = createFrameIndicators();
    m.services.probe.frameTick!(ind);
    expect(ind.formattedSlot).toBe(1);    // ...but it is drive 2 that formatted
    expect(m.services.probe.diskImageForSlot?.(1)).toBe(img);
    expect(fdc.formattedUnit).toBe(-1);
  });
});
