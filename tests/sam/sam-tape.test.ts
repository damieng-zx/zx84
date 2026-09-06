/**
 * SAM Coupé cassette.
 *
 * The SAM's tape port is Spectrum-shaped: pulses arrive on the EAR bit of port
 * 0xFE (bit 6) and MIC goes out on bit 3. SimCoupe reads the same image
 * formats — TAP, TZX, CSW — and converts their 3.5 MHz-referenced pulse
 * lengths to SAM T-states. At 6 MHz that is a scale of 6/3.5, so a pulse must
 * last proportionally longer in T-states than it would on a Spectrum.
 */

import { describe, expect, it } from 'vitest';
import { SamMachine } from '@/machines/sam/sam-machine.ts';
import { TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { LMPR_ROM1, SAM_CPU_CLOCK } from '@/machines/sam/constants.ts';
import { SAM_TAPE_TRAP_PC } from '@/machines/sam/tape-loader.ts';

function machine(): SamMachine {
  const m = new SamMachine('sam512', null);
  m.start = async () => {};
  return m;
}

/**
 * A minimal .tap: one header-less data block of a few bytes. The container is
 * [length lo, length hi, flag, ...data, checksum].
 */
function tinyTap(): Uint8Array {
  const payload = [0xFF, 0x01, 0x02, 0x03];
  let xor = 0;
  for (const b of payload) xor ^= b;
  const body = [...payload, xor];
  return new Uint8Array([body.length & 0xFF, body.length >> 8, ...body]);
}

describe('SAM cassette deck', () => {
  it('scales 3.5 MHz pulse lengths to the SAM 6 MHz clock', () => {
    // A Spectrum-referenced image played on a 6 MHz machine needs its pulses
    // stretched, or every loader runs ~1.7x too fast.
    const m = machine();
    expect(m.tape.pulseScale).toBeCloseTo(SAM_CPU_CLOCK / TAPE_REF_HZ, 6);
    expect(m.tape.pulseScale).toBeGreaterThan(1);
    m.destroy();
  });

  it('mounts a .tap onto the deck', async () => {
    const m = machine();
    const r = await m.services.media.mount(tinyTap(), 'game.tap');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('tape');
    expect(m.services.tape.loaded).toBe(true);
    expect(m.services.tape.name).toBe('game.tap');
    expect(m.services.tape.blocks.length).toBeGreaterThan(0);
    m.destroy();
  });

  it('mounts paused at the start, so the ROM releases it when it pulls', async () => {
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    expect(m.services.tape.position).toBe(0);
    expect(m.services.tape.paused).toBe(true);
    m.destroy();
  });

  it('drives the transport', async () => {
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    const t = m.services.tape;

    t.play();
    expect(t.playing).toBe(true);
    expect(t.paused).toBe(false);

    t.pause();
    expect(t.paused).toBe(true);

    t.resume();
    expect(t.paused).toBe(false);

    t.stop();
    expect(t.playing).toBe(false);
    m.destroy();
  });

  it('rewinds and seeks', async () => {
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    m.services.tape.seek(0);
    expect(m.services.tape.position).toBe(0);
    m.services.tape.rewind();
    expect(m.services.tape.position).toBe(0);
    m.destroy();
  });

  it('ejects', async () => {
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    m.services.tape.eject();
    expect(m.services.tape.loaded).toBe(false);
    expect(m.services.tape.name).toBe('');
    expect(m.services.tape.playing).toBe(false);
    m.destroy();
  });

  it('refuses a tape with no blocks in it', async () => {
    const m = machine();
    const r = await m.services.media.mount(new Uint8Array(0), 'empty.tap');
    expect(r.ok).toBe(false);
    m.destroy();
  });

  it('round-trips transport state across a rebuild', async () => {
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    const stash = m.services.tape.stashState()!;
    expect(stash.blocks!.length).toBeGreaterThan(0);
    m.destroy();

    const m2 = machine();
    m2.services.tape.restoreStash(stash, 'game.tap');
    expect(m2.services.tape.loaded).toBe(true);
    expect(m2.services.tape.name).toBe('game.tap');
    m2.destroy();
  });

  /**
   * The deck mounts with its pause held so playback cannot race ahead of the
   * machine, and nothing but the ROM reaching its cassette loader releases it.
   * Left held, a tape loads nothing at all with fast ROM loading turned off,
   * and a custom loader chained after a tape's ROM blocks finds a stopped
   * tape and strands itself.
   */
  it('releases the deck when the ROM reaches its cassette loader', async () => {
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    expect(m.tape.paused).toBe(true);

    // Put the CPU on the loader with ROM 1 answering, and run the instruction.
    m.memory.setLmpr(LMPR_ROM1);
    m.cpu.pc = SAM_TAPE_TRAP_PC;
    m.tapeFastRom = false;      // the release must not depend on the trap
    m.tick();

    expect(m.tape.paused).toBe(false);
    expect(m.tape.playing).toBe(true);
    expect(m.activity.tapeLoads).toBeGreaterThan(0);
    m.destroy();
  });

  it('leaves the deck alone when ROM 1 is not the thing at C000', async () => {
    // $E670 in a program's own code is not the ROM's loader.
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    m.memory.setLmpr(0);
    m.cpu.pc = SAM_TAPE_TRAP_PC;
    m.tick();
    expect(m.tape.paused).toBe(true);
    expect(m.activity.tapeLoads).toBe(0);
    m.destroy();
  });

  it('has nothing to stash when no tape is mounted', () => {
    const m = machine();
    expect(m.services.tape.stashState()).toBeNull();
    m.destroy();
  });

  it('re-mounts persisted bytes for the reload path', async () => {
    const m = machine();
    expect(await m.services.tape.mountBytes(tinyTap(), 'saved.tap')).toBe(true);
    expect(m.services.tape.loaded).toBe(true);
    expect(m.services.tape.paused).toBe(true);
    // Rubbish is declined rather than mounted empty.
    expect(await m.services.tape.mountBytes(new Uint8Array(0), 'bad.tap')).toBe(false);
    m.destroy();
  });
});

describe('SAM cassette EAR bit', () => {
  it('presents the deck level on port 0xFE bit 6', async () => {
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    m.services.tape.play();

    // Run until the deck's level has been seen both low and high through the
    // port — a stuck EAR bit would never satisfy both.
    let sawLow = false;
    let sawHigh = false;
    for (let i = 0; i < 200_000 && !(sawLow && sawHigh); i++) {
      m.cpu.tStates += 8;
      const v = m.cpu.portIn!(0xFFFE);
      if (v & 0x40) sawHigh = true; else sawLow = true;
    }
    expect(sawLow).toBe(true);
    expect(sawHigh).toBe(true);
    m.destroy();
  });

  it('produces no edges through port 0xFE while the deck is paused', async () => {
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    // Mounted paused: polling must not advance the tape.
    const first = m.cpu.portIn!(0xFFFE) & 0x40;
    for (let i = 0; i < 5000; i++) {
      m.cpu.tStates += 8;
      expect(m.cpu.portIn!(0xFFFE) & 0x40).toBe(first);
    }
    m.destroy();
  });

  it('does not skip the tape forward across a pause', async () => {
    // The deck is advanced by the delta since it was last caught up, so if
    // that baseline goes stale while paused, resuming hands it the whole
    // paused interval at once and the tape jumps.
    //
    // Differential check: two machines play for the same number of PLAYED
    // T-states, but one idles through a long pause in the middle. They must
    // end on the same point of the tape.
    const poll = (m: SamMachine, ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        m.cpu.tStates += 16;
        m.cpu.portIn!(0xFFFE);
      }
      return m.cpu.portIn!(0xFFFE) & 0x40;
    };

    const control = machine();
    await control.services.media.mount(tinyTap(), 'game.tap');
    control.services.tape.play();
    poll(control, 400);
    const expected = poll(control, 400);
    control.destroy();

    const paused = machine();
    await paused.services.media.mount(tinyTap(), 'game.tap');
    paused.services.tape.play();
    poll(paused, 400);
    paused.services.tape.pause();
    poll(paused, 5000);              // a long wait, consuming no tape
    paused.services.tape.resume();
    expect(poll(paused, 400)).toBe(expected);
    paused.destroy();
  });

  it('counts tape reads for the activity LED', async () => {
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    m.services.tape.play();
    m.activity.tapeReads = 0;
    m.cpu.portIn!(0xFFFE);
    expect(m.activity.tapeReads).toBe(1);
    m.destroy();
  });
});

