/**
 * Port I/O dispatch and memory hooks.
 *
 * Wires the Z80 CPU's port-in/port-out handlers and memory read/write hooks
 * to the appropriate Spectrum subsystems (ULA, AY, memory banking, FDC,
 * Kempston joystick, contention, and floating bus).
 */

import type { Spectrum } from '@/spectrum.ts';

/**
 * Override Z80 read8/write8 to apply per-access ULA contention and
 * silently discard writes to ROM (0x0000-0x3FFF).
 */
export function installMemoryHooks(s: Spectrum): void {
  const memory = s.memory;
  const contention = s.contention;
  const v = s.variant;
  const cpu = s.cpu;
  // Capture stable references once so the hot path is an array indexing
  // expression rather than a chain of property loads + method calls. Both
  // arrays' outer references are stable (the contents update on paging /
  // never, respectively), so capturing the reference is safe.
  const slots = memory.slots;
  const slotContended = contention.slotContended;

  cpu.read8 = (addr: number): number => {
    addr &= 0xFFFF;
    // Skip ULA contention when accurateTiming is off (UI turbo) — this is
    // the dominant per-instruction cost and the user has opted out of
    // cycle-exact behaviour by entering turbo. MCP and tests never set
    // turbo so they keep accurate timing.
    if (cpu.accurateTiming && slotContended[addr >>> 14] !== 0) {
      cpu.tStates += contention.contentionDelay(cpu.tStates);
    }
    const val = slots[addr >>> 14][addr & 0x3FFF];
    if (s.memWatchpoints.length > 0 && s.memWatchHit === null) {
      for (const wp of s.memWatchpoints) {
        if ((wp.mode === 'read' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          s.memWatchHit = { addr, value: val, dir: 'read' };
          break;
        }
      }
    }
    return val;
  };

  // Internal bus contention (no MREQ).
  cpu.contend = v.hasIOContention ? (addr: number): void => {
    if (cpu.accurateTiming && slotContended[addr >>> 14] !== 0) {
      cpu.tStates += contention.contentionDelay(cpu.tStates);
    }
  } : () => {};

  const vramFlushEnd = v.vramFlushEnd;

  cpu.write8 = (addr: number, val: number): void => {
    addr &= 0xFFFF;
    if (cpu.accurateTiming && slotContended[addr >>> 14] !== 0) {
      cpu.tStates += contention.contentionDelay(cpu.tStates);
    }
    if (addr < 0x4000) {
      if (s.multiface.pagedIn) {
        if (addr < 0x2000) return; // MF ROM — discard
        // 0x2000-0x3FFF: MF RAM — allow through
      } else if (s.vtx5000.enabled && s.vtx5000.vtxRomPaged && addr >= 0x2000) {
        // VTX-5000: 0x2000-0x3FFF is RAM — allow through
      } else if (!memory.specialPaging) {
        return; // Normal ROM — discard
      }
    }
    // 16K Spectrum: upper 32KB is unpopulated. Drop writes so the shared
    // open-bus buffer stays all-0xFF for reads.
    if (memory.is16K && addr >= 0x8000) return;
    if (addr >= 0x4000 && addr < vramFlushEnd) {
      s.flushBeam();
    }
    if (addr >= 0x5800 && addr < 0x5B00) s.activity.attrWrites++;
    slots[addr >>> 14][addr & 0x3FFF] = val & 0xFF;
    if (s.memWatchpoints.length > 0 && s.memWatchHit === null) {
      for (const wp of s.memWatchpoints) {
        if ((wp.mode === 'write' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          s.memWatchHit = { addr, value: val & 0xFF, dir: 'write' };
          break;
        }
      }
    }
  };

  cpu.portIn = (port: number): number => {
    if (cpu.accurateTiming) contention.applyIOContention(port, cpu);
    const val = cpu.portInHandler ? cpu.portInHandler(port) : 0xFF;
    if (s.tracing && s.traceMode !== 'full') s.logPortAccess('IN', port, val);
    return val;
  };

  cpu.portOut = (port: number, val: number): void => {
    if (cpu.accurateTiming) contention.applyIOContention(port, cpu);
    if (s.tracing && s.traceMode !== 'full') s.logPortAccess('OUT', port, val);
    if (cpu.portOutHandler) cpu.portOutHandler(port, val);
  };
}

export function wirePortIO(s: Spectrum): void {
  const v = s.variant;

  s.cpu.portOutHandler = (port: number, val: number) => {
    if (s.portWatchpoints.size > 0 && s.portWatchpoints.has(port & 0xFFFF) && s.portWatchHit === null) {
      s.portWatchHit = { port: port & 0xFFFF, value: val, dir: 'out' };
    }

    // ULA port: any port with bit 0 = 0
    if ((port & 0x01) === 0) {
      const newBeeperBit = (val >> 4) & 1;
      if (newBeeperBit !== s.mixer.prevBeeperBit) {
        s.activity.beeperToggled = true;
        s.mixer.prevBeeperBit = newBeeperBit;
      }
      s.flushBeam();
      s.ula.writePort(val);
    }

    // 128K bank switching: port 0x7FFD
    if (v.hasBanking) {
      if (v.decodes7FFD(port)) {
        s.memory.bankSwitch(val, s.hasSlot0Overlay);
      }

      // +2A: port 0x1FFD
      if (v.decodes1FFD(port)) {
        s.memory.bankSwitch1FFD(val, s.hasSlot0Overlay);
        if (v.hasFDC) s.fdc.motorOn = (val & 0x08) !== 0;
      }

      // FDC data write: port 0x3FFD
      if (v.decodesFDCData(port)) {
        s.fdc.writeData(val);
        s.activity.fdcAccesses++;
      }
    }

    // VTX-5000 8251 USART ports (active when VTX-5000 enabled)
    if (s.vtx5000.enabled) {
      const lo = port & 0xFF;
      if (lo === 0xFF) { s.vtx5000.writeControl(val); return; }
      if (lo === 0x7F) { s.vtx5000.writeData(val); return; }
    }

    // AMX mouse PIO control ports (active when AMX enabled, A7=0)
    if (s.amxMouse.enabled && (port & 0x80) === 0) {
      const lo = port & 0xE0;
      if (lo === 0x40) { s.amxMouse.pioControlWrite('A', val); }
      if (lo === 0x60) { s.amxMouse.pioControlWrite('B', val); }
    }

    // AY ports — 128K only
    if (v.hasAY) {
      if ((port & 0xC002) === 0xC000) {
        s.ay.selectedReg = val & 0x0F;
      }
      if ((port & 0xC002) === 0x8000) {
        s.ay.writeRegister(s.ay.selectedReg, val);
        s.activity.ayWrites++;
      }
    }
  };

  s.cpu.portInHandler = (port: number): number => {
    const val = dispatch(port);
    if (s.portWatchpoints.size > 0 && s.portWatchpoints.has(port & 0xFFFF) && s.portWatchHit === null) {
      s.portWatchHit = { port: port & 0xFFFF, value: val, dir: 'in' };
    }
    return val;
  };

  function dispatch(port: number): number {
    // ULA port: any port with bit 0 = 0
    if ((port & 0x01) === 0) {
      s.activity.ulaReads++;
      s.advanceTapeTo();
      if (s.ula.tapeActive && (port >> 8) === 0xFF) s.activity.earReads++;
      if (s.tape.loaded && !s.tape.finished) {
        const playing = s.tape.playing && !s.tape.paused;
        // EdgeLoader runs §2 auto play/stop then, if accel is on and the
        // tape is playing, §3 structural fingerprint + §4 acceleration.
        // Accel pops the loader's CALL return into PC, sets B/C/F to
        // plausible exit values, and advances the tape to the next edge
        // boundary in one step. See docs/edge-loading.md.
        const event = s.loaderDetector.onULARead(s.edgeLoaderHost, playing);
        if (event === 'start') {
          s.tape.paused = false;
          if (!s.tape.playing) s.tape.startPlayback();
          s.activity.loaderDetected = true;
        } else if (event === 'stop') {
          s.tape.paused = true;
        }
      }
      return s.ula.readPort((port >> 8) & 0xFF);
    }

    // AY register read: port 0xFFFD — 128K only
    if (v.hasAY && (port & 0xC002) === 0xC000) {
      return s.ay.readRegister(s.ay.selectedReg);
    }

    // FDC ports
    if (v.hasSpecialPaging) {
      if (v.decodesFDCStatus(port)) {
        if (!v.hasFDC) return 0xFF;
        return s.fdc.readStatus();
      }
      if (v.decodesFDCData(port)) {
        if (!v.hasFDC) return 0xFF;
        s.activity.fdcAccesses++;
        return s.fdc.readData();
      }
    }

    // AMX mouse PIO data ports (A7=0) and button port (0xDF)
    if (s.amxMouse.enabled) {
      if ((port & 0x80) === 0) {
        const lo = port & 0xE0;
        if (lo === 0x00) { s.activity.mouseReads++; return s.amxMouse.dirX & 1; }
        if (lo === 0x20) { s.activity.mouseReads++; return s.amxMouse.dirY & 1; }
      }
      if ((port & 0xFF) === 0xDF) {
        s.activity.mouseReads++;
        return s.amxMouse.buttons;
      }
    }

    // Kempston mouse: port low byte = 0xDF
    if (s.kempstonMouse.enabled && (port & 0xFF) === 0xDF) {
      const hi = (port >> 8) & 0xFF;
      if (hi === 0xFB) { s.activity.mouseReads++; return s.kempstonMouse.x & 0xFF; }
      if (hi === 0xFF) { s.activity.mouseReads++; return s.kempstonMouse.y & 0xFF; }
      if (hi === 0xFA) { s.activity.mouseReads++; return s.kempstonMouse.buttons; }
    }

    // MF3 port latches
    if (s.multiface.enabled && s.multiface.variant === 'MF3'
        && (port & 0xFF) === 0x3F) {
      const hi = (port >> 8) & 0xFF;
      if (hi === 0x7F) return s.memory.port7FFD;
      if (hi === 0x1F) return s.memory.port1FFD;
    }

    // Multiface port handling (IN-triggered paging)
    if (s.multiface.enabled && s.multiface.romLoaded) {
      const mfPort = s.multiface.matchPort(port);
      if (mfPort === 'in' && !s.multiface.pagedIn) {
        s.multiface.pageIn(s.memory, s.memory.slot0Bank);
        return 0xFF;
      }
      if (mfPort === 'out' && s.multiface.pagedIn) {
        s.multiface.pageOut(s.memory);
        if (s.multiface.variant === 'MF1') return s.joystick.state;
        return 0xFF;
      }
    }

    // VTX-5000 8251 USART ports
    if (s.vtx5000.enabled) {
      const lo = port & 0xFF;
      if (lo === 0xFF) return s.vtx5000.readStatus();
      if (lo === 0x7F) return s.vtx5000.readData();
    }

    // Kempston joystick: bits 5-7 of low byte all zero
    if ((port & 0x00E0) === 0) {
      s.activity.kempstonReads++;
      return s.joystick.state;
    }

    // Unattached port — return floating bus value
    return s.contention.floatingBusRead(s.cpu.tStates, s.memory.screenBank);
  }
}
