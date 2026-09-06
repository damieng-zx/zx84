/**
 * SamMachine — headless bring-up.
 *
 * Phase 1 asserts the machine driver, the port decode and the interrupt
 * timing, all without a ROM: a small program is poked straight into RAM and
 * executed. Expectations come from the SAM's documented port map and its
 * 384 T-state / 312-line PAL field, hand-computed.
 */

import { describe, expect, it } from 'vitest';
import { SamMachine } from '@/machines/sam/sam-machine.ts';
import {
  SAM_FRAME_INT_LINE, SAM_LINES_PER_FRAME, SAM_T_PER_FRAME, SAM_T_PER_LINE,
  STATUS_IDLE, STATUS_INT_FRAME,
} from '@/machines/sam/constants.ts';
import type { SamModel } from '@/machines/sam/models.ts';

function machine(model: SamModel = 'sam512'): SamMachine {
  const m = new SamMachine(model, null);
  // Page RAM over section A so a test program can be written at 0x0000, and
  // give the CPU a stack well away from it.
  m.memory.setLmpr(0x20);
  m.cpu.sp = 0x7FF0;
  return m;
}

/** Poke bytes into the currently-paged address space. */
function poke(m: SamMachine, addr: number, ...bytes: number[]): void {
  bytes.forEach((b, i) => m.memory.writeByte(addr + i, b));
}

describe('SamMachine driver', () => {
  it('reports the SAM Coupé clock and field length', () => {
    const m = machine();
    expect(m.cpuClockHz).toBe(6_000_000);
    // 48 cells x 8 T x 312 lines.
    expect(m.tStatesPerFrame).toBe(119_808);
    expect(SAM_T_PER_LINE * SAM_LINES_PER_FRAME).toBe(SAM_T_PER_FRAME);
    // ...which is 50.08 Hz, the real SAM's field rate.
    expect(m.cpuClockHz / m.tStatesPerFrame).toBeCloseTo(50.08, 2);
    m.destroy();
  });

  it('starts headless without touching AudioContext or rAF', async () => {
    expect(typeof AudioContext).toBe('undefined');
    expect(typeof requestAnimationFrame).toBe('undefined');

    const m = machine();
    await m.start();
    expect((m as unknown as { running: boolean }).running).toBe(true);
    m.stop();
    expect((m as unknown as { running: boolean }).running).toBe(false);
    m.destroy();
  });

  it('executes a frame of real instructions', () => {
    const m = machine();
    poke(m, 0x0000, 0x00);        // NOP at 0x0000, then RAM full of NOPs
    m.cpu.pc = 0x0000;
    const before = m.cpu.tStates;
    m.tick();
    // A whole field must have been consumed, give or take the final
    // instruction overrunning its scanline budget.
    expect(m.cpu.tStates - before).toBeGreaterThanOrEqual(SAM_T_PER_FRAME);
    expect(m.cpu.tStates - before).toBeLessThan(SAM_T_PER_FRAME + 32);
    m.destroy();
  });

  it('stops early on a breakpoint', () => {
    const m = machine();
    poke(m, 0x0000, 0x00, 0x00, 0x00, 0x00);
    m.cpu.pc = 0x0000;
    m.breakpoints.add(0x0002);
    m.runUntil(1);
    expect(m.breakpointHit).toBe(0x0002);
    expect(m.cpu.pc).toBe(0x0002);
    m.destroy();
  });
});