describe('SAM cassette in the frame probe', () => {
  it('reports transport state to the tape pane', async () => {
    const { createFrameIndicators } = await import('@/machines/machine.ts');
    const m = machine();
    const out = createFrameIndicators();

    m.services.probe.sample(out);
    expect(out.tapeLoaded).toBe(false);

    await m.services.media.mount(tinyTap(), 'game.tap');
    m.services.tape.play();
    m.services.probe.sample(out);
    expect(out.tapeLoaded).toBe(true);
    expect(out.tapePlaying).toBe(true);
    expect(out.tapePaused).toBe(false);
    expect(out.tapePosition).toBe(0);
    // The SAM's deck is pulse-level, so the instant-cassette channel is unused.
    expect(out.casBlock).toBe(-1);
    m.destroy();
  });
});

/**
 * Turbo while loading.
 *
 * The ROM trap only accelerates the ROM's own blocks, and most SAM tapes spend
 * them on a short bootstrap before handing over to a custom loader that has to
 * be executed for real. Turbo runs that code faster; without it the headline
 * load is still a real-time one however well the trap did on the first two
 * blocks.
 *
 * What engages it is simply how hard the tape port was hammered in the frame:
 * a loader polls it at the pulse rate and nothing else on the machine gets
 * close. These tests drive that for real — a tight `IN A,(&FE)` loop in RAM
 * against an idle one — rather than poking the counter.
 */
