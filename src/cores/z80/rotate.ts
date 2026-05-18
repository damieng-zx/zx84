import { Z80 } from './core.ts';
import { SZP } from './tables.ts';

Z80.prototype.rlc = function (this: Z80, val: number): number {
  const c = (val >> 7) & 1;
  const r = ((val << 1) | c) & 0xFF;
  this.f = SZP[r] | c;
  this._qReg = this.f;
  return r;
};

Z80.prototype.rrc = function (this: Z80, val: number): number {
  const c = val & 1;
  const r = ((val >> 1) | (c << 7)) & 0xFF;
  this.f = SZP[r] | c;
  this._qReg = this.f;
  return r;
};

Z80.prototype.rl = function (this: Z80, val: number): number {
  const oldC = this.f & 0x01;
  const c = (val >> 7) & 1;
  const r = ((val << 1) | oldC) & 0xFF;
  this.f = SZP[r] | c;
  this._qReg = this.f;
  return r;
};

Z80.prototype.rr = function (this: Z80, val: number): number {
  const oldC = this.f & 0x01;
  const c = val & 1;
  const r = ((val >> 1) | (oldC << 7)) & 0xFF;
  this.f = SZP[r] | c;
  this._qReg = this.f;
  return r;
};

Z80.prototype.sla = function (this: Z80, val: number): number {
  const c = (val >> 7) & 1;
  const r = (val << 1) & 0xFF;
  this.f = SZP[r] | c;
  this._qReg = this.f;
  return r;
};

Z80.prototype.sra = function (this: Z80, val: number): number {
  const c = val & 1;
  const r = ((val >> 1) | (val & 0x80)) & 0xFF;
  this.f = SZP[r] | c;
  this._qReg = this.f;
  return r;
};

Z80.prototype.srl = function (this: Z80, val: number): number {
  const c = val & 1;
  const r = (val >> 1) & 0xFF;
  this.f = SZP[r] | c;
  this._qReg = this.f;
  return r;
};

Z80.prototype.sll = function (this: Z80, val: number): number {
  const c = (val >> 7) & 1;
  const r = ((val << 1) | 1) & 0xFF;
  this.f = SZP[r] | c;
  this._qReg = this.f;
  return r;
};

Z80.prototype.bit = function (this: Z80, n: number, val: number): void {
  const r = val & (1 << n);
  this.f = (this.f & 0x01) |         // Preserve C
           0x10 |                     // Set H
           (r ? 0 : 0x44) |           // Set Z and P/V if bit is 0
           (r & 0x80) |               // Set S if testing bit 7 and it's set
           (val & 0x28);              // Copy bits 3,5 from value (undocumented X,Y flags)
  // N flag (bit 1) is implicitly cleared since we don't set it
  this._qReg = this.f;
};

declare module './core.ts' {
  interface Z80 {
    rlc(val: number): number;
    rrc(val: number): number;
    rl(val: number): number;
    rr(val: number): number;
    sla(val: number): number;
    sra(val: number): number;
    srl(val: number): number;
    sll(val: number): number;
    bit(n: number, val: number): void;
  }
}
