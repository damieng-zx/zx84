/**
 * National Semiconductor COP420 — the 4-bit microcontroller used as the
 * NewBrain's keyboard / cassette / VF-display processor.
 *
 * Architecture (COP420 datasheet): 1K x 8 ROM in sixteen 64-byte pages, a 10-bit
 * program counter that is incremented before an instruction runs (sequential
 * execution carries on into the next page; a one-byte JP replaces only the low
 * six bits, so one in the last byte of a page lands in the next), 64 x 4 bits of RAM addressed by
 * the 6-bit B register (Br = B5:4 selects one of four 16-nibble registers, Bd =
 * B3:0 the nibble), a 4-bit accumulator A with a carry flag C, a three-level
 * hardware stack (SA, SB, SC), the 8-bit Q latch, the 4-bit ports G (I/O), D
 * (output) and IN (input), the 8-bit bidirectional L port, the SIO shift
 * register with SK/SO/SI, the EN control register and a 10-bit timer.
 *
 * Board wiring is supplied through {@link Cop420Pins}; the chip drives and
 * samples nothing else. One call to {@link Cop420.step} runs one instruction
 * (or takes the pending interrupt) and returns the instruction cycles it took —
 * the caller converts cycles to wall time (CKI / 16 on a COP420 with the divide
 * by 16 option). Everything that is clocked per instruction cycle — the timer,
 * the serial register and the IN edge latches — advances inside step().
 *
 * Modelling notes where the datasheet leaves a choice:
 *  - The timer is a 10-bit counter incremented once per instruction cycle; its
 *    overflow latch (set when the counter wraps, i.e. every 1024 cycles) is
 *    tested and cleared by SKT. Reset sets the latch, as the MAME-verified
 *    NewBrain firmware expects.
 *  - In shift-register mode (EN0 = 0) SIO shifts left once every instruction
 *    cycle, SI entering bit 0 and bit 3 leaving on SO (when EN3 is set); SK
 *    pulses high once per cycle while SKL is set. In counter mode (EN0 = 1)
 *    SIO counts SI falling edges downward and SK follows SKL.
 *  - IN edges: every IN pin has a latch (IL) set by a falling edge, sampled at
 *    instruction boundaries. IL1 is the interrupt request.
 *  - HALT mode is not modelled (the NewBrain never enters it); `halted` is
 *    always false.
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';

export interface Cop420Pins {
  /** 4-bit levels on G3..G0 as seen by ING. */
  readG(): number;
  /** 4-bit levels on IN3..IN0 (ININ; the edge latches sample these too). */
  readIN(): number;
  /** 8-bit levels on L7..L0 (INL). */
  readL(): number;
  /** Level on the SI pin, 0 or 1. */
  readSI(): number;
  /** The G output latch changed (4-bit). */
  writeG(v: number): void;
  /** The D output latch changed (4-bit). */
  writeD(v: number): void;
  /** L driven by Q (EN2 set), 8-bit. */
  writeL(v: number): void;
  writeSO(v: number): void;
  writeSK(v: number): void;
}

const ROM_SIZE = 1024;
const PAGE_MASK = 0x3C0;
const STATE_VERSION = 1;

/** Next sequential fetch address. The counter carries across page boundaries. */
function nextPc(pc: number): number { return (pc + 1) & 0x3FF; }

/** Two-byte instructions: the 0x23 / 0x33 prefixes, JMP and JSR. */
function isTwoByte(op: number): boolean {
  return op === 0x23 || op === 0x33 || (op & 0xFC) === 0x60 || (op & 0xFC) === 0x68;
}

/** Every instruction that loads the PC, which defers an interrupt by one. */
function isTransfer(op: number): boolean {
  return op >= 0x80 && op !== 0xBF
    || (op >= 0x60 && op <= 0x6F)
    || op === 0x48 || op === 0x49;
}

/** One-byte LBI occupies 00rr1ddd; the two-byte form is 0x33 followed by 10rrdddd. */
function isLbi1(op: number): boolean { return op < 0x40 && (op & 0x08) !== 0; }

export class Cop420 {
  readonly rom: Uint8Array;
  readonly ram = new Uint8Array(64);
  private readonly pins: Cop420Pins;

