/**
 * MOS 6502 CPU core (NMOS).
 *
 * A cycle-counted interpreter for the official 151-opcode set plus the stable
 * undocumented instructions (SLO/RLA/SRE/RRA/SAX/LAX/DCP/ISC/ANC/ALR/ARR/AXS),
 * which some BBC software relies on. IRQ is level-sensitive; NMI is
 * edge-triggered. Decimal mode is modelled, including the NMOS Z-flag quirk
 * (Z is taken from the binary result).
 *
 * Memory is chip-agnostic — the machine wires the bus after construction:
 *
 *   const cpu = new M6502();
 *   cpu.read  = (addr) => memory.readByte(addr);
 *   cpu.write = (addr, val) => memory.writeByte(addr, val);
 *
 * `tStates` is the cumulative cycle count; `step()` executes one instruction
 * (plus any serviced interrupt). The core never calls back into the machine.
 */

// ── Status register bits (P) ────────────────────────────────────────────────
export const FLAG_C = 0x01; // Carry
export const FLAG_Z = 0x02; // Zero
export const FLAG_I = 0x04; // Interrupt disable
export const FLAG_D = 0x08; // Decimal
export const FLAG_B = 0x10; // Break (stack only)
export const FLAG_U = 0x20; // Unused — always 1 on real silicon
export const FLAG_V = 0x40; // Overflow
export const FLAG_N = 0x80; // Negative

const VEC_NMI = 0xFFFA;
const VEC_RESET = 0xFFFC;
const VEC_IRQ = 0xFFFE;

export class M6502 {
  // ── Registers ───────────────────────────────────────────────────────────
  a = 0;
  x = 0;
  y = 0;
  sp = 0xFD;
  pc = 0;
  /** Status register. Initialised with I and U set (hardware power-on state). */
  p = FLAG_I | FLAG_U;

  /** Cumulative cycle counter. */
  tStates = 0;

  /** Level-triggered IRQ input. */
  irqLine = false;
  /** Edge-triggered NMI latch (set by nmi(), consumed in step()). */
  private nmiPending = false;

  /** Memory bus — overridden by the machine before execution. */
  read: (addr: number) => number = () => 0xFF;
  write: (addr: number, val: number) => void = () => {};

  constructor() {
    this.reset();
  }

  reset(): void {
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xFD;
    this.p = FLAG_I | FLAG_U;
    this.pc = this.readWord(VEC_RESET);
    this.tStates = 0;
    this.irqLine = false;
    this.nmiPending = false;
  }

  /** Assert (true) or release (false) the level-sensitive IRQ line. */
  setIRQ(asserted: boolean): void { this.irqLine = asserted; }

  /** Latch an NMI edge. */
  nmi(): void { this.nmiPending = true; }

