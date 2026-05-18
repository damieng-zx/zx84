import { Z80 } from './core.ts';
import { SZ, SZP } from './tables.ts';

// --- 8-bit ALU operations ---

Z80.prototype.add8 = function (this: Z80, a: number, b: number): number {
  const result = a + b;
  const r8 = result & 0xFF;
  this.f = SZ[r8] |
           (result > 0xFF ? 0x01 : 0) |
           ((a ^ b ^ r8) & 0x10) |
           (((a ^ ~b) & (a ^ r8) & 0x80) ? 0x04 : 0);
  this._qReg = this.f;
  return r8;
};

Z80.prototype.adc8 = function (this: Z80, a: number, b: number): number {
  const c = this.f & 0x01;
  const result = a + b + c;
  const r8 = result & 0xFF;
  this.f = SZ[r8] |
           (result > 0xFF ? 0x01 : 0) |
           ((a ^ b ^ r8) & 0x10) |
           (((a ^ ~b) & (a ^ r8) & 0x80) ? 0x04 : 0);
  this._qReg = this.f;
  return r8;
};

Z80.prototype.sub8 = function (this: Z80, a: number, b: number): number {
  const result = a - b;
  const r8 = result & 0xFF;
  this.f = SZ[r8] |
           0x02 |
           (result < 0 ? 0x01 : 0) |
           ((a ^ b ^ r8) & 0x10) |
           (((a ^ b) & (a ^ r8) & 0x80) ? 0x04 : 0);
  this._qReg = this.f;
  return r8;
};

Z80.prototype.sbc8 = function (this: Z80, a: number, b: number): number {
  const c = this.f & 0x01;
  const result = a - b - c;
  const r8 = result & 0xFF;
  this.f = SZ[r8] |
           0x02 |
           (result < 0 ? 0x01 : 0) |
           ((a ^ b ^ r8) & 0x10) |
           (((a ^ b) & (a ^ r8) & 0x80) ? 0x04 : 0);
  this._qReg = this.f;
  return r8;
};

Z80.prototype.and8 = function (this: Z80, val: number): void {
  this.a &= val;
  this.f = SZP[this.a] | 0x10;
  this._qReg = this.f;
};

Z80.prototype.or8 = function (this: Z80, val: number): void {
  this.a |= val;
  this.f = SZP[this.a];
  this._qReg = this.f;
};

Z80.prototype.xor8 = function (this: Z80, val: number): void {
  this.a ^= val;
  this.f = SZP[this.a];
  this._qReg = this.f;
};

Z80.prototype.cp8 = function (this: Z80, val: number): void {
  const result = this.a - val;
  const r8 = result & 0xFF;
  this.f = (r8 & 0x80) |
           (r8 === 0 ? 0x40 : 0) |
           (val & 0x28) |
           0x02 |
           (result < 0 ? 0x01 : 0) |
           ((this.a ^ val ^ r8) & 0x10) |
           (((this.a ^ val) & (this.a ^ r8) & 0x80) ? 0x04 : 0);
  this._qReg = this.f;
};

Z80.prototype.inc8 = function (this: Z80, val: number): number {
  const r = (val + 1) & 0xFF;
  this.f = (this.f & 0x01) |
           SZ[r] |
           ((val & 0x0F) === 0x0F ? 0x10 : 0) |
           (val === 0x7F ? 0x04 : 0);
  this._qReg = this.f;
  return r;
};

Z80.prototype.dec8 = function (this: Z80, val: number): number {
  const r = (val - 1) & 0xFF;
  this.f = (this.f & 0x01) |
           SZ[r] |
           0x02 |
           ((val & 0x0F) === 0x00 ? 0x10 : 0) |
           (val === 0x80 ? 0x04 : 0);
  this._qReg = this.f;
  return r;
};

// --- 16-bit ALU operations ---

Z80.prototype.add16 = function (this: Z80, a: number, b: number): number {
  const result = a + b;
  this.memptr = (a + 1) & 0xFFFF;  // MEMPTR = original value + 1
  this.f = (this.f & 0xC4) |
           ((result >> 16) & 0x01) |
           (((a ^ b ^ result) >> 8) & 0x10) |
           ((result >> 8) & 0x28);  // Undoc flags from result high byte
  this._qReg = this.f;
  return result & 0xFFFF;
};

Z80.prototype.adc16 = function (this: Z80, a: number, b: number): number {
  const c = this.f & 0x01;
  const result = a + b + c;
  const r16 = result & 0xFFFF;
  this.memptr = (a + 1) & 0xFFFF;  // MEMPTR = original value + 1
  this.f = ((r16 >> 8) & 0x80) |
           (r16 === 0 ? 0x40 : 0) |
           ((r16 >> 8) & 0x28) |  // Undoc flags from result high byte
           ((result >> 16) & 0x01) |
           (((a ^ b ^ r16) >> 8) & 0x10) |
           (((a ^ ~b) & (a ^ r16) & 0x8000) ? 0x04 : 0);
  this._qReg = this.f;
  return r16;
};

Z80.prototype.sbc16 = function (this: Z80, a: number, b: number): number {
  const c = this.f & 0x01;
  const result = a - b - c;
  const r16 = result & 0xFFFF;
  this.memptr = (a + 1) & 0xFFFF;  // MEMPTR = original value + 1
  this.f = ((r16 >> 8) & 0x80) |
           (r16 === 0 ? 0x40 : 0) |
           ((r16 >> 8) & 0x28) |  // Undoc flags from result high byte
           0x02 |
           (result < 0 ? 0x01 : 0) |
           (((a ^ b ^ r16) >> 8) & 0x10) |
           (((a ^ b) & (a ^ r16) & 0x8000) ? 0x04 : 0);
  this._qReg = this.f;
  return r16;
};

// --- ALU dispatch (used by base and indexed prefixes) ---

Z80.prototype.aluOp = function (this: Z80, op: number, val: number): void {
  switch (op) {
    case 0: this.a = this.add8(this.a, val); break;
    case 1: this.a = this.adc8(this.a, val); break;
    case 2: this.a = this.sub8(this.a, val); break;
    case 3: this.a = this.sbc8(this.a, val); break;
    case 4: this.and8(val); break;
    case 5: this.xor8(val); break;
    case 6: this.or8(val); break;
    case 7: this.cp8(val); break;
  }
};

declare module './core.ts' {
  interface Z80 {
    add8(a: number, b: number): number;
    adc8(a: number, b: number): number;
    sub8(a: number, b: number): number;
    sbc8(a: number, b: number): number;
    and8(val: number): void;
    or8(val: number): void;
    xor8(val: number): void;
    cp8(val: number): void;
    inc8(val: number): number;
    dec8(val: number): number;
    add16(a: number, b: number): number;
    adc16(a: number, b: number): number;
    sbc16(a: number, b: number): number;
    aluOp(op: number, val: number): void;
  }
}
