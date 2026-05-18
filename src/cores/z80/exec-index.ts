import { Z80 } from './core.ts';
import { ddfdUsesHL } from './tables.ts';
import { signed8 } from '@/utils/signed.ts';

Z80.prototype.executeDD = function (this: Z80): void {
  // Inlined fetch8 (+3T M1 read)
  const op = this.read8(this.pc);
  this.pc = (this.pc + 1) & 0xFFFF;
  this.tStates += 3;
  this.contend(this.ir);         // IR contention during refresh (T3-T4)
  this.tStates += 1;             // +1T (M1 refresh)
  this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

  if (op === 0xCB) {
    this.executeDDCB();
    return;
  }

  if (op === 0xDD || op === 0xFD) {
    // DD DD/FD: 8T (4T DD M1 + 4T this M1, both auto-counted)
    this.pc = (this.pc - 1) & 0xFFFF;
    return;
  }

  const savedH = this.h;
  const savedL = this.l;
  this.h = (this.ix >> 8) & 0xFF;
  this.l = this.ix & 0xFF;

  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;

  if (x === 1 && (y === 6 || z === 6) && !(y === 6 && z === 6)) {
    const d = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
    const addr = (this.ix + signed8(d)) & 0xFFFF;
    this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
    this.h = savedH; this.l = savedL;

    if (y === 6) {
      // LD (IX+d),r: 19T, write@T+15. Auto: 8T(DD+op M1) + 3T(d) = 11T
      const val = this.getReg8(z);
      this.tStates += 4;
      this.write8(addr, val);
      this.tStates += 4;
    } else {
      // LD r,(IX+d): 19T, read@T+16. Auto: 8T + 3T(d) = 11T
      this.tStates += 5;
      this.setReg8(y, this.read8(addr));
      this.tStates += 3;
    }
  } else if (x === 2 && z === 6) {
    // ALU A,(IX+d): 19T, read@T+16. Auto: 8T + 3T(d) = 11T
    const d = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
    const addr = (this.ix + signed8(d)) & 0xFFFF;
    this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
    this.h = savedH; this.l = savedL;
    this.tStates += 5;
    this.aluOp(y, this.read8(addr));
    this.tStates += 3;
  } else if (x === 0 && z === 6 && y !== 6) {
    if (op === 0x26 || op === 0x2E) {
      // Undocumented: LD IXH/IXL, nn: 11T. Auto: 8T + 3T(n) = 11T
      const n = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
      if (op === 0x26) {
        this.ix = (n << 8) | (this.ix & 0xFF);
      } else {
        this.ix = (this.ix & 0xFF00) | n;
      }
      this.h = savedH; this.l = savedL;
    } else {
      this.h = savedH; this.l = savedL;
      // DD prefix M1 already auto-counted
      this.executeMain(op);
    }
  } else if (x === 0 && (z === 4 || z === 5) && y === 6) {
    // INC/DEC (IX+d): 23T, read@T+16, write@T+20. Auto: 8T + 3T(d) = 11T
    const d = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
    const addr = (this.ix + signed8(d)) & 0xFFFF;
    this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
    this.h = savedH; this.l = savedL;
    this.tStates += 5;
    const val = this.read8(addr);
    this.tStates += 4;
    this.write8(addr, z === 4 ? this.inc8(val) : this.dec8(val));
    this.tStates += 3;
  } else if (op === 0x36) {
    // LD (IX+d),n: 19T, write@T+15 (duplicate guard). Auto: 8T + 3T(d) + 3T(n) = 14T
    const d = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
    const n = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
    const addr = (this.ix + signed8(d)) & 0xFFFF;
    this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
    this.h = savedH; this.l = savedL;
    this.tStates += 1;
    this.write8(addr, n);
    this.tStates += 4;
  } else if (ddfdUsesHL(op)) {
    // DD prefix M1 already auto-counted
    this.executeMain(op);
    this.ix = (this.h << 8) | this.l;
    this.h = savedH;
    this.l = savedL;
    return;
  } else {
    // Opcode doesn't reference H/L/HL — DD prefix auto-counted
    this.h = savedH;
    this.l = savedL;
    this.executeMain(op);
    return;
  }
};