  pc = 0;
  a = 0;
  /** B = Br:Bd — Br is bits 5:4, Bd bits 3:0. */
  b = 0;
  c = 0;
  g = 0;
  d = 0;
  en = 0;
  q = 0;
  sa = 0;
  sb = 0;
  sc = 0;
  sio = 0;
  skl = 1;
  /** 10-bit timer. */
  t = 0;
  /** Timer overflow latch, tested and cleared by SKT. */
  skt = false;
  /** Input latches IL3..IL0, set by a falling edge on IN3..IN0. */
  il = 0;
  /** The next instruction is skipped. */
  skip = false;
  halted = false;

  /** A skip pending when the interrupt was taken; restored by the RET. */
  private skipLatch = false;
  /** The instruction just executed was an LBI: a following LBI is skipped. */
  private lbiSkip = false;
  private inPrev = 0xF;
  private siPrev = 0;
  private soOut = 0;
  private skOut = 0;

  constructor(rom: Uint8Array, pins: Cop420Pins) {
    this.rom = new Uint8Array(ROM_SIZE);
    this.rom.set(rom.subarray(0, ROM_SIZE));
    this.pins = pins;
  }

  /** Reset: PC, A, B, C, D, G, EN cleared, SKL and the timer overflow latch
   *  set. Q, the stack, SIO, IL and RAM are not touched. The output pins are
   *  driven to their reset levels. */
  reset(): void {
    this.pc = 0; this.a = 0; this.b = 0; this.c = 0;
    this.g = 0; this.d = 0; this.en = 0;
    this.skl = 1; this.t = 0; this.skt = true;
    this.skip = false; this.skipLatch = false; this.lbiSkip = false;
    this.halted = false;
    this.inPrev = this.pins.readIN() & 0xF;
    this.siPrev = this.pins.readSI() & 1;
    this.soOut = 0; this.skOut = 0;
    this.pins.writeG(0);
    this.pins.writeD(0);
    this.pins.writeSO(0);
    this.pins.writeSK(0);
  }

  /** Host bus read (MICROBUS): Q, unchanged. */
  hostRead(): number { return this.q; }

