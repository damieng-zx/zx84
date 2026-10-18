/**
 * CMOS 65C02 CPU core (the G65SC02 found in the Apple //e Enhanced and //c).
 *
 * The NMOS core with the 65C02's differences layered on top:
 *
 *  - the new instructions: BRA, PHX/PHY/PLX/PLY, STZ, TSB/TRB, INC A/DEC A,
 *    BIT #/zp,X/abs,X, JMP (abs,X) and the `(zp)` addressing mode on the eight
 *    accumulator instructions;
 *  - every undocumented NMOS opcode becomes a NOP of the length (and, roughly,
 *    the time) the CMOS part gives it, rather than SLO/LAX/…;
 *  - JMP (abs) reads its pointer across a page boundary correctly;
 *  - decimal-mode ADC/SBC produce valid N and Z (and take an extra cycle);
 *  - BRK and the interrupts clear the decimal flag.
 *
 * The Rockwell/WDC extras (RMB/SMB/BBR/BBS, WAI, STP) are not in the G65SC02 and
 * so are NOPs here too.
 */

import { M6502, FLAG_C, FLAG_D, FLAG_V, FLAG_Z } from './m6502.ts';

/**
 * NMOS-undocumented opcodes that the 65C02 turns into NOPs, packed as
 * `bytes << 8 | cycles` (0 = not one of them).
 */
const NOP_FORM = new Uint16Array(256);
{
  const set = (op: number, bytes: number, cycles: number): void => { NOP_FORM[op] = (bytes << 8) | cycles; };
  for (let hi = 0; hi < 16; hi++) {
    // x3, x7, xB, xF: one byte, one cycle.
    for (const lo of [0x3, 0x7, 0xB, 0xF]) set((hi << 4) | lo, 1, 1);
  }
  for (const op of [0x02, 0x22, 0x42, 0x62, 0x82, 0xC2, 0xE2]) set(op, 2, 2);
  set(0x44, 2, 3);
  for (const op of [0x54, 0xD4, 0xF4]) set(op, 2, 4);
  set(0x5C, 3, 8);
  for (const op of [0xDC, 0xFC]) set(op, 3, 4);
}

export class M65C02 extends M6502 {
  override readonly cmos: boolean = true;

  // ── Interrupts: the decimal flag is cleared on entry ──────────────────────

  protected override interrupt(vector: number): void {
    super.interrupt(vector);
    this.p &= ~FLAG_D;
  }

  protected override brk(): void {
    super.brk();
    this.p &= ~FLAG_D;
  }

  // ── Decimal arithmetic with valid flags ───────────────────────────────────

  protected override adc(v: number): void {
    if (!this.flag(FLAG_D)) { super.adc(v); return; }
    v &= 0xFF;
    const a = this.a;
    const carry = this.flag(FLAG_C) ? 1 : 0;
    let lo = (a & 0x0F) + (v & 0x0F) + carry;
    if (lo >= 0x0A) lo = ((lo + 0x06) & 0x0F) + 0x10;
    let r = (a & 0xF0) + (v & 0xF0) + lo;
    this.setFlag(FLAG_V, (~(a ^ v) & (a ^ r) & 0x80) !== 0);
    if (r >= 0xA0) r += 0x60;
    this.setFlag(FLAG_C, r >= 0x100);
    this.a = r & 0xFF;
    this.setZN(this.a);
    this.tStates += 1;
  }

  protected override sbc(v: number): void {
    if (!this.flag(FLAG_D)) { super.sbc(v); return; }
    v &= 0xFF;
    const a = this.a;
    const borrow = this.flag(FLAG_C) ? 0 : 1;
    const bin = a - v - borrow;
    this.setFlag(FLAG_V, ((a ^ v) & (a ^ bin) & 0x80) !== 0);
    let lo = (a & 0x0F) - (v & 0x0F) - borrow;
    if (lo < 0) lo = ((lo - 0x06) & 0x0F) - 0x10;
    let r = (a & 0xF0) - (v & 0xF0) + lo;
    if (r < 0) r -= 0x60;
    this.setFlag(FLAG_C, bin >= 0);
    this.a = r & 0xFF;
    this.setZN(this.a);
    this.tStates += 1;
  }

  // ── Addressing ────────────────────────────────────────────────────────────

  /** `(zp)`: a pointer in zero page, no index. */
  private addrIZP(): number {
    const zp = this.fetch();
    return (this.read(zp) | (this.read((zp + 1) & 0xFF) << 8)) & 0xFFFF;
  }

