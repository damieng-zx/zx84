import { Z80 } from './core.ts';
import { SZP } from './tables.ts';
import { contendN } from './contention.ts';
import { signed8 } from '@/utils/signed.ts';

Z80.prototype.executeMain = function (this: Z80, opcode: number): void {
  const x = (opcode >> 6) & 3;
  const y = (opcode >> 3) & 7;
  const z = opcode & 7;
  const p = (y >> 1) & 3;
  const q = y & 1;

  switch (x) {
    case 0:
      switch (z) {
        case 0:
          switch (y) {
            case 0:
              // NOP: 4T (M1 auto-counted)
              break;
            case 1: {
              // EX AF,AF': 4T (M1 auto-counted)
              let tmp: number;
              tmp = this.a; this.a = this.a_; this.a_ = tmp;
              tmp = this.f; this.f = this.f_; this.f_ = tmp;
              break;
            }
            case 2: {
              // DJNZ: 13T/8T. Auto: 4T M1
              this.contend(this.ir); this.tStates += 1;  // internal cycle at IR
              this.b = (this.b - 1) & 0xFF;
              const offsetAddr2 = this.pc;
              const offset = this.fetch8();  // 3T
              if (this.b !== 0) {
                contendN(this, offsetAddr2, 5);
                this.pc = (this.pc + signed8(offset)) & 0xFFFF;
                this.memptr = this.pc;  // DJNZ (taken): MEMPTR = jump target
              }
              break;
            }
            case 3: {
              // JR: 12T. Auto: 4T M1
              const offsetAddr3 = this.pc;
              const offset = this.fetch8();  // 3T
              contendN(this, offsetAddr3, 5);
              this.pc = (this.pc + signed8(offset)) & 0xFFFF;
              this.memptr = this.pc;  // JR: MEMPTR = jump target
              break;
            }
            default: {
              // JR cc: 12T/7T. Auto: 4T M1
              const offsetAddrCC = this.pc;
              const offset = this.fetch8();  // 3T
              if (this.checkCondition(y - 4)) {
                contendN(this, offsetAddrCC, 5);
                this.pc = (this.pc + signed8(offset)) & 0xFFFF;
                this.memptr = this.pc;  // JR cc (taken): MEMPTR = jump target
              }
              break;
            }
          }
          break;

        case 1:
          if (q === 0) {
            // LD rr,nn: 10T. Auto: 4T M1 + 6T fetch16 = 10T
            this.setReg16(p, this.fetch16());
          } else {
            // ADD HL,rr: 11T. Auto: 4T M1
            contendN(this, this.ir, 7);
            this.hl = this.add16(this.hl, this.getReg16(p));
          }
          break;

        case 2:
          if (q === 0) {
            // Write instructions — M1 auto-counted (4T), contention at correct sub-cycle
            switch (p) {
              case 0: this.write8(this.bc, this.a); this.memptr = ((this.bc + 1) & 0xFF) | (this.a << 8); this.tStates += 3; break;  // LD (BC),A: 7T, write@T+4
              case 1: this.write8(this.de, this.a); this.memptr = ((this.de + 1) & 0xFF) | (this.a << 8); this.tStates += 3; break;  // LD (DE),A: 7T, write@T+4
              case 2: { const addr = this.fetch16(); this.write16(addr, this.hl); this.memptr = (addr + 1) & 0xFFFF; this.tStates += 3; break; }  // LD (nn),HL: 16T, writes@T+10,T+13
              case 3: { const addr = this.fetch16(); this.write8(addr, this.a); this.memptr = ((addr + 1) & 0xFF) | (this.a << 8); this.tStates += 3; break; }    // LD (nn),A: 13T, write@T+10
            }
          } else {
            // Read instructions — M1 auto-counted (4T), contention at correct sub-cycle
            switch (p) {
              case 0: this.a = this.read8(this.bc); this.memptr = (this.bc + 1) & 0xFFFF; this.tStates += 3; break;  // LD A,(BC): 7T, read@T+4
              case 1: this.a = this.read8(this.de); this.memptr = (this.de + 1) & 0xFFFF; this.tStates += 3; break;  // LD A,(DE): 7T, read@T+4
              case 2: { const addr = this.fetch16(); this.hl = this.read16(addr); this.memptr = (addr + 1) & 0xFFFF; this.tStates += 3; break; }  // LD HL,(nn): 16T, reads@T+10,T+13
              case 3: { const addr = this.fetch16(); this.a = this.read8(addr); this.memptr = (addr + 1) & 0xFFFF; this.tStates += 3; break; }    // LD A,(nn): 13T, read@T+10
            }
          }
          break;

        case 3:
          // INC/DEC rr: 6T. Auto: 4T M1
          contendN(this, this.ir, 2);
          if (q === 0) {
            this.setReg16(p, (this.getReg16(p) + 1) & 0xFFFF);
          } else {
            this.setReg16(p, (this.getReg16(p) - 1) & 0xFFFF);
          }
          break;

        case 4: {
          if (y === 6) {
            // INC (HL): 11T, read@T+4, write@T+8. Auto: 4T M1
            const val = this.read8(this.hl);
            this.tStates += 3;
            this.contend(this.hl); this.tStates += 1;
            this.write8(this.hl, this.inc8(val));
            this.tStates += 3;
          } else {
            // INC r: 4T (M1 auto-counted)
            this.setReg8(y, this.inc8(this.getReg8(y)));
          }
          break;
        }

        case 5: {
          if (y === 6) {
            // DEC (HL): 11T, read@T+4, write@T+8. Auto: 4T M1
            const val = this.read8(this.hl);
            this.tStates += 3;
            this.contend(this.hl); this.tStates += 1;
            this.write8(this.hl, this.dec8(val));
            this.tStates += 3;
          } else {
            // DEC r: 4T (M1 auto-counted)
            this.setReg8(y, this.dec8(this.getReg8(y)));
          }
          break;
        }

        case 6:
          if (y === 6) {
            // LD (HL),n: 10T, write@T+7. Auto: 4T M1 + 3T operand = 7T
            const n = this.fetch8();
            this.write8(this.hl, n);
            this.tStates += 3;
          } else {
            // LD r,n: 7T. Auto: 4T M1 + 3T operand = 7T
            this.setReg8(y, this.fetch8());
          }
          break;

        case 7:
          switch (y) {
            case 0: {
              const c = (this.a >> 7) & 1;
              this.a = ((this.a << 1) | c) & 0xFF;
              this.f = (this.f & 0xC4) | c | (this.a & 0x28);
              this._qReg = this.f;
              break;
            }
            case 1: {
              const c = this.a & 1;
              this.a = ((this.a >> 1) | (c << 7)) & 0xFF;
              this.f = (this.f & 0xC4) | c | (this.a & 0x28);
              this._qReg = this.f;
              break;
            }
            case 2: {
              const oldC = this.f & 0x01;
              const c = (this.a >> 7) & 1;
              this.a = ((this.a << 1) | oldC) & 0xFF;
              this.f = (this.f & 0xC4) | c | (this.a & 0x28);
              this._qReg = this.f;
              break;
            }
            case 3: {
              const oldC = this.f & 0x01;
              const c = this.a & 1;
              this.a = ((this.a >> 1) | (oldC << 7)) & 0xFF;
              this.f = (this.f & 0xC4) | c | (this.a & 0x28);
              this._qReg = this.f;
              break;
            }
            case 4: {
              // DAA - Decimal Adjust Accumulator (from floooh/rz80)
              const origA = this.a;
              let val = origA;
              const f = this.f;

              if (f & 0x02) {
                // After subtraction (N flag set)
                if (((origA & 0x0F) > 0x09) || (f & 0x10)) {
                  val = (val - 0x06) & 0xFF;
                }
                if ((origA > 0x99) || (f & 0x01)) {
                  val = (val - 0x60) & 0xFF;
                }
              } else {
                // After addition (N flag clear)
                if (((origA & 0x0F) > 0x09) || (f & 0x10)) {
                  val = (val + 0x06) & 0xFF;
                }
                if ((origA > 0x99) || (f & 0x01)) {
                  val = (val + 0x60) & 0xFF;
                }
              }

              // Set flags: preserve C and N, set new C if needed, H from XOR, then S/Z/P
              this.f = (f & 0x03) |                        // Preserve C and N
                       (origA > 0x99 ? 0x01 : 0) |         // Set C if A > 0x99
                       ((origA ^ val) & 0x10) |            // H flag from bit 4 change
                       SZP[val];                           // S, Z, undoc bits 3,5, P/V
              this.a = val;
              this._qReg = this.f;
              break;
            }
            case 5:
              // CPL
              this.a ^= 0xFF;
              this.f = (this.f & 0xC5) | 0x12 | (this.a & 0x28);
              this._qReg = this.f;
              break;
            case 6: {
              // SCF - Set Carry Flag (Q register: bits 3,5 from ((prevQ^F)|A))
              const bits35 = ((this._prevQ ^ this.f) | this.a) & 0x28;
              this.f = (this.f & 0xC4) | 0x01 | bits35;
              this._qReg = this.f;
              break;
            }
            case 7: {
              // CCF - Complement Carry Flag (Q register: bits 3,5 from ((prevQ^F)|A))
              const bits35 = ((this._prevQ ^ this.f) | this.a) & 0x28;
              this.f = (this.f & 0xC4) | ((this.f & 0x01) << 4) | bits35 | ((this.f & 0x01) ^ 0x01);
              this._qReg = this.f;
              break;
            }
          }
          // 4T instructions (M1 auto-counted)
          break;
      }
      break;

    case 1:
      if (y === 6 && z === 6) {
        // HALT: 4T (M1 auto-counted)
        this.halted = true;
      } else if (y === 6) {
        // LD (HL),r: 7T, write@T+4. Auto: 4T M1
        const val = this.getReg8(z);
        this.write8(this.hl, val);
        this.tStates += 3;
      } else if (z === 6) {
        // LD r,(HL): 7T, read@T+4. Auto: 4T M1
        this.setReg8(y, this.read8(this.hl));
        this.tStates += 3;
      } else {
        // LD r,r: 4T (M1 auto-counted)
        this.setReg8(y, this.getReg8(z));
      }
      break;

    case 2:
      if (z === 6) {
        // ALU A,(HL): 7T, read@T+4. Auto: 4T M1
        this.aluOp(y, this.read8(this.hl));
        this.tStates += 3;
      } else {
        // ALU A,r: 4T (M1 auto-counted)
        this.aluOp(y, this.getReg8(z));
      }
      break;

    case 3:
      switch (z) {
        case 0:
          // RET cc: 11T/5T. Auto: 4T M1
          this.contend(this.ir); this.tStates += 1;  // internal cycle at IR
          if (this.checkCondition(y)) {
            this.memptr = this.pc = this.pop16();  // RET: MEMPTR = PC = target
            this.tStates += 3;
          }
          break;

        case 1:
          if (q === 0) {
            // POP qq: 10T, reads@T+4,T+7. Auto: 4T M1
            this.setReg16AF(p, this.pop16());
            this.tStates += 3;
          } else {
            switch (p) {
              case 0:
                // RET: 10T, reads@T+4,T+7. Auto: 4T M1
                this.memptr = this.pc = this.pop16();  // RET: MEMPTR = PC = target
                this.tStates += 3;
                break;
              case 1: {
                // EXX: 4T (M1 auto-counted)
                let tmp: number;
                tmp = this.b; this.b = this.b_; this.b_ = tmp;
                tmp = this.c; this.c = this.c_; this.c_ = tmp;
                tmp = this.d; this.d = this.d_; this.d_ = tmp;
                tmp = this.e; this.e = this.e_; this.e_ = tmp;
                tmp = this.h; this.h = this.h_; this.h_ = tmp;
                tmp = this.l; this.l = this.l_; this.l_ = tmp;
                break;
              }
              case 2:
                // JP (HL): 4T (M1 auto-counted)
                this.pc = this.hl;
                break;
              case 3:
                // LD SP,HL: 6T. Auto: 4T M1
                contendN(this, this.ir, 2);
                this.sp = this.hl;
                break;
            }
          }
          break;

        case 2: {
          // JP cc,nn: 10T. Auto: 4T M1 + 6T fetch16 = 10T
          const addr = this.fetch16();
          this.memptr = addr;  // Always set MEMPTR, even if jump not taken
          if (this.checkCondition(y)) {
            this.pc = addr;
          }
          break;
        }

        case 3:
          switch (y) {
            case 0:
              // JP nn: 10T. Auto: 4T M1 + 6T fetch16 = 10T
              this.memptr = this.pc = this.fetch16();
              break;
            case 1:
              this.executeCB();
              break;
            case 2: {
              // OUT (n),A: 11T. Auto: 4T M1 + 3T operand = 7T
              const port = (this.a << 8) | this.fetch8();
              this.portOut(port, this.a);
              this.memptr = ((port + 1) & 0xFF) | (this.a << 8);  // OUT (port),A: MEMPTR_low = (port+1) & 0xFF, MEMPTR_hi = A
              this.tStates += 4;
              break;
            }
            case 3: {
              // IN A,(n): 11T. Auto: 4T M1 + 3T operand = 7T.
              // The Z80 places the port address on the bus at T+7 and
              // samples the data at T+10 (end of the IORQ + wait cycles).
              // We tick 3T BEFORE portIn so the tape engine and ULA see
              // the correct sample point — without this, tight tape
              // loaders mis-classify the occasional bit when an edge
              // falls inside the IORQ window. The remaining 1T closes
              // the instruction. Total still 11T.
              const aBeforeOp = this.a;
              const portLow = this.fetch8();
              const port = (this.a << 8) | portLow;
              this.tStates += 3;
              this.a = this.portIn(port);
              this.memptr = ((aBeforeOp << 8) + portLow + 1) & 0xFFFF;  // IN A,(port): MEMPTR = (A_before << 8) + port_low + 1
              this.tStates += 1;
              break;
            }
            case 4: {
              // EX (SP),HL: 19T, reads@T+4/T+7, writes@T+11/T+14. Auto: 4T M1
              const lo = this.read8(this.sp);
              this.tStates += 3;
              const sp1 = (this.sp + 1) & 0xFFFF;
              const hi = this.read8(sp1);
              this.tStates += 3;
              this.contend(sp1); this.tStates += 1;  // internal at SP+1
              this.write8(sp1, this.h);  // write high first (real Z80 order)
              this.tStates += 3;
              this.write8(this.sp, this.l);
              this.tStates += 3;
              this.contend(this.sp); this.tStates += 1;  // internal at SP
              this.contend(this.sp); this.tStates += 1;  // internal at SP
              this.l = lo; this.h = hi;
              this.memptr = (hi << 8) | lo;  // EX (SP),rp: MEMPTR = rp value after the operation
              break;
            }
            case 5: {
              // EX DE,HL: 4T (M1 auto-counted)
              const tmp = this.de;
              this.de = this.hl;
              this.hl = tmp;
              break;
            }
            case 6:
              // DI: 4T (M1 auto-counted)
              this.iff1 = false;
              this.iff2 = false;
              break;
            case 7:
              // EI: 4T (M1 auto-counted)
              // Real Z80 suppresses interrupts for one instruction after EI.
              // The run loop clears eiDelay after the *next* instruction.
              this.iff1 = true;
              this.iff2 = true;
              this.eiDelay = true;
              break;
          }
          break;

        case 4: {
          // CALL cc,nn: 17T/10T. Auto: 4T M1 + 6T fetch16 = 10T
          const addr = this.fetch16();
          this.memptr = addr;  // Always set MEMPTR, even if call not made
          if (this.checkCondition(y)) {
            // CALL cc,nn (true): 17T, writes@T+11,T+14
            this.contend((this.pc - 1) & 0xFFFF); this.tStates += 1;  // internal at high-byte addr
            this.push16(this.pc);
            this.pc = addr;
            this.tStates += 3;
          }
          break;
        }

        case 5:
          if (q === 0) {
            // PUSH qq: 11T, writes@T+5,T+8. Auto: 4T M1
            this.contend(this.ir); this.tStates += 1;  // internal at IR
            this.push16(this.getReg16AF(p));
            this.tStates += 3;
          } else {
            switch (p) {
              case 0: {
                // CALL nn: 17T, writes@T+11,T+14. Auto: 4T M1 + 6T fetch16 = 10T
                const addr = this.fetch16();
                this.contend((this.pc - 1) & 0xFFFF); this.tStates += 1;  // internal at high-byte addr
                this.push16(this.pc);
                this.memptr = this.pc = addr;  // CALL: MEMPTR = PC = target
                this.tStates += 3;
                break;
              }
              case 1:
                this.executeDD();
                break;
              case 2:
                this.executeED();
                break;
              case 3:
                this.executeFD();
                break;
            }
          }
          break;

        case 6: {
          // ALU A,n: 7T. Auto: 4T M1 + 3T operand = 7T
          const val = this.fetch8();
          this.aluOp(y, val);
          break;
        }

        case 7:
          // RST: 11T, writes@T+5,T+8. Auto: 4T M1
          this.contend(this.ir); this.tStates += 1;  // internal at IR
          this.push16(this.pc);
          this.memptr = this.pc = y * 8;
          this.tStates += 3;
          break;
      }
      break;
  }
};

declare module './core.ts' {
  interface Z80 {
    executeMain(opcode: number): void;
  }
}
