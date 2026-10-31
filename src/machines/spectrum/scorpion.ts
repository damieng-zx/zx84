/**
 * Scorpion ZS-256 board logic that sits around the CPU rather than in the
 * memory map: the "even M1" wait, the Turbo+ 7 MHz clock, the #FF attribute
 * port and the Magic button.
 *
 * Installed only on a Scorpion, at construction: it replaces that machine's
 * `cpu.step` and `cpu.interrupt` with wrappers, so the other Spectrum models keep
 * the core's own methods and pay nothing per instruction.
 *
 *  - Even M1. The Scorpion shares its RAM between the CPU and the video
 *    circuit and lines opcode fetches up with that cycle: an M1 fetch from RAM
 *    that would start on an odd T-state (counted from the frame interrupt)
 *    waits one extra T-state. Fetches from ROM are not delayed. Only the first
 *    M1 of an instruction needs the check: with no other waits on this board
 *    every later M1 (a CB/DD/ED/FD prefix's second fetch) starts 4 T-states
 *    after it, on the same parity.
 *  - Turbo (ZS-256 Turbo+). An IN from the 7FFD address switches the CPU to
 *    7 MHz and an IN from 1FFD back to 3.5 MHz (ZX Format #2, "Turbo/normal
 *    switch for the Scorpion ZS-256 Turbo+"); reset returns to 3.5 MHz. The
 *    video, interrupt and AY timing keep their 3.5 MHz rates, so each
 *    instruction (and interrupt acknowledge) is charged half its T-states
 *    against the frame, an odd half-T-state carried to the next. The even M1
 *    wait is not applied at 7 MHz: its timing there is not documented.
 *  - #FF. Ports decoded as xxxxxxxx xx1xx111 (A0, A1, A2, A5 high) read the
 *    attribute byte the video circuit is fetching, 0xFF in the border and
 *    retrace (published Scorpion port map). The fetch phase within a character
 *    cell is not documented; the attribute of the cell under the beam is
 *    returned.
 *  - Magic. The button latches an NMI request that is taken at the next opcode
 *    fetch from 0x4000 or above. It raises the DOS signal like the TR-DOS trap,
 *    so the ROM at 0x0000 becomes the DOS half of the current pair: the service
 *    monitor (page 2) behind the 128K ROM, TR-DOS (page 3) behind 48K BASIC
 *    (1FFD D1 forces page 2 in either case). The monitor's NMI entry is at
 *    0x0066 of page 2. DOS drops on the next fetch at 0x4000 or above.
 */

import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { DISPLAY_HEIGHT, vramAttrAddr } from '@/machines/spectrum/ula.ts';

/** Display T-states per line before the right border (32 cells × 4 T). */
const DISPLAY_LINE_T = 128;

export class ScorpionBoard {
  /** Magic pressed; the NMI waits for an opcode fetch at 0x4000 or above. */
  nmiPending = false;
  /** Half T-state left over from the last 7 MHz instruction (0 or 1). */
  private halfT = 0;

  constructor(private readonly s: Spectrum) {
    const cpu = s.cpu;
    const memory = s.memory;
    const contention = s.contention;
    const baseStep = cpu.step.bind(cpu);
    const baseInterrupt = cpu.interrupt.bind(cpu);

    cpu.step = (): void => {
      // The NMI acknowledge is a step of its own; the handler's first opcode
      // is fetched by the next one.
      if (this.nmiPending && cpu.pc >= 0x4000) { this.takeNmi(); return; }
      if (memory.cpuTurbo) {
        const t0 = cpu.tStates;
        baseStep();
        this.halve(t0);
        return;
      }
      // Even M1: a fetch from RAM starting on an odd T-state waits one.
      if (((cpu.tStates - contention.frameStartTStates) & 1) !== 0
          && (cpu.pc >= 0x4000 || memory.slot0Bank >= 0)) {
        cpu.tStates += 1;
      }
      baseStep();
    };

    cpu.interrupt = (): number => {
      if (!memory.cpuTurbo) return baseInterrupt();
      const t0 = cpu.tStates;
      const taken = baseInterrupt();
      if (taken > 0) this.halve(t0);
      return taken;
    };
  }

  reset(): void {
    this.nmiPending = false;
    this.halfT = 0;
  }

  /** Charge the T-states since `t0` at 7 MHz: half of them, carrying any odd
   *  half T-state into the next instruction. */
  private halve(t0: number): void {
    const cpu = this.s.cpu;
    const total = cpu.tStates - t0 + this.halfT;
    cpu.tStates = t0 + (total >> 1);
    this.halfT = total & 1;
  }

  /** The Magic button: latch the NMI request (see the file comment). */
  pressMagic(): void {
    this.nmiPending = true;
  }

  private takeNmi(): void {
    const s = this.s;
    const memory = s.memory;
    this.nmiPending = false;
    const servicePage = (memory.port1FFD & 0x02) !== 0 || (memory.port7FFD & 0x10) === 0;
    const image = servicePage ? memory.romPages[2] : s.betaDisk.rom;
    s.betaDisk.pageInImage(memory, image);
    const t0 = s.cpu.tStates;
    s.cpu.nmi();
    if (memory.cpuTurbo) this.halve(t0);
  }

  /** An IN that nothing earlier in the port chain claimed. */
  readPort(port: number): number {
    const s = this.s;
    const v = s.variant;
    if (v.decodes7FFD(port)) { s.memory.cpuTurbo = true; return 0xFF; }
    if (v.decodes1FFD(port)) { s.memory.cpuTurbo = false; this.halfT = 0; return 0xFF; }
    if ((port & 0x27) === 0x27) return this.attributeAt(s.cpu.tStates);
    return 0xFF;
  }

  /** The attribute byte under the beam at `cpuTStates`, or 0xFF outside the
   *  192 × 256 display. */
  attributeAt(cpuTStates: number): number {
    const s = this.s;
    const t = s.contention.timing;
    const offset = cpuTStates - s.contention.frameStartTStates - t.displayOrigin;
    if (offset < 0) return 0xFF;
    const line = (offset / t.tStatesPerLine) | 0;
    if (line >= DISPLAY_HEIGHT) return 0xFF;
    const x = offset - line * t.tStatesPerLine;
    if (x >= DISPLAY_LINE_T) return 0xFF;
    return s.memory.screenBank[vramAttrAddr(line, x >> 2) - 0x4000];
  }
}