Z80.prototype.executeFD = function (this: Z80): void {
  // Inlined fetch8 (+3T M1 read)
  const op = this.read8(this.pc);
  this.pc = (this.pc + 1) & 0xFFFF;
  this.tStates += 3;
  this.contend(this.ir);         // IR contention during refresh (T3-T4)
  this.tStates += 1;             // +1T (M1 refresh)
  this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

  if (op === 0xCB) {
    this.executeFDCB();
    return;
  }

  if (op === 0xDD || op === 0xFD) {
    // FD DD/FD: 8T (4T FD M1 + 4T this M1, both auto-counted)
    this.pc = (this.pc - 1) & 0xFFFF;
    return;
  }

  const savedH = this.h;
  const savedL = this.l;
  this.h = (this.iy >> 8) & 0xFF;
  this.l = this.iy & 0xFF;

  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;

  if (x === 1 && (y === 6 || z === 6) && !(y === 6 && z === 6)) {
    const d = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
    const addr = (this.iy + signed8(d)) & 0xFFFF;
    this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
    this.h = savedH; this.l = savedL;
    if (y === 6) {
      // LD (IY+d),r: 19T, write@T+15. Auto: 8T + 3T(d) = 11T
      const val = this.getReg8(z);
      this.tStates += 4;
      this.write8(addr, val);
      this.tStates += 4;
    } else {
      // LD r,(IY+d): 19T, read@T+16. Auto: 8T + 3T(d) = 11T
      this.tStates += 5;
      this.setReg8(y, this.read8(addr));
      this.tStates += 3;
    }
  } else if (x === 2 && z === 6) {
    // ALU A,(IY+d): 19T, read@T+16. Auto: 8T + 3T(d) = 11T
    const d = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
    const addr = (this.iy + signed8(d)) & 0xFFFF;
    this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
    this.h = savedH; this.l = savedL;
    this.tStates += 5;
    this.aluOp(y, this.read8(addr));
    this.tStates += 3;
  } else if (x === 0 && z === 6 && y !== 6) {
    if (op === 0x26 || op === 0x2E) {
      // Undocumented: LD IYH/IYL, nn: 11T. Auto: 8T + 3T(n) = 11T
      const n = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
      if (op === 0x26) {
        this.iy = (n << 8) | (this.iy & 0xFF);
      } else {
        this.iy = (this.iy & 0xFF00) | n;
      }
      this.h = savedH; this.l = savedL;
    } else {
      this.h = savedH; this.l = savedL;
      // FD prefix M1 already auto-counted
      this.executeMain(op);
    }
  } else if (x === 0 && (z === 4 || z === 5) && y === 6) {
    // INC/DEC (IY+d): 23T, read@T+16, write@T+20. Auto: 8T + 3T(d) = 11T
    const d = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
    const addr = (this.iy + signed8(d)) & 0xFFFF;
    this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
    this.h = savedH; this.l = savedL;
    this.tStates += 5;
    const val = this.read8(addr);
    this.tStates += 4;
    this.write8(addr, z === 4 ? this.inc8(val) : this.dec8(val));
    this.tStates += 3;
  } else if (op === 0x36) {
    // LD (IY+d),n: 19T, write@T+15 (duplicate guard). Auto: 8T + 3T(d) + 3T(n) = 14T
    const d = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
    const n = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
    const addr = (this.iy + signed8(d)) & 0xFFFF;
    this.memptr = addr;  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
    this.h = savedH; this.l = savedL;
    this.tStates += 1;
    this.write8(addr, n);
    this.tStates += 4;
  } else if (ddfdUsesHL(op)) {
    // FD prefix M1 already auto-counted
    this.executeMain(op);
    this.iy = (this.h << 8) | this.l;
    this.h = savedH;
    this.l = savedL;
    return;
  } else {
    // Opcode doesn't reference H/L/HL — FD prefix auto-counted
    this.h = savedH;
    this.l = savedL;
    this.executeMain(op);
    return;
  }
};

Z80.prototype.executeDDCB = function (this: Z80): void {
  const d = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
  const addr = (this.ix + signed8(d)) & 0xFFFF;
  const op = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
  this._executeIndexCB(addr, op);
};

Z80.prototype.executeFDCB = function (this: Z80): void {
  const d = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
  const addr = (this.iy + signed8(d)) & 0xFFFF;
  const op = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.tStates += 3;
  this._executeIndexCB(addr, op);
};

Z80.prototype._executeIndexCB = function (this: Z80, addr: number, op: number): void {
  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;

  // Any instruction with (INDEX+d): MEMPTR = INDEX+d
  this.memptr = addr;

  // DDCB/FDCB: read@T+16, write@T+20 (23T), BIT: read@T+16 (20T)
  // Auto: 4T(DD/FD M1) + 4T(CB M1) + 3T(d) + 3T(op) = 14T; +2T internal at op addr
  { const opAddr = (this.pc - 1) & 0xFFFF;
    this.contend(opAddr); this.tStates += 1;
    this.contend(opAddr); this.tStates += 1; }
  let val = this.read8(addr);

  switch (x) {
    case 0:
      switch (y) {
        case 0: val = this.rlc(val); break;
        case 1: val = this.rrc(val); break;
        case 2: val = this.rl(val); break;
        case 3: val = this.rr(val); break;
        case 4: val = this.sla(val); break;
        case 5: val = this.sra(val); break;
        case 6: val = this.sll(val); break;
        case 7: val = this.srl(val); break;
      }
      this.tStates += 3;
      this.contend(addr); this.tStates += 1;
      this.write8(addr, val);
      if (z !== 6) this.setReg8(z, val);
      this.tStates += 3;
      break;

    case 1:
      this.bit(y, val);
      // BIT n,(IX+d) / BIT n,(IY+d): undocumented flags from MEMPTR high byte
      this.f = (this.f & ~0x28) | ((this.memptr >> 8) & 0x28);
      this._qReg = this.f;
      this.tStates += 3;
      this.contend(addr); this.tStates += 1;
      break;

    case 2:
      val &= ~(1 << y);
      this.tStates += 3;
      this.contend(addr); this.tStates += 1;
      this.write8(addr, val);
      if (z !== 6) this.setReg8(z, val);
      this.tStates += 3;
      break;

    case 3:
      val |= (1 << y);
      this.tStates += 3;
      this.contend(addr); this.tStates += 1;
      this.write8(addr, val);
      if (z !== 6) this.setReg8(z, val);
      this.tStates += 3;
      break;
  }
};

declare module './core.ts' {
  interface Z80 {
    executeDD(): void;
    executeFD(): void;
    executeDDCB(): void;
    executeFDCB(): void;
    _executeIndexCB(addr: number, op: number): void;
  }
}
