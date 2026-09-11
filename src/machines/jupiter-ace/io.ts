/**
 * Jupiter Ace port I/O dispatch + memory hooks.
 *
 * The Ace has exactly one I/O device: the ULA, decoded on any even port
 * (bit 0 = 0) with the keyboard half-row select in the high byte — the same
 * convention as the Spectrum's port 0xFE. Odd ports read open bus (0xFF).
 * There is no port contention and no floating-bus video value to model (the
 * ULA never drives odd-port reads), so the handlers are plain closures.
 *
 * Memory contention: the real ULA steals cycles from the CPU while it reads
 * the screen file and char RAM during the display window, but the Ace's exact
 * ULA fetch pattern (2 reads per cell at a 208T line) has no published
 * reference timing, so no contention is applied — matching the MSX/ZX80/ZX81
 * machines, which are likewise contention-free here.
 */

import type { JupiterAceMachine } from './ace-machine.ts';

/** Install CPU memory read/write hooks (no contention on the Ace). */
export function installAceMemoryHooks(m: JupiterAceMachine): void {
  const memory = m.memory;
  const cpu = m.cpu;

  cpu.read8 = (addr: number): number => {
    addr &= 0xFFFF;
    const val = memory.readByte(addr);
    if (m.memWatchpoints.length > 0 && m.memWatchHit === null) {
      for (const wp of m.memWatchpoints) {
        if ((wp.mode === 'read' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          m.memWatchHit = { addr, value: val, dir: 'read' };
          break;
        }
      }
    }
    return val;
  };

  cpu.write8 = (addr: number, val: number): void => {
    addr &= 0xFFFF;
    memory.writeByte(addr, val);
    if (m.memWatchpoints.length > 0 && m.memWatchHit === null) {
      for (const wp of m.memWatchpoints) {
        if ((wp.mode === 'write' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          m.memWatchHit = { addr, value: val & 0xFF, dir: 'write' };
          break;
        }
      }
    }
  };

  cpu._contendAccurate = () => {};
  cpu.contend = () => {};
}

/** Wire CPU port-in/out to the ULA (keyboard + tape + buzzer). */
export function wireAcePortIO(m: JupiterAceMachine): void {
  const s = m;

  s.cpu.portOutHandler = (port: number, val: number): void => {
    if (s.portWatchpoints.size > 0 && s.portWatchpoints.has(port & 0xFFFF) && s.portWatchHit === null) {
      s.portWatchHit = { port: port & 0xFFFF, value: val & 0xFF, dir: 'out' };
    }

    // ULA port: any port with bit 0 = 0.
    if ((port & 0x01) === 0) {
      // The write sets the buzzer flip-flop; the level is the ULA's, not a
      // bit of the data byte (see AceUla).
      s.ula.writePort(val);
      if (s.ula.buzzerBit !== s.mixer.prevBeeperBit) {
        s.activity.beeperToggled = true;
        s.mixer.prevBeeperBit = s.ula.buzzerBit;
      }
    }
  };

  s.cpu.portInHandler = (port: number): number => {
    // Odd ports: nothing answers — open bus reads high.
    if ((port & 0x01) !== 0) return 0xFF;

    s.activity.ulaReads++;
    s.advanceTapeTo();
    if (s.ula.tapeActive) {
      // tapePolls counts every ULA read while the tape plays (any port);
      // earReads is the 0xFF subset (standard ROM loader polling).
      s.activity.tapePolls++;
      if ((port >> 8) === 0xFF) s.activity.earReads++;
    }
    if (s.tape.loaded && !s.tape.finished) {
      const playing = s.tape.playing && !s.tape.paused;
      // Auto play/stop: sniff the IN A,(0xFE) cadence to start/stop the tape.
      const event = s.loaderDetector.onULARead(s.cpu, playing);
      if (event === 'start') {
        s.tape.paused = false;
        if (!s.tape.playing) s.tape.startPlayback();
        s.activity.loaderDetected = true;
      } else if (event === 'stop') {
        s.tape.paused = true;
      }
    }
    const val = s.ula.readPort((port >> 8) & 0xFF);
    // The read cleared the buzzer flip-flop — the other half of the beep.
    if (s.ula.buzzerBit !== s.mixer.prevBeeperBit) {
      s.activity.beeperToggled = true;
      s.mixer.prevBeeperBit = s.ula.buzzerBit;
    }
    if (s.portWatchpoints.size > 0 && s.portWatchpoints.has(port & 0xFFFF) && s.portWatchHit === null) {
      s.portWatchHit = { port: port & 0xFFFF, value: val, dir: 'in' };
    }
    return val;
  };
}