describe('SamMachine port decode', () => {
  it('routes OUT to the three paging registers', () => {
    const m = machine();
    m.cpu.portOut!(0x00FA, 0x25);
    m.cpu.portOut!(0x00FB, 0x07);
    m.cpu.portOut!(0x00FC, 0x43);
    expect(m.memory.lmpr).toBe(0x25);
    expect(m.memory.hmpr).toBe(0x07);
    expect(m.memory.vmpr).toBe(0x43);
    // ...and the paging actually took effect: LMPR page 5, so section B page 6.
    m.memory.getRamBank(6)[0] = 0x9E;
    expect(m.memory.readByte(0x4000)).toBe(0x9E);
    m.destroy();
  });

  it('reads the paging registers back', () => {
    const m = machine();
    m.cpu.portOut!(0x00FA, 0x25);
    expect(m.cpu.portIn!(0x00FA)).toBe(0x25);
    m.cpu.portOut!(0x00FB, 0x25);
    expect(m.cpu.portIn!(0x00FB)).toBe(0x25);
    m.destroy();
  });

  /**
   * VMPR's bit 7 is not part of the register: on a read it is the
   * MIDI-receive status, and with no MIDI input it is always set.
   *
   * SAMPaint's boot program is why this has its own test. It checks the
   * machine with `IF IN 252<>254 THEN CALL 0` straight after `SCREEN 1:
   * MODE 4` — so returning the written 0x7E made the program reset the
   * computer the instant it finished loading, which reads as a crash.
   */
  it('reads VMPR back with the MIDI-receive bit set', () => {
    const m = machine();
    m.cpu.portOut!(0x00FC, 0x7E);       // mode 4, screen page 30
    expect(m.memory.vmpr).toBe(0x7E);   // the register itself is unchanged
    expect(m.cpu.portIn!(0x00FC)).toBe(0xFE);
    m.cpu.portOut!(0x00FC, 0x00);
    expect(m.cpu.portIn!(0x00FC)).toBe(0x80);
    m.destroy();
  });

  /**
   * BEEP means the speaker moved, not that port 0xFE was written. That port is
   * the border, the beeper and the cassette MIC line at once, and the ROM
   * writes it on every auto-repeat of a held key (value 0x08 — MIC only, the
   * beeper bit untouched), which lit the indicator for a keypress that makes
   * no sound at all.
   */
  it('counts beeper toggles, not writes to the port they share', () => {
    const m = machine();
    m.cpu.portOut!(0x00FE, 0x08);          // MIC on, beeper untouched
    m.cpu.portOut!(0x00FE, 0x00);          // MIC off, beeper still untouched
    expect(m.activity.beeperToggles).toBe(0);

    m.cpu.portOut!(0x00FE, 0x10);          // beeper high
    expect(m.activity.beeperToggles).toBe(1);
    m.cpu.portOut!(0x00FE, 0x18);          // still high, MIC added
    expect(m.activity.beeperToggles).toBe(1);
    m.cpu.portOut!(0x00FE, 0x08);          // beeper low again
    expect(m.activity.beeperToggles).toBe(2);
    m.destroy();
  });

  it('takes the CLUT index from the port HIGH byte, not an index register', () => {
    // OUT (&03F8), A writes palette entry 3. This is the single easiest thing
    // to implement backwards, hence its own test.
    const m = machine();
    m.cpu.portOut!(0x03F8, 0x7F);
    expect(m.asic.clut[3]).toBe(0x7F);
    expect(m.asic.clut[0]).toBe(0x00);

    m.cpu.portOut!(0x0FF8, 0x2A);
    expect(m.asic.clut[15]).toBe(0x2A);
    m.destroy();
  });

  it('masks CLUT values to 7 bits', () => {
    const m = machine();
    m.cpu.portOut!(0x00F8, 0xFF);
    expect(m.asic.clut[0]).toBe(0x7F);
    m.destroy();
  });

  it('unpacks the border colour from bits 0-2 and bit 5 of port 0xFE', () => {
    // BORDER_COLOUR_MASK is 0x27: bit 5 supplies the top bit of a 4-bit index.
    const m = machine();
    m.cpu.portOut!(0x00FE, 0x05);         // index 5
    expect(m.asic.borderIndex).toBe(5);

    m.cpu.portOut!(0x00FE, 0x20 | 0x05);  // bit 5 set → index 13
    expect(m.asic.borderIndex).toBe(13);

    m.cpu.portOut!(0x00FE, 0x20);         // bit 5 only → index 8
    expect(m.asic.borderIndex).toBe(8);
    m.destroy();
  });

  it('latches the beeper, MIC and screen-off bits from port 0xFE', () => {
    const m = machine();
    m.cpu.portOut!(0x00FE, 0x10);   // BEEP
    expect(m.beeperBit).toBe(1);
    expect(m.micBit).toBe(0);
    expect(m.screenOff).toBe(false);

    m.cpu.portOut!(0x00FE, 0x08);   // MIC
    expect(m.beeperBit).toBe(0);
    expect(m.micBit).toBe(1);

    m.cpu.portOut!(0x00FE, 0x80);   // SOFF
    expect(m.screenOff).toBe(true);
    m.destroy();
  });

  it('reflects the screen-off latch back through an IN 0xFE', () => {
    const m = machine();
    m.cpu.portOut!(0x00FE, 0x80);
    expect(m.cpu.portIn!(0xFFFE) & 0x80).toBe(0x80);
    m.cpu.portOut!(0x00FE, 0x00);
    expect(m.cpu.portIn!(0xFFFE) & 0x80).toBe(0x00);
    m.destroy();
  });

  it('routes the external page registers to LEPR/HEPR', () => {
    const m = machine();
    m.cpu.portOut!(0x0080, 0x11);
    m.cpu.portOut!(0x0081, 0x22);
    expect(m.memory.lepr).toBe(0x11);
    expect(m.memory.hepr).toBe(0x22);
    m.destroy();
  });

  it('returns open bus from ports with nothing fitted', () => {
    const m = machine();
    // MIDI (0xFD) is decoded but unimplemented; 0x55 has no device at all.
    expect(m.cpu.portIn!(0x00FD)).toBe(0xFF);
    expect(m.cpu.portIn!(0x0055)).toBe(0xFF);
    m.destroy();
  });
});