describe('SAM tape turbo', () => {
  /** Park a two-instruction loop at 0x8000 and point the CPU at it. */
  function loopAt(m: SamMachine, ...bytes: number[]): void {
    bytes.forEach((b, i) => m.memory.writeByte(0x8000 + i, b));
    m.cpu.pc = 0x8000;
  }
  /** IN A,(&FE) / JR -4 — a loader sampling the tape. */
  const POLL_LOOP = [0xDB, 0xFE, 0x18, 0xFC];
  /** JR -2 — a program doing nothing with the tape at all. */
  const IDLE_LOOP = [0x18, 0xFE];

  async function loaded(): Promise<SamMachine> {
    const m = machine();
    await m.services.media.mount(tinyTap(), 'game.tap');
    m.tape.paused = false;
    m.tape.startPlayback();
    return m;
  }

  it('engages while a loader is polling the tape port', async () => {
    const m = await loaded();
    expect(m.tapeTurboActive).toBe(false);
    loopAt(m, ...POLL_LOOP);
    m.tick();
    expect(m.activity.tapeReads).toBeGreaterThan(1000);
    expect(m.tapeTurboActive).toBe(true);
    m.destroy();
  });

  it('lets go once the polling stops, after a cooldown', async () => {
    const m = await loaded();
    loopAt(m, ...POLL_LOOP);
    m.tick();
    expect(m.tapeTurboActive).toBe(true);

    loopAt(m, ...IDLE_LOOP);
    m.tick();
    // Still held: the cooldown rides out the gap between two blocks rather
    // than dropping to 1x and straight back up again.
    expect(m.tapeTurboActive).toBe(true);
    for (let f = 0; f < 30; f++) m.tick();
    expect(m.tapeTurboActive).toBe(false);
    m.destroy();
  });

  it('stays out of the way when the setting is off', async () => {
    const m = await loaded();
    m.tapeTurbo = false;
    loopAt(m, ...POLL_LOOP);
    m.tick();
    expect(m.activity.tapeReads).toBeGreaterThan(1000);
    expect(m.tapeTurboActive).toBe(false);
    m.destroy();
  });

  /** A paused deck counts no polls, so the user's pause releases turbo — the
   *  machine must not stay flat out because a program happens to read the
   *  keyboard through the same port. */
  it('does not engage on a paused deck', async () => {
    const m = await loaded();
    m.tape.paused = true;
    loopAt(m, ...POLL_LOOP);
    m.tick();
    expect(m.activity.tapeReads).toBe(0);
    expect(m.tapeTurboActive).toBe(false);
    m.destroy();
  });
});