  /** TSB/TRB: Z from A AND memory, then set or clear A's bits in memory. */
  private testBits(a: number, set: boolean): void {
    const v = this.read(a) & 0xFF;
    this.setFlag(FLAG_Z, (this.a & v) === 0);
    this.write(a, set ? v | this.a : v & ~this.a);
  }

  // ── Instruction decode ────────────────────────────────────────────────────

  protected override execute(op: number): void {
    switch (op) {
      // Accumulator ops with the (zp) mode.
      case 0x12: { const a = this.addrIZP(); this.ora(this.read(a)); this.tStates += 5; return; }
      case 0x32: { const a = this.addrIZP(); this.and(this.read(a)); this.tStates += 5; return; }
      case 0x52: { const a = this.addrIZP(); this.eor(this.read(a)); this.tStates += 5; return; }
      case 0x72: { const a = this.addrIZP(); this.adc(this.read(a)); this.tStates += 5; return; }
      case 0x92: { const a = this.addrIZP(); this.write(a, this.a); this.tStates += 5; return; }
      case 0xB2: { const a = this.addrIZP(); this.a = this.read(a); this.setZN(this.a); this.tStates += 5; return; }
      case 0xD2: { const a = this.addrIZP(); this.cmp(this.a, this.read(a)); this.tStates += 5; return; }
      case 0xF2: { const a = this.addrIZP(); this.sbc(this.read(a)); this.tStates += 5; return; }

      // INC A / DEC A
      case 0x1A: this.a = this.inc(this.a); this.tStates += 2; return;
      case 0x3A: this.a = this.dec(this.a); this.tStates += 2; return;

      // BIT additions (immediate touches only Z)
      case 0x34: { const a = this.addrZPX(); this.bit(this.read(a)); this.tStates += 4; return; }
      case 0x3C: { const a = this.addrABSX(); this.bit(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); return; }
      case 0x89: this.setFlag(FLAG_Z, (this.a & this.fetch()) === 0); this.tStates += 2; return;

      // Index-register stack ops
      case 0x5A: this.push(this.y); this.tStates += 3; return;
      case 0x7A: this.y = this.pop(); this.setZN(this.y); this.tStates += 4; return;
      case 0xDA: this.push(this.x); this.tStates += 3; return;
      case 0xFA: this.x = this.pop(); this.setZN(this.x); this.tStates += 4; return;

      // STZ
      case 0x64: this.write(this.addrZP(), 0); this.tStates += 3; return;
      case 0x74: this.write(this.addrZPX(), 0); this.tStates += 4; return;
      case 0x9C: this.write(this.addrABS(), 0); this.tStates += 4; return;
      case 0x9E: this.write(this.addrABSX(), 0); this.tStates += 5; return;

      // TSB / TRB
      case 0x04: this.testBits(this.addrZP(), true); this.tStates += 5; return;
      case 0x0C: this.testBits(this.addrABS(), true); this.tStates += 6; return;
      case 0x14: this.testBits(this.addrZP(), false); this.tStates += 5; return;
      case 0x1C: this.testBits(this.addrABS(), false); this.tStates += 6; return;

      // Jumps and branches
      case 0x6C: {
        const ptr = this.addrABS();
        this.pc = this.read(ptr) | (this.read((ptr + 1) & 0xFFFF) << 8);
        this.tStates += 6;
        return;
      }
      case 0x7C: {
        const ptr = (this.addrABS() + this.x) & 0xFFFF;
        this.pc = this.read(ptr) | (this.read((ptr + 1) & 0xFFFF) << 8);
        this.tStates += 6;
        return;
      }
      case 0x80: this.tStates += 2; this.branch(true); return;

      // Shifts and rotates on abs,X take six cycles (seven only when a page is crossed).
      case 0x1E: { const a = this.addrABSX(); this.write(a, this.asl(this.read(a))); this.tStates += 6 + (this.pageCross ? 1 : 0); return; }
      case 0x3E: { const a = this.addrABSX(); this.write(a, this.rol(this.read(a))); this.tStates += 6 + (this.pageCross ? 1 : 0); return; }
      case 0x5E: { const a = this.addrABSX(); this.write(a, this.lsr(this.read(a))); this.tStates += 6 + (this.pageCross ? 1 : 0); return; }
      case 0x7E: { const a = this.addrABSX(); this.write(a, this.ror(this.read(a))); this.tStates += 6 + (this.pageCross ? 1 : 0); return; }

      default: {
        const nop = NOP_FORM[op];
        if (nop === 0) { super.execute(op); return; }
        for (let i = (nop >> 8) - 1; i > 0; i--) this.fetch();
        this.tStates += nop & 0xFF;
      }
    }
  }
}