  /** Host bus write: the busy / interrupt line G0 is cleared, then Q is loaded
   *  (L is not driven — the host writes Q directly). */
  hostWrite(v: number): void {
    this.setG(this.g & 0xE);
    this.q = v & 0xFF;
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  /** Run one instruction (or take the pending interrupt); returns the cycles. */
  step(): number {
    const cur = this.pins.readIN() & 0xF;
    this.il |= this.inPrev & ~cur & 0xF;
    this.inPrev = cur;

    let cycles: number;
    if (this.halted) cycles = 1;
    else if ((this.il & 2) !== 0 && (this.en & 2) !== 0 && !this.lbiSkip
      && !isTransfer(this.rom[this.pc])) cycles = this.takeInterrupt();
    else cycles = this.execute();

    this.t += cycles;
    if (this.t > 0x3FF) { this.t &= 0x3FF; this.skt = true; }
    for (let i = 0; i < cycles; i++) this.serialTick();
    return cycles;
  }

  /** IN1 interrupt: push the PC, vector to 0x0FF, EN1 and IL1 cleared. A skip
   *  that was pending is held and handed back by the RET. */
  private takeInterrupt(): number {
    this.il &= ~2;
    this.en &= ~2;
    this.push(this.pc);
    this.skipLatch = this.skip;
    this.skip = false;
    this.pc = 0x0FF;
    return 1;
  }

  private push(pc: number): void { this.sc = this.sb; this.sb = this.sa; this.sa = pc; }

  private pop(): void {
    this.pc = this.sa; this.sa = this.sb; this.sb = this.sc;
    if (this.skipLatch) { this.skipLatch = false; this.skip = true; }
  }

  private fetch(): number {
    const v = this.rom[this.pc];
    this.pc = nextPc(this.pc);
    return v;
  }

  private setG(v: number): void {
    v &= 0xF;
    if (v !== this.g) { this.g = v; this.pins.writeG(v); }
  }

  private setD(v: number): void {
    v &= 0xF;
    if (v !== this.d) { this.d = v; this.pins.writeD(v); }
  }

  private setQ(v: number): void {
    this.q = v & 0xFF;
    if (this.en & 4) this.pins.writeL(this.q);
  }

  private setEn(v: number): void {
    const rising = (v & ~this.en & 4) !== 0;
    this.en = v & 0xF;
    if (rising) this.pins.writeL(this.q);
  }

  /** Execute the instruction at PC; returns its cycle count. */
  private execute(): number {
    const op = this.fetch();

    if (this.skip) {
      this.skip = false;
      this.lbiSkip = false;
      if (isTwoByte(op)) { this.fetch(); return 2; }
      return 1;
    }
    if (this.lbiSkip) {
      if (isLbi1(op)) return 1;
      if (op === 0x33 && (this.rom[this.pc] & 0xC0) === 0x80) { this.fetch(); return 2; }
      this.lbiSkip = false;
    }

    const ram = this.ram;

    // Pages 2 and 3 (0x080-0x0FF) have no JSRP: any 1xxxxxxx opcode there is a
    // one-byte JP with a seven-bit target, reaching all 128 addresses of the
    // two pages. (JSRP cannot be coded from inside them.)
    if (op >= 0x80 && op !== 0xBF && op !== 0xFF && (((this.pc - 1) & 0x380) === 0x080)) {
      this.pc = 0x80 | (op & 0x7F);
      return 1;
    }

    if (op >= 0xC0) {
      if (op === 0xFF) {
        // JID: the ROM byte addressed by A:M within this 256-byte page is the
        // new low byte of the PC.
        this.pc = (this.pc & 0x300) | this.rom[(this.pc & 0x300) | (this.a << 4) | ram[this.b]];
        return 2;
      }
      this.pc = (this.pc & PAGE_MASK) | (op & 0x3F);      // JP, within the page
      return 1;
    }
    if (op >= 0x80) {
      if (op === 0xBF) {
        // LQID: Q <- the addressed ROM byte; the PC stack is net unchanged.
        this.setQ(this.rom[(this.pc & 0x300) | (this.a << 4) | ram[this.b]]);
        return 2;
      }
      this.push(this.pc);                                  // JSRP, to page 2
      this.pc = 0x80 | (op & 0x3F);
      return 1;
    }
    if (op >= 0x70) {                                      // STII
      ram[this.b] = op & 0xF;
      this.b = (this.b & 0x30) | ((this.b + 1) & 0xF);
      return 1;
    }
    if (op >= 0x60) {
      if ((op & 0xFC) === 0x60) {                          // JMP
        this.pc = ((op & 3) << 8) | this.fetch();
        return 2;
      }
      if ((op & 0xFC) === 0x68) {                          // JSR
        const addr = ((op & 3) << 8) | this.fetch();
        this.push(this.pc);
        this.pc = addr;
        return 2;
      }
      return 1;                                            // illegal
    }
    if (op >= 0x51) {                                      // AISC
      const s = this.a + (op & 0xF);
      this.a = s & 0xF;
      if (s > 0xF) this.skip = true;
      return 1;
    }
    if (op < 0x40 && (op & 0x08) !== 0) {                  // LBI, one byte
      this.b = (op & 0x30) | (((op & 0xF) + 1) & 0xF);
      this.lbiSkip = true;
      return 1;
    }
    if (op < 0x40 && (op & 0x0C) === 0x04) {               // XIS / LD / X / XDS
      const r = (op >> 4) << 4;
      switch (op & 3) {
        case 0: {                                          // XIS
          const m = ram[this.b]; ram[this.b] = this.a; this.a = m;
          const bd = (this.b + 1) & 0xF;
          this.b = ((this.b & 0x30) | bd) ^ r;
          if (bd === 0) this.skip = true;
          break;
        }
        case 1:                                            // LD
          this.a = ram[this.b];
          this.b ^= r;
          break;
        case 2: {                                          // X
          const m = ram[this.b]; ram[this.b] = this.a; this.a = m;
          this.b ^= r;
          break;
        }
        default: {                                         // XDS
          const m = ram[this.b]; ram[this.b] = this.a; this.a = m;
          const bd = (this.b - 1) & 0xF;
          this.b = ((this.b & 0x30) | bd) ^ r;
          if (bd === 0xF) this.skip = true;
        }
      }
      return 1;
    }

    switch (op) {
      case 0x00: this.a = 0; return 1;                                  // CLRA
      case 0x01: if (!(ram[this.b] & 1)) this.skip = true; return 1;    // SKMBZ0
      case 0x11: if (!(ram[this.b] & 2)) this.skip = true; return 1;    // SKMBZ1
      case 0x03: if (!(ram[this.b] & 4)) this.skip = true; return 1;    // SKMBZ2
      case 0x13: if (!(ram[this.b] & 8)) this.skip = true; return 1;    // SKMBZ3
      case 0x02: this.a ^= ram[this.b]; return 1;                       // XOR
      case 0x10: {                                                      // CASC
        const s = (~this.a & 0xF) + ram[this.b] + this.c;
        this.a = s & 0xF; this.c = s >> 4;
        if (this.c) this.skip = true;
        return 1;
      }
      case 0x12: {                                                      // XABR
        const br = this.b >> 4;
        this.b = (this.b & 0xF) | ((this.a & 3) << 4);
        this.a = br;
        return 1;
      }
      case 0x20: if (this.c) this.skip = true; return 1;                // SKC
      case 0x21: if (this.a === ram[this.b]) this.skip = true; return 1; // SKE
      case 0x22: this.c = 1; return 1;                                  // SC
      case 0x32: this.c = 0; return 1;                                  // RC
      case 0x30: {                                                      // ASC
        const s = this.a + ram[this.b] + this.c;
        this.a = s & 0xF; this.c = s >> 4;
        if (this.c) this.skip = true;
        return 1;
      }
      case 0x31: this.a = (this.a + ram[this.b]) & 0xF; return 1;       // ADD
      case 0x23: return this.prefix23();
      case 0x33: return this.prefix33();
      case 0x40: this.a = ~this.a & 0xF; return 1;                      // COMP
      case 0x41:                                                        // SKT
        if (this.skt) { this.skt = false; this.skip = true; }
        return 1;
      case 0x42: ram[this.b] &= ~4; return 1;                           // RMB2
      case 0x43: ram[this.b] &= ~8; return 1;                           // RMB3
      case 0x44: return 1;                                              // NOP
      case 0x45: ram[this.b] &= ~2; return 1;                           // RMB1
      case 0x46: ram[this.b] |= 4; return 1;                            // SMB2
      case 0x47: ram[this.b] |= 2; return 1;                            // SMB1
      case 0x48: this.pop(); return 1;                                  // RET
      case 0x49: this.pop(); this.skip = true; return 1;                // RETSK
      case 0x4A: this.a = (this.a + 10) & 0xF; return 1;                // ADT
      case 0x4B: ram[this.b] |= 8; return 1;                            // SMB3
      case 0x4C: ram[this.b] &= ~1; return 1;                           // RMB0
      case 0x4D: ram[this.b] |= 1; return 1;                            // SMB0
      case 0x4E: this.a = this.b & 0xF; return 1;                       // CBA
      case 0x4F: {                                                      // XAS
        const s = this.sio; this.sio = this.a; this.a = s;
        this.skl = this.c;
        return 1;
      }
      case 0x50: this.b = (this.b & 0x30) | this.a; return 1;           // CAB
      default: return 1;                                                // illegal
    }
  }

  /** 0x23 prefix: LDD (00rrdddd) and XAD (10rrdddd) address RAM directly. */
  private prefix23(): number {
    const x = this.fetch();
    const addr = x & 0x3F;
    if ((x & 0xC0) === 0x00) this.a = this.ram[addr];
    else if ((x & 0xC0) === 0x80) {
      const m = this.ram[addr]; this.ram[addr] = this.a; this.a = m;
    }
    return 2;
  }

  /** 0x33 prefix: the I/O, G-bit, Q and LBI-with-any-immediate group. */
  private prefix33(): number {
    const x = this.fetch();
    const ram = this.ram;
    if ((x & 0xC0) === 0x80) {                             // LBI r,d
      this.b = x & 0x3F;
      this.lbiSkip = true;
      return 2;
    }
    switch (x) {
      case 0x01: if (!(this.pins.readG() & 1)) this.skip = true; break; // SKGBZ0
      case 0x11: if (!(this.pins.readG() & 2)) this.skip = true; break; // SKGBZ1
      case 0x03: if (!(this.pins.readG() & 4)) this.skip = true; break; // SKGBZ2
      case 0x13: if (!(this.pins.readG() & 8)) this.skip = true; break; // SKGBZ3
      case 0x21: if ((this.pins.readG() & 0xF) === 0) this.skip = true; break; // SKGZ
      case 0x28: this.a = this.pins.readIN() & 0xF; break;              // ININ
      case 0x29:                                                        // INIL
        // A3 = IL3, A2 = CAO (not modelled: 0), A1 = IL1, A0 = IL0; the
        // IN3 / IN0 latches clear when read.
        this.a = (this.il & 0x8) | (this.il & 0x3);
        this.il &= ~0x9;
        break;
      case 0x2A: this.a = this.pins.readG() & 0xF; break;               // ING
      case 0x2C: ram[this.b] = this.q >> 4; this.a = this.q & 0xF; break; // CQMA
      case 0x2E: {                                                      // INL
        const l = this.pins.readL() & 0xFF;
        ram[this.b] = l >> 4;
        this.a = l & 0xF;
        break;
      }
      case 0x3A: this.setG(ram[this.b]); break;                         // OMG
      case 0x3C: this.setQ((this.a << 4) | ram[this.b]); break;         // CAMQ
      case 0x3E: this.setD(this.b & 0xF); break;                        // OBD
      default:
        if ((x & 0xF0) === 0x50) this.setG(x & 0xF);                    // OGI
        else if ((x & 0xF0) === 0x60) this.setEn(x & 0xF);              // LEI
    }
    return 2;
  }

  // ── Serial / SK / SO ──────────────────────────────────────────────────────

  private driveSo(v: number): void {
    if (v !== this.soOut) { this.soOut = v; this.pins.writeSO(v); }
  }

  private driveSk(v: number): void {
    if (v !== this.skOut) { this.skOut = v; this.pins.writeSK(v); }
  }

  /** One instruction cycle of the serial logic. */
  private serialTick(): void {
    const si = this.pins.readSI() & 1;
    if (this.en & 1) {
      // Counter mode: SIO counts SI falling edges down; SO follows EN3.
      if (this.siPrev && !si) this.sio = (this.sio - 1) & 0xF;
      this.driveSo((this.en >> 3) & 1);
      this.driveSk(this.skl);
    } else {
      // Shift mode: bit 3 leaves on SO before the shift, SI enters at bit 0,
      // and SK gives one rising edge per cycle while SKL is set.
      this.driveSo(this.en & 8 ? (this.sio >> 3) & 1 : 0);
      if (this.skl) {
        this.pins.writeSK(1);
        this.pins.writeSK(0);
        this.skOut = 0;
      } else this.driveSk(0);
      this.sio = ((this.sio << 1) | si) & 0xF;
    }
    this.siPrev = si;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  saveState(w: StateSink): void {
    w.u8(STATE_VERSION);
    w.u16(this.pc);
    w.u8(this.a); w.u8(this.b); w.u8(this.c); w.u8(this.g); w.u8(this.d);
    w.u8(this.en); w.u8(this.q);
    w.u16(this.sa); w.u16(this.sb); w.u16(this.sc);
    w.u8(this.sio); w.u8(this.skl); w.u16(this.t);
    w.bool(this.skt); w.u8(this.il);
    w.bool(this.skip); w.bool(this.skipLatch); w.bool(this.lbiSkip); w.bool(this.halted);
    w.u8(this.inPrev); w.u8(this.siPrev); w.u8(this.soOut); w.u8(this.skOut);
    w.raw(this.ram);
  }

  loadState(r: StateSource): void {
    r.u8();
    this.pc = r.u16() & 0x3FF;
    this.a = r.u8() & 0xF; this.b = r.u8() & 0x3F; this.c = r.u8() & 1;
    this.g = r.u8() & 0xF; this.d = r.u8() & 0xF;
    this.en = r.u8() & 0xF; this.q = r.u8();
    this.sa = r.u16() & 0x3FF; this.sb = r.u16() & 0x3FF; this.sc = r.u16() & 0x3FF;
    this.sio = r.u8() & 0xF; this.skl = r.u8() & 1; this.t = r.u16() & 0x3FF;
    this.skt = r.bool(); this.il = r.u8() & 0xF;
    this.skip = r.bool(); this.skipLatch = r.bool(); this.lbiSkip = r.bool();
    this.halted = r.bool();
    this.inPrev = r.u8() & 0xF; this.siPrev = r.u8() & 1;
    this.soOut = r.u8() & 1; this.skOut = r.u8() & 1;
    r.rawInto(this.ram);
  }
}

// ── Disassembler ────────────────────────────────────────────────────────────

export interface Cop420Insn {
  text: string;
  /** Bytes the instruction occupies (1 or 2). */
  length: number;
  illegal: boolean;
}

const hex3 = (n: number) => n.toString(16).toUpperCase().padStart(3, '0');
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

const MAIN_NAMES: Record<number, string> = {
  0x00: 'CLRA', 0x01: 'SKMBZ 0', 0x02: 'XOR', 0x03: 'SKMBZ 2',
  0x10: 'CASC', 0x11: 'SKMBZ 1', 0x12: 'XABR', 0x13: 'SKMBZ 3',
  0x20: 'SKC', 0x21: 'SKE', 0x22: 'SC',
  0x30: 'ASC', 0x31: 'ADD', 0x32: 'RC',
  0x40: 'COMP', 0x41: 'SKT', 0x42: 'RMB 2', 0x43: 'RMB 3', 0x44: 'NOP',
  0x45: 'RMB 1', 0x46: 'SMB 2', 0x47: 'SMB 1', 0x48: 'RET', 0x49: 'RETSK',
  0x4A: 'ADT', 0x4B: 'SMB 3', 0x4C: 'RMB 0', 0x4D: 'SMB 0', 0x4E: 'CBA',
  0x4F: 'XAS', 0x50: 'CAB',
};

const PREFIX33_NAMES: Record<number, string> = {
  0x01: 'SKGBZ 0', 0x03: 'SKGBZ 2', 0x11: 'SKGBZ 1', 0x13: 'SKGBZ 3', 0x21: 'SKGZ',
  0x28: 'ININ', 0x29: 'INIL', 0x2A: 'ING', 0x2C: 'CQMA', 0x2E: 'INL',
  0x3A: 'OMG', 0x3C: 'CAMQ', 0x3E: 'OBD',
};

/** Decode the instruction at `addr` (a 10-bit ROM address). */
export function cop420Disassemble(rom: Uint8Array, addr: number): Cop420Insn {
  addr &= 0x3FF;
  const op = rom[addr];
  const second = rom[nextPc(addr)];
  const ok = (text: string, length = 1): Cop420Insn => ({ text, length, illegal: false });
  const bad = (length = 1): Cop420Insn => ({
    text: `.db ${hex2(op)}${length === 2 ? `,${hex2(second)}` : ''}`, length, illegal: true,
  });

  if (op === 0xFF) return ok('JID');
  if (op === 0xBF) return ok('LQID');
  // Inside pages 2 and 3 a 1xxxxxxx opcode is a seven-bit JP, not a JSRP.
  if (op >= 0x80 && (addr & 0x380) === 0x080) return ok(`JP ${hex3(0x80 | (op & 0x7F))}`);
  if (op >= 0xC0) return ok(`JP ${hex3(((addr + 1) & PAGE_MASK) | (op & 0x3F))}`);
  if (op >= 0x80) return ok(`JSRP ${hex3(0x80 | (op & 0x3F))}`);
  if (op >= 0x70) return ok(`STII ${op & 0xF}`);
  if (op >= 0x60) {
    if ((op & 0xFC) === 0x60) return ok(`JMP ${hex3(((op & 3) << 8) | second)}`, 2);
    if ((op & 0xFC) === 0x68) return ok(`JSR ${hex3(((op & 3) << 8) | second)}`, 2);
    return bad();
  }
  if (op >= 0x51) return ok(`AISC ${op & 0xF}`);
  if (isLbi1(op)) return ok(`LBI ${op >> 4},${((op & 0xF) + 1) & 0xF}`);
  if (op < 0x40 && (op & 0x0C) === 0x04) {
    return ok(`${['XIS', 'LD', 'X', 'XDS'][op & 3]} ${op >> 4}`);
  }
  if (op === 0x23) {
    const x = second;
    if ((x & 0xC0) === 0x00) return ok(`LDD ${x >> 4},${x & 0xF}`, 2);
    if ((x & 0xC0) === 0x80) return ok(`XAD ${(x >> 4) & 3},${x & 0xF}`, 2);
    return bad(2);
  }
  if (op === 0x33) {
    const x = second;
    if ((x & 0xC0) === 0x80) return ok(`LBI ${(x >> 4) & 3},${x & 0xF}`, 2);
    if (PREFIX33_NAMES[x]) return ok(PREFIX33_NAMES[x], 2);
    if ((x & 0xF0) === 0x50) return ok(`OGI ${x & 0xF}`, 2);
    if ((x & 0xF0) === 0x60) return ok(`LEI ${x & 0xF}`, 2);
    return bad(2);
  }
  const name = MAIN_NAMES[op];
  return name ? ok(name) : bad();
}