  // ── Bus helpers ─────────────────────────────────────────────────────────
  private fetch(): number { return this.read(this.pc++) & 0xFF; }
  private fetch16(): number { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  private readWord(addr: number): number {
    return this.read(addr) | (this.read((addr + 1) & 0xFFFF) << 8);
  }
  /** JMP (indirect) page-wrap bug: the high byte is fetched from the same page. */
  private readWordBug(addr: number): number {
    const lo = this.read(addr) & 0xFF;
    const hi = this.read((addr & 0xFF00) | ((addr + 1) & 0xFF)) & 0xFF;
    return lo | (hi << 8);
  }

  private push(v: number): void {
    this.write(0x0100 | this.sp, v & 0xFF);
    this.sp = (this.sp - 1) & 0xFF;
  }
  private pop(): number {
    this.sp = (this.sp + 1) & 0xFF;
    return this.read(0x0100 | this.sp) & 0xFF;
  }
  private push16(v: number): void {
    this.push((v >> 8) & 0xFF);
    this.push(v & 0xFF);
  }
  private pop16(): number {
    const lo = this.pop();
    return lo | (this.pop() << 8);
  }

  // ── Flag helpers ────────────────────────────────────────────────────────
  private flag(bit: number): boolean { return (this.p & bit) !== 0; }
  private setFlag(bit: number, cond: boolean): void {
    if (cond) this.p |= bit; else this.p &= ~bit;
  }
  private setZN(v: number): void {
    v &= 0xFF;
    this.p = (this.p & ~(FLAG_N | FLAG_Z)) | (v & FLAG_N);
    if (v === 0) this.p |= FLAG_Z;
  }

  // ── Addressing modes ────────────────────────────────────────────────────
  /** Set true by a page-crossing absolute indexed access. Reset per step. */
  private pageCross = false;

  private addrZP(): number { return this.fetch(); }
  private addrZPX(): number { return (this.fetch() + this.x) & 0xFF; }
  private addrZPY(): number { return (this.fetch() + this.y) & 0xFF; }
  private addrABS(): number { return this.fetch16(); }
  private addrABSX(): number {
    const base = this.fetch16();
    const addr = (base + this.x) & 0xFFFF;
    this.pageCross = (base & 0xFF00) !== (addr & 0xFF00);
    return addr;
  }
  private addrABSY(): number {
    const base = this.fetch16();
    const addr = (base + this.y) & 0xFFFF;
    this.pageCross = (base & 0xFF00) !== (addr & 0xFF00);
    return addr;
  }
  /** (zp,X): pointer at zp+X, wrapping in zero page. */
  private addrINDX(): number {
    const zp = (this.fetch() + this.x) & 0xFF;
    return (this.read(zp) | (this.read((zp + 1) & 0xFF) << 8)) & 0xFFFF;
  }
  /** (zp),Y: pointer at zp, offset by Y. */
  private addrINDY(): number {
    const zp = this.fetch();
    const base = this.read(zp) | (this.read((zp + 1) & 0xFF) << 8);
    const addr = (base + this.y) & 0xFFFF;
    this.pageCross = (base & 0xFF00) !== (addr & 0xFF00);
    return addr;
  }

  // ── ALU operations ──────────────────────────────────────────────────────
  private ora(v: number): void { this.a = (this.a | v) & 0xFF; this.setZN(this.a); }
  private and(v: number): void { this.a = (this.a & v) & 0xFF; this.setZN(this.a); }
  private eor(v: number): void { this.a = (this.a ^ v) & 0xFF; this.setZN(this.a); }

  private adc(v: number): void {
    v &= 0xFF;
    if (this.flag(FLAG_D)) {
      const carry = this.flag(FLAG_C) ? 1 : 0;
      const bin = this.a + v + carry;
      this.setFlag(FLAG_V, (~(this.a ^ v) & (this.a ^ bin) & 0x80) !== 0);
      let lo = (this.a & 0x0F) + (v & 0x0F) + carry;
      let hi = (this.a >> 4) + (v >> 4);
      if (lo > 9) { lo += 6; hi++; }
      if (hi > 9) hi += 6;
      this.setFlag(FLAG_C, hi > 15);
      this.a = ((hi << 4) | (lo & 0x0F)) & 0xFF;
      // NMOS: Z is derived from the binary result, N from the decimal result.
      this.setFlag(FLAG_Z, (bin & 0xFF) === 0);
      this.setFlag(FLAG_N, (this.a & 0x80) !== 0);
    } else {
      const carry = this.flag(FLAG_C) ? 1 : 0;
      const r = this.a + v + carry;
      this.setFlag(FLAG_C, r > 0xFF);
      this.setFlag(FLAG_V, (~(this.a ^ v) & (this.a ^ r) & 0x80) !== 0);
      this.a = r & 0xFF;
      this.setZN(this.a);
    }
  }

  private sbc(v: number): void {
    v &= 0xFF;
    if (this.flag(FLAG_D)) {
      const borrow = this.flag(FLAG_C) ? 0 : 1;
      const bin = this.a - v - borrow;
      this.setFlag(FLAG_V, ((this.a ^ v) & (this.a ^ bin) & 0x80) !== 0);
      let lo = (this.a & 0x0F) - (v & 0x0F) - borrow;
      let hi = (this.a >> 4) - (v >> 4);
      if (lo < 0) { lo -= 6; hi--; }
      if (hi < 0) hi -= 6;
      this.a = ((hi << 4) | (lo & 0x0F)) & 0xFF;
      this.setFlag(FLAG_C, bin >= 0);
      this.setFlag(FLAG_Z, (bin & 0xFF) === 0);
      this.setFlag(FLAG_N, (this.a & 0x80) !== 0);
    } else {
      const borrow = this.flag(FLAG_C) ? 0 : 1;
      const r = this.a - v - borrow;
      this.setFlag(FLAG_C, r >= 0);
      this.setFlag(FLAG_V, ((this.a ^ v) & (this.a ^ r) & 0x80) !== 0);
      this.a = r & 0xFF;
      this.setZN(this.a);
    }
  }

  private cmp(reg: number, v: number): void {
    const r = (reg - v) & 0x1FF;
    this.setFlag(FLAG_C, reg >= v);
    this.setZN(r & 0xFF);
  }

  private bit(v: number): void {
    this.setFlag(FLAG_Z, (this.a & v) === 0);
    this.setFlag(FLAG_N, (v & 0x80) !== 0);
    this.setFlag(FLAG_V, (v & 0x40) !== 0);
  }

  // Shifts / rotates — return the result and set C/Z/N.
  private asl(v: number): number {
    this.setFlag(FLAG_C, (v & 0x80) !== 0);
    const r = (v << 1) & 0xFF;
    this.setZN(r);
    return r;
  }
  private lsr(v: number): number {
    this.setFlag(FLAG_C, (v & 0x01) !== 0);
    const r = (v >> 1) & 0xFF;
    this.setZN(r);
    return r;
  }
  private rol(v: number): number {
    const c = this.flag(FLAG_C) ? 1 : 0;
    this.setFlag(FLAG_C, (v & 0x80) !== 0);
    const r = ((v << 1) | c) & 0xFF;
    this.setZN(r);
    return r;
  }
  private ror(v: number): number {
    const c = this.flag(FLAG_C) ? 0x80 : 0;
    this.setFlag(FLAG_C, (v & 0x01) !== 0);
    const r = ((v >> 1) | c) & 0xFF;
    this.setZN(r);
    return r;
  }

  private inc(v: number): number { const r = (v + 1) & 0xFF; this.setZN(r); return r; }
  private dec(v: number): number { const r = (v - 1) & 0xFF; this.setZN(r); return r; }

  // ── Illegal-op helpers ──────────────────────────────────────────────────
  private slo(v: number): number { return this.asl(v); }
  private rla(v: number): number { return this.rol(v); }
  private sre(v: number): number { return this.lsr(v); }
  private rra(v: number): number { return this.ror(v); }
  private anc(v: number): void {
    this.a = (this.a & v) & 0xFF;
    this.setZN(this.a);
    this.setFlag(FLAG_C, (this.a & 0x80) !== 0);
  }
  private lax(v: number): void { this.a = v & 0xFF; this.x = this.a; this.setZN(this.a); }

  private branch(cond: boolean): void {
    const off = this.fetch();
    if (!cond) return;
    this.tStates += 1;
    const signed = off < 0x80 ? off : off - 256;
    const target = (this.pc + signed) & 0xFFFF;
    if ((target & 0xFF00) !== (this.pc & 0xFF00)) this.tStates += 1;
    this.pc = target;
  }

  private interrupt(vector: number): void {
    this.push16(this.pc);
    this.p = (this.p & ~FLAG_B) | FLAG_U;
    this.push(this.p);
    this.p |= FLAG_I;
    this.pc = this.readWord(vector);
    this.tStates += 7;
  }

  private brk(): void {
    this.pc = (this.pc + 1) & 0xFFFF;
    this.push16(this.pc);
    this.push(this.p | FLAG_B | FLAG_U);
    this.p |= FLAG_I;
    this.pc = this.readWord(VEC_IRQ);
    this.tStates += 7;
  }

  // ── Instruction fetch/execute ───────────────────────────────────────────
  step(): void {
    if (this.nmiPending) {
      this.nmiPending = false;
      this.interrupt(VEC_NMI);
      return;
    }
    if (this.irqLine && !this.flag(FLAG_I)) {
      this.interrupt(VEC_IRQ);
      return;
    }

    this.pageCross = false;
    const op = this.fetch();

    switch (op) {
      // ── 0x00 block ──────────────────────────────────────────────────────
      case 0x00: this.brk(); break;
      case 0x01: { const a = this.addrINDX(); this.ora(this.read(a)); this.tStates += 6; break; }
      case 0x03: { const a = this.addrINDX(); const r = this.slo(this.read(a)); this.write(a, r); this.ora(r); this.tStates += 8; break; }
      case 0x04: { this.addrZP(); this.tStates += 3; break; }
      case 0x05: { const a = this.addrZP(); this.ora(this.read(a)); this.tStates += 3; break; }
      case 0x06: { const a = this.addrZP(); this.write(a, this.asl(this.read(a))); this.tStates += 5; break; }
      case 0x07: { const a = this.addrZP(); const r = this.slo(this.read(a)); this.write(a, r); this.ora(r); this.tStates += 5; break; }
      case 0x08: this.push(this.p | FLAG_B | FLAG_U); this.tStates += 3; break;
      case 0x09: this.ora(this.fetch()); this.tStates += 2; break;
      case 0x0A: this.a = this.asl(this.a); this.tStates += 2; break;
      case 0x0B: this.anc(this.fetch()); this.tStates += 2; break;
      case 0x0C: this.addrABS(); this.tStates += 4; break;
      case 0x0D: { const a = this.addrABS(); this.ora(this.read(a)); this.tStates += 4; break; }
      case 0x0E: { const a = this.addrABS(); this.write(a, this.asl(this.read(a))); this.tStates += 6; break; }
      case 0x0F: { const a = this.addrABS(); const r = this.slo(this.read(a)); this.write(a, r); this.ora(r); this.tStates += 6; break; }
      case 0x10: this.tStates += 2; this.branch(!this.flag(FLAG_N)); break;
      case 0x11: { const a = this.addrINDY(); this.ora(this.read(a)); this.tStates += 5 + (this.pageCross ? 1 : 0); break; }
      case 0x13: { const a = this.addrINDY(); const r = this.slo(this.read(a)); this.write(a, r); this.ora(r); this.tStates += 8; break; }
      case 0x14: { this.addrZPX(); this.tStates += 4; break; }
      case 0x15: { const a = this.addrZPX(); this.ora(this.read(a)); this.tStates += 4; break; }
      case 0x16: { const a = this.addrZPX(); this.write(a, this.asl(this.read(a))); this.tStates += 6; break; }
      case 0x17: { const a = this.addrZPX(); const r = this.slo(this.read(a)); this.write(a, r); this.ora(r); this.tStates += 6; break; }
      case 0x18: this.setFlag(FLAG_C, false); this.tStates += 2; break;
      case 0x19: { const a = this.addrABSY(); this.ora(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x1A: this.tStates += 2; break;
      case 0x1B: { const a = this.addrABSY(); const r = this.slo(this.read(a)); this.write(a, r); this.ora(r); this.tStates += 7; break; }
      case 0x1C: { this.addrABSX(); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x1D: { const a = this.addrABSX(); this.ora(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x1E: { const a = this.addrABSX(); this.write(a, this.asl(this.read(a))); this.tStates += 7; break; }
      case 0x1F: { const a = this.addrABSX(); const r = this.slo(this.read(a)); this.write(a, r); this.ora(r); this.tStates += 7; break; }

      // ── 0x20 block ──────────────────────────────────────────────────────
      case 0x20: { const a = this.addrABS(); this.push16((this.pc - 1) & 0xFFFF); this.pc = a; this.tStates += 6; break; }
      case 0x21: { const a = this.addrINDX(); this.and(this.read(a)); this.tStates += 6; break; }
      case 0x23: { const a = this.addrINDX(); const r = this.rla(this.read(a)); this.write(a, r); this.and(r); this.tStates += 8; break; }
      case 0x24: { const a = this.addrZP(); this.bit(this.read(a)); this.tStates += 3; break; }
      case 0x25: { const a = this.addrZP(); this.and(this.read(a)); this.tStates += 3; break; }
      case 0x26: { const a = this.addrZP(); this.write(a, this.rol(this.read(a))); this.tStates += 5; break; }
      case 0x27: { const a = this.addrZP(); const r = this.rla(this.read(a)); this.write(a, r); this.and(r); this.tStates += 5; break; }
      case 0x28: this.p = (this.pop() & ~FLAG_B) | FLAG_U; this.tStates += 4; break;
      case 0x29: this.and(this.fetch()); this.tStates += 2; break;
      case 0x2A: this.a = this.rol(this.a); this.tStates += 2; break;
      case 0x2B: this.anc(this.fetch()); this.tStates += 2; break;
      case 0x2C: { const a = this.addrABS(); this.bit(this.read(a)); this.tStates += 4; break; }
      case 0x2D: { const a = this.addrABS(); this.and(this.read(a)); this.tStates += 4; break; }
      case 0x2E: { const a = this.addrABS(); this.write(a, this.rol(this.read(a))); this.tStates += 6; break; }
      case 0x2F: { const a = this.addrABS(); const r = this.rla(this.read(a)); this.write(a, r); this.and(r); this.tStates += 6; break; }
      case 0x30: this.tStates += 2; this.branch(this.flag(FLAG_N)); break;
      case 0x31: { const a = this.addrINDY(); this.and(this.read(a)); this.tStates += 5 + (this.pageCross ? 1 : 0); break; }
      case 0x33: { const a = this.addrINDY(); const r = this.rla(this.read(a)); this.write(a, r); this.and(r); this.tStates += 8; break; }
      case 0x34: { this.addrZPX(); this.tStates += 4; break; }
      case 0x35: { const a = this.addrZPX(); this.and(this.read(a)); this.tStates += 4; break; }
      case 0x36: { const a = this.addrZPX(); this.write(a, this.rol(this.read(a))); this.tStates += 6; break; }
      case 0x37: { const a = this.addrZPX(); const r = this.rla(this.read(a)); this.write(a, r); this.and(r); this.tStates += 6; break; }
      case 0x38: this.setFlag(FLAG_C, true); this.tStates += 2; break;
      case 0x39: { const a = this.addrABSY(); this.and(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x3A: this.tStates += 2; break;
      case 0x3B: { const a = this.addrABSY(); const r = this.rla(this.read(a)); this.write(a, r); this.and(r); this.tStates += 7; break; }
      case 0x3C: { this.addrABSX(); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x3D: { const a = this.addrABSX(); this.and(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x3E: { const a = this.addrABSX(); this.write(a, this.rol(this.read(a))); this.tStates += 7; break; }
      case 0x3F: { const a = this.addrABSX(); const r = this.rla(this.read(a)); this.write(a, r); this.and(r); this.tStates += 7; break; }

      // ── 0x40 block ──────────────────────────────────────────────────────
      case 0x40: this.p = (this.pop() & ~FLAG_B) | FLAG_U; this.pc = this.pop16(); this.tStates += 6; break;
      case 0x41: { const a = this.addrINDX(); this.eor(this.read(a)); this.tStates += 6; break; }
      case 0x43: { const a = this.addrINDX(); const r = this.sre(this.read(a)); this.write(a, r); this.eor(r); this.tStates += 8; break; }
      case 0x44: { this.addrZP(); this.tStates += 3; break; }
      case 0x45: { const a = this.addrZP(); this.eor(this.read(a)); this.tStates += 3; break; }
      case 0x46: { const a = this.addrZP(); this.write(a, this.lsr(this.read(a))); this.tStates += 5; break; }
      case 0x47: { const a = this.addrZP(); const r = this.sre(this.read(a)); this.write(a, r); this.eor(r); this.tStates += 5; break; }
      case 0x48: this.push(this.a); this.tStates += 3; break;
      case 0x49: this.eor(this.fetch()); this.tStates += 2; break;
      case 0x4A: this.a = this.lsr(this.a); this.tStates += 2; break;
      case 0x4B: this.a = this.alr(this.fetch()); this.tStates += 2; break;
      case 0x4C: this.pc = this.addrABS(); this.tStates += 3; break;
      case 0x4D: { const a = this.addrABS(); this.eor(this.read(a)); this.tStates += 4; break; }
      case 0x4E: { const a = this.addrABS(); this.write(a, this.lsr(this.read(a))); this.tStates += 6; break; }
      case 0x4F: { const a = this.addrABS(); const r = this.sre(this.read(a)); this.write(a, r); this.eor(r); this.tStates += 6; break; }
      case 0x50: this.tStates += 2; this.branch(!this.flag(FLAG_V)); break;
      case 0x51: { const a = this.addrINDY(); this.eor(this.read(a)); this.tStates += 5 + (this.pageCross ? 1 : 0); break; }
      case 0x53: { const a = this.addrINDY(); const r = this.sre(this.read(a)); this.write(a, r); this.eor(r); this.tStates += 8; break; }
      case 0x54: { this.addrZPX(); this.tStates += 4; break; }
      case 0x55: { const a = this.addrZPX(); this.eor(this.read(a)); this.tStates += 4; break; }
      case 0x56: { const a = this.addrZPX(); this.write(a, this.lsr(this.read(a))); this.tStates += 6; break; }
      case 0x57: { const a = this.addrZPX(); const r = this.sre(this.read(a)); this.write(a, r); this.eor(r); this.tStates += 6; break; }
      case 0x58: this.setFlag(FLAG_I, false); this.tStates += 2; break;
      case 0x59: { const a = this.addrABSY(); this.eor(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x5A: this.tStates += 2; break;
      case 0x5B: { const a = this.addrABSY(); const r = this.sre(this.read(a)); this.write(a, r); this.eor(r); this.tStates += 7; break; }
      case 0x5C: { this.addrABSX(); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x5D: { const a = this.addrABSX(); this.eor(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x5E: { const a = this.addrABSX(); this.write(a, this.lsr(this.read(a))); this.tStates += 7; break; }
      case 0x5F: { const a = this.addrABSX(); const r = this.sre(this.read(a)); this.write(a, r); this.eor(r); this.tStates += 7; break; }

      // ── 0x60 block ──────────────────────────────────────────────────────
      case 0x60: this.pc = (this.pop16() + 1) & 0xFFFF; this.tStates += 6; break;
      case 0x61: { const a = this.addrINDX(); this.adc(this.read(a)); this.tStates += 6; break; }
      case 0x63: { const a = this.addrINDX(); const r = this.rra(this.read(a)); this.write(a, r); this.adc(r); this.tStates += 8; break; }
      case 0x64: { this.addrZP(); this.tStates += 3; break; }
      case 0x65: { const a = this.addrZP(); this.adc(this.read(a)); this.tStates += 3; break; }
      case 0x66: { const a = this.addrZP(); this.write(a, this.ror(this.read(a))); this.tStates += 5; break; }
      case 0x67: { const a = this.addrZP(); const r = this.rra(this.read(a)); this.write(a, r); this.adc(r); this.tStates += 5; break; }
      case 0x68: this.a = this.pop(); this.setZN(this.a); this.tStates += 4; break;
      case 0x69: this.adc(this.fetch()); this.tStates += 2; break;
      case 0x6A: this.a = this.ror(this.a); this.tStates += 2; break;
      case 0x6B: this.a = this.arr(this.fetch()); this.tStates += 2; break;
      case 0x6C: this.pc = this.readWordBug(this.addrABS()); this.tStates += 5; break;
      case 0x6D: { const a = this.addrABS(); this.adc(this.read(a)); this.tStates += 4; break; }
      case 0x6E: { const a = this.addrABS(); this.write(a, this.ror(this.read(a))); this.tStates += 6; break; }
      case 0x6F: { const a = this.addrABS(); const r = this.rra(this.read(a)); this.write(a, r); this.adc(r); this.tStates += 6; break; }
      case 0x70: this.tStates += 2; this.branch(this.flag(FLAG_V)); break;
      case 0x71: { const a = this.addrINDY(); this.adc(this.read(a)); this.tStates += 5 + (this.pageCross ? 1 : 0); break; }
      case 0x73: { const a = this.addrINDY(); const r = this.rra(this.read(a)); this.write(a, r); this.adc(r); this.tStates += 8; break; }
      case 0x74: { this.addrZPX(); this.tStates += 4; break; }
      case 0x75: { const a = this.addrZPX(); this.adc(this.read(a)); this.tStates += 4; break; }
      case 0x76: { const a = this.addrZPX(); this.write(a, this.ror(this.read(a))); this.tStates += 6; break; }
      case 0x77: { const a = this.addrZPX(); const r = this.rra(this.read(a)); this.write(a, r); this.adc(r); this.tStates += 6; break; }
      case 0x78: this.setFlag(FLAG_I, true); this.tStates += 2; break;
      case 0x79: { const a = this.addrABSY(); this.adc(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x7A: this.tStates += 2; break;
      case 0x7B: { const a = this.addrABSY(); const r = this.rra(this.read(a)); this.write(a, r); this.adc(r); this.tStates += 7; break; }
      case 0x7C: { this.addrABSX(); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x7D: { const a = this.addrABSX(); this.adc(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0x7E: { const a = this.addrABSX(); this.write(a, this.ror(this.read(a))); this.tStates += 7; break; }
      case 0x7F: { const a = this.addrABSX(); const r = this.rra(this.read(a)); this.write(a, r); this.adc(r); this.tStates += 7; break; }

      // ── 0x80 block ──────────────────────────────────────────────────────
      case 0x80: this.fetch(); this.tStates += 2; break;
      case 0x81: { const a = this.addrINDX(); this.write(a, this.a); this.tStates += 6; break; }
      case 0x82: this.fetch(); this.tStates += 2; break;
      case 0x83: { const a = this.addrINDX(); this.write(a, this.a & this.x); this.tStates += 6; break; }
      case 0x84: { const a = this.addrZP(); this.write(a, this.y); this.tStates += 3; break; }
      case 0x85: { const a = this.addrZP(); this.write(a, this.a); this.tStates += 3; break; }
      case 0x86: { const a = this.addrZP(); this.write(a, this.x); this.tStates += 3; break; }
      case 0x87: { const a = this.addrZP(); this.write(a, this.a & this.x); this.tStates += 3; break; }
      case 0x88: this.y = this.dec(this.y); this.tStates += 2; break;
      case 0x89: this.fetch(); this.tStates += 2; break;
      case 0x8A: this.a = this.x; this.setZN(this.a); this.tStates += 2; break;
      case 0x8B: { this.a = (this.a & this.x) & 0xFF; this.setZN(this.a); this.fetch(); this.tStates += 2; break; }
      case 0x8C: { const a = this.addrABS(); this.write(a, this.y); this.tStates += 4; break; }
      case 0x8D: { const a = this.addrABS(); this.write(a, this.a); this.tStates += 4; break; }
      case 0x8E: { const a = this.addrABS(); this.write(a, this.x); this.tStates += 4; break; }
      case 0x8F: { const a = this.addrABS(); this.write(a, this.a & this.x); this.tStates += 4; break; }
      case 0x90: this.tStates += 2; this.branch(!this.flag(FLAG_C)); break;
      case 0x91: { const a = this.addrINDY(); this.write(a, this.a); this.tStates += 6; break; }
      case 0x93: { const a = this.addrINDY(); this.write(a, this.a & this.x & ((a >> 8) + 1)); this.tStates += 6; break; }
      case 0x94: { const a = this.addrZPX(); this.write(a, this.y); this.tStates += 4; break; }
      case 0x95: { const a = this.addrZPX(); this.write(a, this.a); this.tStates += 4; break; }
      case 0x96: { const a = this.addrZPY(); this.write(a, this.x); this.tStates += 4; break; }
      case 0x97: { const a = this.addrZPY(); this.write(a, this.a & this.x); this.tStates += 4; break; }
      case 0x98: this.a = this.y; this.setZN(this.a); this.tStates += 2; break;
      case 0x99: { const a = this.addrABSY(); this.write(a, this.a); this.tStates += 5; break; }
      case 0x9A: this.sp = this.x; this.tStates += 2; break;
      case 0x9B: { const a = this.addrABSY(); this.sp = this.a & this.x; this.write(a, this.sp & ((a >> 8) + 1)); this.tStates += 5; break; }
      case 0x9C: { const a = this.addrABSX(); this.write(a, this.y & ((a >> 8) + 1)); this.tStates += 5; break; }
      case 0x9D: { const a = this.addrABSX(); this.write(a, this.a); this.tStates += 5; break; }
      case 0x9E: { const a = this.addrABSY(); this.write(a, this.x & ((a >> 8) + 1)); this.tStates += 5; break; }
      case 0x9F: { const a = this.addrABSY(); this.write(a, this.a & this.x & ((a >> 8) + 1)); this.tStates += 5; break; }

      // ── 0xA0 block ──────────────────────────────────────────────────────
      case 0xA0: this.y = this.fetch(); this.setZN(this.y); this.tStates += 2; break;
      case 0xA1: { const a = this.addrINDX(); this.a = this.read(a); this.setZN(this.a); this.tStates += 6; break; }
      case 0xA2: this.x = this.fetch(); this.setZN(this.x); this.tStates += 2; break;
      case 0xA3: { const a = this.addrINDX(); this.lax(this.read(a)); this.tStates += 6; break; }
      case 0xA4: { const a = this.addrZP(); this.y = this.read(a); this.setZN(this.y); this.tStates += 3; break; }
      case 0xA5: { const a = this.addrZP(); this.a = this.read(a); this.setZN(this.a); this.tStates += 3; break; }
      case 0xA6: { const a = this.addrZP(); this.x = this.read(a); this.setZN(this.x); this.tStates += 3; break; }
      case 0xA7: { const a = this.addrZP(); this.lax(this.read(a)); this.tStates += 3; break; }
      case 0xA8: this.y = this.a; this.setZN(this.y); this.tStates += 2; break;
      case 0xA9: this.a = this.fetch(); this.setZN(this.a); this.tStates += 2; break;
      case 0xAA: this.x = this.a; this.setZN(this.x); this.tStates += 2; break;
      case 0xAB: { this.a = this.x = (this.a & this.fetch()) & 0xFF; this.setZN(this.a); this.tStates += 2; break; }
      case 0xAC: { const a = this.addrABS(); this.y = this.read(a); this.setZN(this.y); this.tStates += 4; break; }
      case 0xAD: { const a = this.addrABS(); this.a = this.read(a); this.setZN(this.a); this.tStates += 4; break; }
      case 0xAE: { const a = this.addrABS(); this.x = this.read(a); this.setZN(this.x); this.tStates += 4; break; }
      case 0xAF: { const a = this.addrABS(); this.lax(this.read(a)); this.tStates += 4; break; }
      case 0xB0: this.tStates += 2; this.branch(this.flag(FLAG_C)); break;
      case 0xB1: { const a = this.addrINDY(); this.a = this.read(a); this.setZN(this.a); this.tStates += 5 + (this.pageCross ? 1 : 0); break; }
      case 0xB3: { const a = this.addrINDY(); this.lax(this.read(a)); this.tStates += 5 + (this.pageCross ? 1 : 0); break; }
      case 0xB4: { const a = this.addrZPX(); this.y = this.read(a); this.setZN(this.y); this.tStates += 4; break; }
      case 0xB5: { const a = this.addrZPX(); this.a = this.read(a); this.setZN(this.a); this.tStates += 4; break; }
      case 0xB6: { const a = this.addrZPY(); this.x = this.read(a); this.setZN(this.x); this.tStates += 4; break; }
      case 0xB7: { const a = this.addrZPY(); this.lax(this.read(a)); this.tStates += 4; break; }
      case 0xB8: this.setFlag(FLAG_V, false); this.tStates += 2; break;
      case 0xB9: { const a = this.addrABSY(); this.a = this.read(a); this.setZN(this.a); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xBA: this.x = this.sp; this.setZN(this.x); this.tStates += 2; break;
      case 0xBB: { const a = this.addrABSY(); const v = this.read(a); this.a = this.x = this.sp = v & this.sp; this.setZN(this.a); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xBC: { const a = this.addrABSX(); this.y = this.read(a); this.setZN(this.y); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xBD: { const a = this.addrABSX(); this.a = this.read(a); this.setZN(this.a); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xBE: { const a = this.addrABSY(); this.x = this.read(a); this.setZN(this.x); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xBF: { const a = this.addrABSY(); this.lax(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }

      // ── 0xC0 block ──────────────────────────────────────────────────────
      case 0xC0: this.cmp(this.y, this.fetch()); this.tStates += 2; break;
      case 0xC1: { const a = this.addrINDX(); this.cmp(this.a, this.read(a)); this.tStates += 6; break; }
      case 0xC2: this.fetch(); this.tStates += 2; break;
      case 0xC3: { const a = this.addrINDX(); const r = this.dec(this.read(a)); this.write(a, r); this.cmp(this.a, r); this.tStates += 8; break; }
      case 0xC4: { const a = this.addrZP(); this.cmp(this.y, this.read(a)); this.tStates += 3; break; }
      case 0xC5: { const a = this.addrZP(); this.cmp(this.a, this.read(a)); this.tStates += 3; break; }
      case 0xC6: { const a = this.addrZP(); this.write(a, this.dec(this.read(a))); this.tStates += 5; break; }
      case 0xC7: { const a = this.addrZP(); const r = this.dec(this.read(a)); this.write(a, r); this.cmp(this.a, r); this.tStates += 5; break; }
      case 0xC8: this.y = this.inc(this.y); this.tStates += 2; break;
      case 0xC9: this.cmp(this.a, this.fetch()); this.tStates += 2; break;
      case 0xCA: this.x = this.dec(this.x); this.tStates += 2; break;
      case 0xCB: this.axs(this.fetch()); this.tStates += 2; break;
      case 0xCC: { const a = this.addrABS(); this.cmp(this.y, this.read(a)); this.tStates += 4; break; }
      case 0xCD: { const a = this.addrABS(); this.cmp(this.a, this.read(a)); this.tStates += 4; break; }
      case 0xCE: { const a = this.addrABS(); this.write(a, this.dec(this.read(a))); this.tStates += 6; break; }
      case 0xCF: { const a = this.addrABS(); const r = this.dec(this.read(a)); this.write(a, r); this.cmp(this.a, r); this.tStates += 6; break; }
      case 0xD0: this.tStates += 2; this.branch(!this.flag(FLAG_Z)); break;
      case 0xD1: { const a = this.addrINDY(); this.cmp(this.a, this.read(a)); this.tStates += 5 + (this.pageCross ? 1 : 0); break; }
      case 0xD3: { const a = this.addrINDY(); const r = this.dec(this.read(a)); this.write(a, r); this.cmp(this.a, r); this.tStates += 8; break; }
      case 0xD4: { this.addrZPX(); this.tStates += 4; break; }
      case 0xD5: { const a = this.addrZPX(); this.cmp(this.a, this.read(a)); this.tStates += 4; break; }
      case 0xD6: { const a = this.addrZPX(); this.write(a, this.dec(this.read(a))); this.tStates += 6; break; }
      case 0xD7: { const a = this.addrZPX(); const r = this.dec(this.read(a)); this.write(a, r); this.cmp(this.a, r); this.tStates += 6; break; }
      case 0xD8: this.setFlag(FLAG_D, false); this.tStates += 2; break;
      case 0xD9: { const a = this.addrABSY(); this.cmp(this.a, this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xDA: this.tStates += 2; break;
      case 0xDB: { const a = this.addrABSY(); const r = this.dec(this.read(a)); this.write(a, r); this.cmp(this.a, r); this.tStates += 7; break; }
      case 0xDC: { this.addrABSX(); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xDD: { const a = this.addrABSX(); this.cmp(this.a, this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xDE: { const a = this.addrABSX(); this.write(a, this.dec(this.read(a))); this.tStates += 7; break; }
      case 0xDF: { const a = this.addrABSX(); const r = this.dec(this.read(a)); this.write(a, r); this.cmp(this.a, r); this.tStates += 7; break; }

      // ── 0xE0 block ──────────────────────────────────────────────────────
      case 0xE0: this.cmp(this.x, this.fetch()); this.tStates += 2; break;
      case 0xE1: { const a = this.addrINDX(); this.sbc(this.read(a)); this.tStates += 6; break; }
      case 0xE2: this.fetch(); this.tStates += 2; break;
      case 0xE3: { const a = this.addrINDX(); const r = this.inc(this.read(a)); this.write(a, r); this.sbc(r); this.tStates += 8; break; }
      case 0xE4: { const a = this.addrZP(); this.cmp(this.x, this.read(a)); this.tStates += 3; break; }
      case 0xE5: { const a = this.addrZP(); this.sbc(this.read(a)); this.tStates += 3; break; }
      case 0xE6: { const a = this.addrZP(); this.write(a, this.inc(this.read(a))); this.tStates += 5; break; }
      case 0xE7: { const a = this.addrZP(); const r = this.inc(this.read(a)); this.write(a, r); this.sbc(r); this.tStates += 5; break; }
      case 0xE8: this.x = this.inc(this.x); this.tStates += 2; break;
      case 0xE9: this.sbc(this.fetch()); this.tStates += 2; break;
      case 0xEA: this.tStates += 2; break;
      case 0xEB: this.sbc(this.fetch()); this.tStates += 2; break;
      case 0xEC: { const a = this.addrABS(); this.cmp(this.x, this.read(a)); this.tStates += 4; break; }
      case 0xED: { const a = this.addrABS(); this.sbc(this.read(a)); this.tStates += 4; break; }
      case 0xEE: { const a = this.addrABS(); this.write(a, this.inc(this.read(a))); this.tStates += 6; break; }
      case 0xEF: { const a = this.addrABS(); const r = this.inc(this.read(a)); this.write(a, r); this.sbc(r); this.tStates += 6; break; }
      case 0xF0: this.tStates += 2; this.branch(this.flag(FLAG_Z)); break;
      case 0xF1: { const a = this.addrINDY(); this.sbc(this.read(a)); this.tStates += 5 + (this.pageCross ? 1 : 0); break; }
      case 0xF3: { const a = this.addrINDY(); const r = this.inc(this.read(a)); this.write(a, r); this.sbc(r); this.tStates += 8; break; }
      case 0xF4: { this.addrZPX(); this.tStates += 4; break; }
      case 0xF5: { const a = this.addrZPX(); this.sbc(this.read(a)); this.tStates += 4; break; }
      case 0xF6: { const a = this.addrZPX(); this.write(a, this.inc(this.read(a))); this.tStates += 6; break; }
      case 0xF7: { const a = this.addrZPX(); const r = this.inc(this.read(a)); this.write(a, r); this.sbc(r); this.tStates += 6; break; }
      case 0xF8: this.setFlag(FLAG_D, true); this.tStates += 2; break;
      case 0xF9: { const a = this.addrABSY(); this.sbc(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xFA: this.tStates += 2; break;
      case 0xFB: { const a = this.addrABSY(); const r = this.inc(this.read(a)); this.write(a, r); this.sbc(r); this.tStates += 7; break; }
      case 0xFC: { this.addrABSX(); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xFD: { const a = this.addrABSX(); this.sbc(this.read(a)); this.tStates += 4 + (this.pageCross ? 1 : 0); break; }
      case 0xFE: { const a = this.addrABSX(); this.write(a, this.inc(this.read(a))); this.tStates += 7; break; }
      case 0xFF: { const a = this.addrABSX(); const r = this.inc(this.read(a)); this.write(a, r); this.sbc(r); this.tStates += 7; break; }

      default:
        this.tStates += 2;
        break;
    }
  }

  // ── Undocumented immediate helpers ────────────────────────────────────────

  /** ALR #: A = (A & imm) >> 1, C = bit 0 of the AND result. */
  private alr(v: number): number {
    const r = (this.a & v) & 0xFF;
    this.setFlag(FLAG_C, (r & 0x01) !== 0);
    const out = (r >> 1) & 0xFF;
    this.setZN(out);
    return out;
  }

  /** ARR #: A = ((A & imm) >> 1) | (C << 7); flags are peculiar. */
  private arr(v: number): number {
    const r = this.a & v;
    const out = ((r >> 1) | (this.flag(FLAG_C) ? 0x80 : 0)) & 0xFF;
    this.setZN(out);
    this.setFlag(FLAG_C, (r & 0x01) !== 0);
    this.setFlag(FLAG_V, (((out >> 6) ^ (out >> 5)) & 1) !== 0);
    return out;
  }

  /** AXS # (a.k.a. SBX): X = (A & X) - imm, no borrow propagation to A. */
  private axs(v: number): void {
    const r = (this.a & this.x) - v;
    this.setFlag(FLAG_C, r >= 0);
    this.x = r & 0xFF;
    this.setZN(this.x);
  }
}
