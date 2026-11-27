/**
 * The AY-3-8912 as the Oric wires it.
 *
 * The PSG is not on the bus. Its data lines share VIA port A (which is also the
 * printer port), and it is selected by the two handshake lines the VIA drives
 * from its peripheral control register:
 *
 *   BDIR (CB2)  BC1 (CA2)   effect
 *       0          0        not selected
 *       0          1        read the latched register onto port A
 *       1          0        write port A into the latched register
 *       1          1        latch port A as the register index
 *
 * So fetching a register is three VIA operations — PCR, PCR, read port A — and
 * writing one is PCR, write port A, PCR. The PCR's CA2/CB2 modes 6 and 7 hold
 * an output level, which is how the ROM picks a BDIR/BC1 state; a mode 7 write
 * is one of the transitions the PSG acts on.
 *
 * The PSG's own register 14 is an 8-bit I/O port, and on the Oric it drives the
 * keyboard columns (negative logic: one bit clear selects a column). Its
 * register 7 bit 6 makes that port an input, which is how the keyboard is read.
 */

import { AY3891x } from '@/cores/ay-3-8910.ts';
import type { M6522 } from '@/cores/m6522.ts';
import { ORIC_PSG_CLOCK, ORIC_PSG_MIXER, ORIC_PSG_PORT_A, ORIC_PSG_PORT_A_INPUT } from './constants.ts';

/** PCR mode 7 holds the handshake line high; mode 6 holds it low. */
const MANUAL_HIGH = 7;

export class OricPsg {
  readonly ay: AY3891x;

  /** Keyboard column mask last written to the PSG's port A (negative logic).
   *  Idle is $FF: no column selected, so the sense line stays high. */
  columns = 0xFF;

  /** The BC1/BDIR levels the last PCR write left on the pins, so a level that
   *  did not move is not a bus transition. */
  private bc1 = false;
  private bdir = false;

  /** The last port A value the 6502 drove (used during a write cycle). */
  private portA = 0xFF;

  constructor() {
    // Mono: the three channels are wired together into the one speaker.
    this.ay = new AY3891x(ORIC_PSG_CLOCK, 48000, 'MONO');
  }

  /** CA2 (BC1) and CB2 (BDIR) as the PCR's manual output modes hold them. */
  private levels(pcr: number): { bc1: boolean; bdir: boolean } {
    return {
      bc1: ((pcr >> 1) & 0x07) === MANUAL_HIGH,
      bdir: ((pcr >> 5) & 0x07) === MANUAL_HIGH,
    };
  }

  /** A PCR write moved (or left) the select lines; act if they changed. */
  onPcrWrite(via: M6522, pcr: number): void {
    const { bc1, bdir } = this.levels(pcr);
    const changed = bc1 !== this.bc1 || bdir !== this.bdir;
    this.bc1 = bc1;
    this.bdir = bdir;
    if (!changed) return;

    if (bdir && bc1) {
      // Latch the register index the 6502 has left on port A.
      this.ay.selectRegister(this.portA);
    } else if (bdir) {
      // A write cycle: port A already holds the data byte, so the transition
      // into BDIR-without-BC1 is the bus cycle that commits it.
      this.writeSelected();
    } else if (bc1) {
      // A read cycle: the PSG drives the latched register onto port A.
      via.portAInput = this.ay.readRegister(this.ay.selectedReg) & 0xFF;
    }
  }

  /** A port A write: a data byte for a write cycle, or the register index. */
  onPortAWrite(via: M6522, value: number): void {
    this.portA = value & 0xFF;
    if (this.bdir && this.bc1) {
      this.ay.selectRegister(this.portA);
    } else if (this.bdir) {
      // The other half of the convention: the ROM may write the data while the
      // PSG is already selected.
      this.writeSelected();
    } else if (this.bc1) {
      via.portAInput = this.ay.readRegister(this.ay.selectedReg) & 0xFF;
    }
  }

  /** Commit `portA` into the latched register, and note the keyboard columns. */
  private writeSelected(): void {
    this.ay.writeRegister(this.ay.selectedReg, this.portA);
    this.columns = this.ay.readRegister(ORIC_PSG_PORT_A) & 0xFF;
  }

  /** True while the PSG is driving port A (a read cycle). */
  get drivingPortA(): boolean { return this.bc1 && !this.bdir; }

  /** The PSG's port A direction: 1 = input, which is how the ROM reads keys. */
  get portAIsInput(): boolean {
    return (this.ay.readRegister(ORIC_PSG_MIXER) & ORIC_PSG_PORT_A_INPUT) !== 0;
  }

  /** A sound is being made: any channel has a non-zero volume. */
  get sounding(): boolean {
    const regs = this.ay.getRegisters();
    return (regs[8] & 0x1F) !== 0 || (regs[9] & 0x1F) !== 0 || (regs[10] & 0x1F) !== 0;
  }

  reset(): void {
    this.ay.reset();
    this.columns = 0xFF;
    this.portA = 0xFF;
    this.bc1 = this.bdir = false;
  }

  /** The select lines and register file, for a chip dump. */
  describe(): string[] {
    const bus = this.bdir ? (this.bc1 ? 'latch index' : 'write') : (this.bc1 ? 'read' : 'idle');
    const regs = this.ay.getRegisters();
    const hex = (v: number): string => v.toString(16).padStart(2, '0');
    const out = [
      `BDIR ${this.bdir ? 1 : 0}  BC1 ${this.bc1 ? 1 : 0}  ->  ${bus}`,
      `Register ${this.ay.selectedReg.toString(16)}   port A ${hex(this.ay.readRegister(ORIC_PSG_PORT_A))} ` +
        `(${this.portAIsInput ? 'input' : 'output'})   columns ${hex(this.columns)}`,
    ];
    for (let i = 0; i < regs.length; i += 8) {
      out.push(`R${i.toString().padStart(2, '0')} ` + Array.from(regs.subarray(i, i + 8), hex).join(' '));
    }
    return out;
  }
}
