/**
 * The Oric's status lights and Save menu.
 *
 * The frame probe reported the cassette and disk channels as hard-coded zeros,
 * so the tape and disk LEDs could never light no matter what the machine was
 * doing. The Save menu offered "Saved tape" while the exporter's decoder
 * (`decodeSavedTape`) returns nothing: the entry was a promise nothing kept.
 *
 * Expectations: the probe is a pure read of state the machine already tracks
 * (`activity`, `tape`, `microdisc`), and every Save-menu entry has a service
 * that can produce it (the rule `tests/machine-capabilities.test.ts` states).
 */

import { describe, expect, it } from 'vitest';
import { OricMachine } from '@/machines/oric/oric-machine.ts';
import { createFrameIndicators } from '@/machines/machine.ts';
import { oricEntry } from '@/machines/oric/descriptor.ts';
import { OricTape } from '@/machines/oric/oric-tape.ts';

function machine(): OricMachine {
  const m = new OricMachine('oric1', null);
  m.reset();
  return m;
}

describe('Oric frame probe', () => {
  it('reports the cassette read line and transport state', () => {
    const m = machine();
    try {
      const out = createFrameIndicators();
      m.services.probe.sample(out);
      expect(out.tapeLoaded, 'nothing mounted yet').toBe(false);
      expect(out.tapePlaying).toBe(false);
      expect(out.tapePaused).toBe(true);

      // Put a signal under the head and run the deck. The pulses are long
      // enough (a tape's tones are hundreds of cycles, a frame is tens of
      // thousands) that several frames do not run off the end.
      const tape = m.tape;
      const lengths = new Array(64).fill(20_000);
      expect(tape.mount([{ kind: 'pulses', lengths } as never])).toBe(true);
      tape.paused = false;
      tape.setMotor(true);
      m.services.probe.sample(out);
      expect(out.tapeLoaded, 'a tape is on the deck').toBe(true);
      expect(out.tapePlaying, 'and the motor is running').toBe(true);
      expect(out.tapePaused).toBe(false);

      // `tapeIn` is the data line the VIA's CB1 sees, so it must follow the
      // deck rather than being a constant.
      const levels = new Set<number>();
      for (let f = 0; f < 40; f++) {
        m.tick();
        m.services.probe.sample(out);
        levels.add(out.tapeIn);
      }
      expect([...levels].sort(), 'the read line toggles').toEqual([0, 1]);
    } finally { m.destroy(); }
  });

  it('reports the disk channel from the controller\'s own activity', () => {
    const m = machine();
    try {
      const out = createFrameIndicators();
      m.services.probe.sample(out);
      expect(out.disk, 'no Microdisc fitted, and nothing touching it').toBe(0);

      // The counter the probe reads is the machine's (as on the CPC and the
      // other FDC machines), so the probe must not invent a channel of its own.
      m.activity.fdcAccesses = 7;
      m.services.probe.sample(out);
      expect(out.disk, 'the probe reads activity.fdcAccesses').toBe(7);
    } finally { m.destroy(); }
  });
});

describe('Oric cassette read line', () => {
  it('sits high with no tape mounted', () => {
    const tape = new OricTape(1_000_000);
    expect(tape.level, 'an empty deck reads high').toBe(1);
    expect(tape.loaded).toBe(false);
  });
});

describe('Oric Save menu', () => {
  it('does not offer a tape export the decoder cannot produce', () => {
    // `decodeSavedTape` documents that it returns nothing until the ROM's frame
    // format is established, so `recordedBytes()` is always null. An entry that
    // can only ever answer "nothing saved" is a dead control.
    const menu = oricEntry.descriptor('oric1').ui.saveMenu;
    expect(menu).not.toContain('tape-tap');
    expect(menu).toEqual(expect.arrayContaining([
      'snapshot-oricstate', 'screenshot-png', 'ram-bin',
    ]));
  });
});