describe('SamMachine interrupts', () => {
  it('reports nothing pending after reset, with active-low status bits', () => {
    const m = machine();
    m.reset();
    expect(m.asic.status).toBe(STATUS_IDLE);
    expect(m.intPending).toBe(false);
    // All five interrupt bits read high through port 0xF9.
    expect(m.cpu.portIn!(0x00F9) & 0x1F).toBe(0x1F);
    m.destroy();
  });

  it('raises the frame interrupt on the first line after the display', () => {
    // The display occupies raster lines 48..239, so /INT must go low at the
    // start of line 240 — i.e. 240 x 384 = 92,160 T-states into the field.
    const m = machine();
    poke(m, 0x0000, 0x00);
    m.cpu.pc = 0x0000;
    m.cpu.iff1 = false;      // keep the CPU from consuming the interrupt

    const frameStart = m.cpu.tStates;
    let raisedAt = -1;
    m.onTrap = () => {
      if (raisedAt < 0 && (m.asic.status & STATUS_INT_FRAME) === 0) {
        raisedAt = m.cpu.tStates - frameStart;
      }
      return false;
    };
    m.tick();

    expect(raisedAt).toBeGreaterThanOrEqual(SAM_FRAME_INT_LINE * SAM_T_PER_LINE);
    // Observed on the next instruction boundary, so within one NOP of the line.
    expect(raisedAt).toBeLessThan(SAM_FRAME_INT_LINE * SAM_T_PER_LINE + 32);
    m.destroy();
  });

  it('releases /INT after its hold time, so a masked interrupt is lost', () => {
    // The ASIC drops the line on a timer rather than waiting for an ack, so a
    // CPU that never enables interrupts sees the status return to idle.
    const m = machine();
    poke(m, 0x0000, 0x00);
    m.cpu.pc = 0x0000;
    m.cpu.iff1 = false;

    let sawPending = false;
    m.onTrap = () => {
      if (m.intPending) sawPending = true;
      return false;
    };
    m.tick();

    expect(sawPending).toBe(true);
    expect(m.asic.status).toBe(STATUS_IDLE);   // released again by end of field
    m.destroy();
  });

  it('raises the frame interrupt once in every field', () => {
    const m = machine();
    poke(m, 0x0000, 0x00);
    m.cpu.pc = 0x0000;
    m.cpu.iff1 = false;

    for (let field = 0; field < 3; field++) {
      let raises = 0;
      let wasPending = m.intPending;
      m.onTrap = () => {
        if (m.intPending && !wasPending) raises++;
        wasPending = m.intPending;
        return false;
      };
      m.tick();
      expect(raises).toBe(1);
    }
    m.destroy();
  });

  it('clears a pending line interrupt when the LINE register is rewritten', () => {
    // Writing port 0xF9 programs the scanline AND cancels a pending line
    // interrupt on real hardware.
    const m = machine();
    m.asic.status &= ~0x01;                // pretend a line interrupt is pending
    expect(m.intPending).toBe(true);

    m.cpu.portOut!(0x00F9, 100);
    expect(m.asic.lineReg).toBe(100);
    expect(m.asic.status & 0x01).toBe(0x01);
    m.destroy();
  });

  it('services the frame interrupt through IM 1 (RST 38h)', () => {
    const m = machine();
    // HALT at 0x0000; the interrupt should wake it into 0x0038.
    poke(m, 0x0000, 0x76);
    m.cpu.pc = 0x0000;
    m.cpu.iff1 = true;
    m.cpu.im = 1;

    m.tick();
    expect(m.cpu.im).toBe(1);
    // The handler at 0x0038 is a RAM full of NOPs, so the PC has run on past
    // it — what matters is that control left the HALT.
    expect(m.cpu.pc).not.toBe(0x0000);
    m.destroy();
  });
});

