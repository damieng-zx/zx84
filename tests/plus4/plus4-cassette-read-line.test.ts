/**
 * The Plus/4's cassette read line (7501 port bit 4).
 *
 * The port's bit 4 is the Datasette's read signal: the KERNAL's tape reader
 * (`tapred.src`: "wait till rd line is high … wait till it's low") spins on its
 * edges and times the pulse between them. The PLAY sense is a different signal
 * — a steady deck-button level on PIO 1 bit 2 (`$FD10`), which is where the
 * KERNAL's `tstply` reads it.
 *
 * The machine used to drive bit 4 from the PLAY sense, which never moves while
 * a tape runs, so every read returned the same level and the reader's edge
 * waits never completed.
 *
 * Expectations from the hardware: 264-series schematics put the Datasette's
 * read line on the 7501 port, and VICE's `plus4mem.c` builds bit 4 from
 * `tape_read` (the flux level) while `plus4pio1.c` carries the sense.
 */

import { describe, expect, it } from 'vitest';
import { Plus4Machine } from '@/machines/plus4/plus4-machine.ts';
import { firmware } from './firmware.ts';

const PORT_BIT4 = 0x10;

function machine(): Plus4Machine {
  const m = new Plus4Machine('plus4', null, false);
  m.loadROM(firmware());
  m.reset();
  // Drive the port's data direction so the input bits are read, not latched:
  // the KERNAL sets DDR 0x2F, leaving bits 4-7 as inputs.
  m.memory.writeByte(0, 0x2F);
  m.memory.writeByte(1, 0x00);
  return m;
}

/** Mount a tape with a known pulse pattern and press PLAY. */
function withTape(): Plus4Machine {
  const m = machine();
  // Two short pulses then two long ones, long enough to observe.
  m.tape.blocks = [{
    kind: 'csw',
    label: 'test',
    role: 'data',
    pulses: Uint32Array.from([4000, 4000, 16000, 16000]),
  }];
  m.tape.position = 0;
  m.tape.paused = true;
  m.tapeTransportChanged();
  m.tape.startPlayback();
  m.tapeTransportChanged();
  return m;
}

describe('Plus/4 cassette read line', () => {
  it('follows the tape, not the PLAY sense', () => {
    const m = withTape();
    try {
      expect(m.tape.playing, 'a tape is running').toBe(true);
      expect(m.tapeSense, 'PLAY is down as well').toBe(true);

      // Sample the read line every instruction across several frames. The PLAY
      // sense cannot change here, so any transitions are the tape's. Both
      // levels must appear, and the level must be the deck's `earBit` at the
      // moment of the read — not a constant.
      const levels = new Set<number>();
      let mismatches = 0;
      m.onTrap = () => {
        const bit = (m.memory.readByte(1) & PORT_BIT4) !== 0 ? 1 : 0;
        levels.add(bit);
        if (bit !== m.tape.earBit) mismatches++;
        return false;
      };
      for (let f = 0; f < 3; f++) m.tick();
      m.onTrap = null;
      expect([...levels].sort(), 'the read line is a signal, not a level').toEqual([0, 1]);
      expect(mismatches, 'and it is the deck\'s own level').toBe(0);
    } finally { m.destroy(); }
  });

  it('reads low with the motor stopped — no signal on the line', () => {
    // The Plus/4's reference material: "B4 is the datasette read signal. When
    // the datasette motor is turned off, this bit usually reads 0." An empty
    // deck is the same case, and it is also the case that used to read the
    // *steady* PLAY level, which is low on an empty deck for an unrelated
    // reason (a blank cassette stands with RECORD and PLAY down).
    const m = machine();
    try {
      expect(m.tapeSense, 'an empty deck has PLAY down').toBe(true);
      expect(m.tape.playing, 'nothing is moving').toBe(false);
      expect((m.memory.readByte(1) & PORT_BIT4), 'no tape: the read line is low').toBe(0);
    } finally { m.destroy(); }
  });

  it('keeps the PLAY sense on PIO 1 bit 2, where the KERNAL reads it', () => {
    const m = machine();
    try {
      expect(m.pio1.pins & 0x04, 'PLAY down pulls bit 2 low').toBe(0);
      m.tape.blocks = [{
        kind: 'csw', label: 't', role: 'data', pulses: Uint32Array.from([4000, 4000]),
      }];
      m.tape.paused = true;
      m.tapeTransportChanged();
      expect(m.pio1.pins & 0x04, 'PLAY up between tapes').toBe(0x04);
    } finally { m.destroy(); }
  });
});
