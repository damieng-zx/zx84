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
  // Capture stable references once so the hot path is a single array
  // index rather than property-chain dereferencing every read. `flat` is
  // the live 64KB view (its identity never changes — only its contents
  // do, mutated by bankSwitch). slotContended and slotAlias are also stable.
  const flat = memory.flat;
  const slotContended = contention.slotContended;
  const slotAlias = memory.slotAlias;

  cpu.read8 = (addr: number): number => {
    addr &= 0xFFFF;
    if (cpu.accurateTiming && slotContended[addr >>> 14] !== 0) {
      cpu.tStates += contention.contentionDelay(cpu.tStates);
    }
    const val = flat[addr];
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
  // Build the cycle-exact impl once and stash on cpu so turbo can swap
  // `cpu.contend` between this and a true no-op (see frameLoop turbo enter/exit).
  // No accurateTiming check inside — the swap means we never call the accurate
  // impl when turbo is on, and Firefox can then inline the no-op away at every
  // bare `this.contend(addr)` site across exec-main/ed/index/cb.
  cpu._contendAccurate = v.hasIOContention ? (addr: number): void => {
    if (slotContended[addr >>> 14] !== 0) {
      cpu.tStates += contention.contentionDelay(cpu.tStates);
    }
  } : () => {};
  cpu.contend = cpu._contendAccurate;

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
      } else if (s.mgtPlusD.pagedIn) {
        if (addr < 0x2000) return; // +D shadow ROM — discard
        // 0x2000-0x3FFF: +D RAM — allow through
      } else if (s.interface1.pagedIn) {
        return; // IF1 ROM (0x0000-0x1FFF) + Spectrum ROM upper half — all ROM
      } else if (s.betaDisk.pagedIn) {
        return; // TR-DOS ROM (0x0000-0x3FFF) — all ROM, discard writes
      } else if (s.interface2.inserted) {
        return; // IF2 cartridge ROM (0x0000-0x3FFF) — all ROM, no /WR line at the cart slot
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
    const v = val & 0xFF;
    flat[addr] = v;
    // Bank aliasing write-through: when two slots map the same RAM bank
    // (e.g. currentBank=5 maps bank 5 to slot 1 and slot 3), real hardware
    // sees both windows as the same physical chip — writes through one
    // must appear at the other. slotAlias[slot] is the mirror slot index,
    // or -1 in the common case (no aliasing — branch predicts cheaply).
    const alias = slotAlias[addr >>> 14];
    if (alias >= 0) flat[(alias << 14) | (addr & 0x3FFF)] = v;
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
    // The core invokes portIn 3T into the IORQ cycle (the late sample point);
    // contention probes must anchor at the cycle START, hence offset 3.
    if (cpu.accurateTiming) contention.applyIOContention(port, cpu, 3);
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

    // MGT +D ports (page out, WD1772 registers, control register). Handled
    // first and returned so a +D OUT can't also trip banking/AY decoding.
    if (s.mgtPlusD.enabled && s.mgtPlusD.matchPort(port)) {
      s.mgtPlusD.writePort(port, val, s.memory);
      return;
    }

    // ZX Interface 1 microdrive/control ports (0xE7/0xEF/0xF7). Handled and
    // returned like the +D — shares 0xE7/0xEF with it but never both enabled.
    if (s.interface1.enabled && s.interface1.matchPort(port)) {
      s.interface1.writePort(port, val);
      return;
    }

    // Beta Disk (TR-DOS) ports (0x1F/0x3F/0x5F/0x7F/0xFF, active only while the
    // TR-DOS ROM is paged in). Handled first and returned so a Beta OUT can't
    // also trip ULA / banking / AY decoding.
    if (s.betaDisk.enabled && s.betaDisk.matchPort(port)) {
      s.betaDisk.writePort(port, val);
      return;
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
    // MGT +D ports (page in, WD1772 registers) take priority.
    if (s.mgtPlusD.enabled && s.mgtPlusD.matchPort(port)) {
      return s.mgtPlusD.readPort(port, s.memory);
    }

    // ZX Interface 1 microdrive data / status ports.
    if (s.interface1.enabled && s.interface1.matchPort(port)) {
      return s.interface1.readPort(port);
    }

    // Beta Disk (TR-DOS) ports — active only while the TR-DOS ROM is paged in.
    if (s.betaDisk.enabled && s.betaDisk.matchPort(port)) {
      return s.betaDisk.readPort(port);
    }

    // ULA port: any port with bit 0 = 0
    if ((port & 0x01) === 0) {
      s.activity.ulaReads++;
      s.advanceTapeTo();
      if (s.ula.tapeActive) {
        // tapePolls counts every ULA read while the tape plays (any port);
        // earReads is the 0xFF subset (standard ROM loader). Custom loaders
        // poll non-0xFF ports, so tapePolls is what engages turbo for them.
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

    // MF3 port latches — only live once the button's NMI has armed the interface.
    if (s.multiface.enabled && s.multiface.variant === 'MF3' && s.multiface.armed
        && (port & 0xFF) === 0x3F) {
      const hi = (port >> 8) & 0xFF;
      if (hi === 0x7F) return s.memory.port7FFD;
      if (hi === 0x1F) return s.memory.port1FFD;
    }

    // Multiface port handling (IN-triggered paging). MF1's narrower decode is
    // always live; MF128/MF3 are invisible until the button arms them.
    if (s.multiface.enabled && s.multiface.romLoaded
        && (s.multiface.variant === 'MF1' || s.multiface.armed)) {
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

    // Unattached port — Ferranti ULA models float the bus to whatever the
    // ULA is fetching; the Amstrad gate array (+2A/+3) drives it to 0xFF.
    if (!v.hasFloatingBus) return 0xFF;
    return s.contention.floatingBusRead(s.cpu.tStates, s.memory.screenBank);
  }
}