describe('SamMachine activity counters', () => {
  it('does not count a keyboard scan as a tape read', () => {
    // Port 0xFE is the keyboard as well as the EAR line, and the ROM scans the
    // matrix every frame. Counting those left the EAR LED — and the TEXT LED,
    // which shares its latch — lit from boot to power-off.
    const m = machine();
    m.activity.tapeReads = 0;
    for (let row = 0; row < 8; row++) m.cpu.portIn!(((~(1 << row)) & 0xFF) << 8 | 0xFE);
    expect(m.activity.tapeReads).toBe(0);
    m.destroy();
  });
});

describe('SamMachine library auto-boot', () => {
  /** F9 lives at row 2 bit 7, and only port 0xF9 can see it. */
  const bootKeyDown = (m: SamMachine) =>
    (m.keyboard.readHigh((~(1 << 2)) & 0xFF) & (1 << 7)) === 0;

  it('holds the boot key down when armed', () => {
    // The SAM has no key-wait to trap: it runs a RAM test for seconds after
    // reset while scanning the keyboard, so the key is simply held until the
    // ROM takes it.
    const m = machine();
    expect(bootKeyDown(m)).toBe(false);
    m.armBootTrap('disk');
    expect(bootKeyDown(m)).toBe(true);
    m.destroy();
  });

  it('drops the boot key on reset, so it cannot survive into a game', () => {
    const m = machine();
    m.armBootTrap('disk');
    m.reset();
    expect(bootKeyDown(m)).toBe(false);
    m.destroy();
  });
});

describe('SamMachine memory regions and exports', () => {
  it('resolves the two ROM halves to their CPU addresses', () => {
    const m = machine();
    const rom = new Uint8Array(32768);
    rom.fill(0xA0, 0, 16384);
    rom.fill(0xB1, 16384);
    m.loadROM(rom);

    const r0 = m.resolveMemoryRegion('sam-rom0');
    const r1 = m.resolveMemoryRegion('sam-rom1');
    expect(r0).not.toBeNull();
    expect(r0!.baseAddr).toBe(0x0000);
    expect(r0!.data[0]).toBe(0xA0);
    expect(r1!.baseAddr).toBe(0xC000);
    expect(r1!.data[0]).toBe(0xB1);
    expect(m.resolveMemoryRegion('nope')).toBeNull();
    m.destroy();
  });

  it('sizes the RAM export by the fitted memory', () => {
    for (const [model, kb] of [['sam256', 256], ['sam512', 512]] as const) {
      const m = machine(model);
      const e = m.ramExportBytes();
      expect(e.data.length).toBe(kb * 1024);
      expect(e.filename).toBe(`ram-${kb}k.bin`);
      m.destroy();
    }
  });

  it('exports the 24K display page pair as the screen dump', () => {
    const m = machine();
    m.memory.setVmpr(0x40 | 5);        // mode 3 → base page 4, pair 4/5
    m.memory.getRamBank(4)[0] = 0x11;
    m.memory.getRamBank(5)[0] = 0x22;

    const scr = m.screenExportBytes();
    expect(scr.length).toBe(0x8000);
    expect(scr[0]).toBe(0x11);
    expect(scr[0x4000]).toBe(0x22);
    m.destroy();
  });
});

describe('SamMachine services', () => {
  it('exposes a Z80 debug service and hides unfitted hardware', () => {
    const m = machine();
    expect(m.services.debug.cpuFamily).toBe('z80');
    expect(m.services.debug.ports).not.toBeNull();
    expect(m.services.roms.cartridge).toBeNull();
    // Every device is fitted: two internal drives, a cassette deck, and a
    // snapshot service that backs refresh-resume.
    expect(m.services.disks.drives).toHaveLength(2);
    expect(m.services.tape).not.toBeNull();
    expect(m.services.snapshots).not.toBeNull();
    // ...but offers no interchange format, so the Save menu stays snapshot-free.
    expect(m.services.snapshots.formats()).toEqual([]);
    expect(m.services.snapshots.saveSync).toBeTypeOf('function');
    m.destroy();
  });

  it('reports the paging state through the memory-layout pane', () => {
    const m = machine();
    m.memory.setLmpr(0x20 | 4);        // RAM page 4 in section A, 5 in B
    m.memory.setHmpr(9);               // page 9 in C, 10 in D

    const map = m.services.probe.panes!.memoryMap!()!;
    expect(map.slots.map(s => s.read)).toEqual(
      ['RAM 10', 'RAM 9', 'RAM 5', 'RAM 4'],   // high to low
    );
    expect(map.registers.find(r => r.name === 'LMPR')!.value).toBe('24');
    m.destroy();
  });

  it('marks a write-protected section as protected in the layout pane', () => {
    const m = machine();
    m.memory.setLmpr(0x20 | 0x80);     // RAM in section A, write-protected
    const map = m.services.probe.panes!.memoryMap!()!;
    expect(map.slots[3].write).toBe('(protected)');   // 0000-3FFF row
    expect(map.slots[2].write).toBe('(protected)');   // 4000-7FFF row
    m.destroy();
  });
});

describe('SamMachine SAA1099 wiring', () => {
  /** Peak-to-peak swing of the machine's PSG over `n` samples. */
  function swing(m: SamMachine, n = 3000): { left: number; right: number } {
    let lo = Infinity, hi = -Infinity, rlo = Infinity, rhi = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = m.psg.generateSampleStereo();
      if (o.left < lo) lo = o.left;
      if (o.left > hi) hi = o.left;
      if (o.right < rlo) rlo = o.right;
      if (o.right > rhi) rhi = o.right;
    }
    return { left: hi - lo, right: rhi - rlo };
  }

  /** Write a SAA register the way the SAM does: address on 0x01FF, data on 0x00FF. */
  function saa(m: SamMachine, reg: number, value: number): void {
    m.cpu.portOut!(0x01FF, reg);
    m.cpu.portOut!(0x00FF, value);
  }

  it('splits the SAA address and data registers on A8, not the low byte', () => {
    // Both ports share low byte 0xFF; only A8 tells them apart. Getting this
    // backwards would make every register write land in register 0.
    const m = machine();
    saa(m, 0x08, 100);          // channel 0 frequency
    saa(m, 0x10, 4);            // channel 0 octave 4
    expect(m.psg.channelFrequency(0)).toBeCloseTo(15625 * 16 / (511 - 100), 4);
    m.destroy();
  });

  it('plays a tone driven entirely through the port decode', () => {
    const m = machine();
    saa(m, 0x1C, 0x01);         // sound enable
    saa(m, 0x08, 100);          // frequency
    saa(m, 0x10, 0x04);         // octave 4
    saa(m, 0x00, 0x0F);         // hard left, full amplitude
    saa(m, 0x14, 0x01);         // tone enable, channel 0

    const sw = swing(m);
    expect(sw.left).toBeGreaterThan(0);
    expect(sw.right).toBeCloseTo(0, 6);
    m.destroy();
  });

  it('counts PSG writes for the activity LED', () => {
    const m = machine();
    const before = m.activity.psgWrites;
    saa(m, 0x1C, 0x01);
    expect(m.activity.psgWrites).toBe(before + 2);
    m.destroy();
  });

  it('silences the chip on reset', () => {
    const m = machine();
    saa(m, 0x1C, 0x01);
    saa(m, 0x08, 100);
    saa(m, 0x00, 0x0F);
    saa(m, 0x14, 0x01);
    expect(swing(m).left).toBeGreaterThan(0);

    m.reset();
    expect(swing(m).left).toBeCloseTo(0, 6);
    m.destroy();
  });
});
