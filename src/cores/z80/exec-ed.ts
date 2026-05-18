import { Z80 } from './core.ts';
import { SZ, SZP } from './tables.ts';
import { contendN } from './contention.ts';

Z80.prototype.executeED = function (this: Z80): void {
  // Inlined fetch8 (ED M1 read, +3T)
  const op = this.read8(this.pc);
  this.pc = (this.pc + 1) & 0xFFFF;
  this.tStates += 3;
  this.contend(this.ir);         // IR contention during refresh (T3-T4)
  this.tStates += 1;             // +1T (M1 refresh)
  this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;
  const p = (y >> 1) & 3;
  const q = y & 1;

  if (x === 1) {
    switch (z) {
      case 0: {
        // IN r,(C): 12T. Auto: 8T
        const val = this.portIn(this.bc);
        this.memptr = (this.bc + 1) & 0xFFFF;  // IN r,(C): MEMPTR = BC + 1
        if (y !== 6) {
          this.setReg8(y, val);
        }
        this.f = (this.f & 0x01) | SZP[val];
        this._qReg = this.f;
        this.tStates += 4;
        break;
      }

      case 1:
        // OUT (C),r: 12T. Auto: 8T
        this.portOut(this.bc, y === 6 ? 0 : this.getReg8(y));
        this.memptr = (this.bc + 1) & 0xFFFF;  // OUT (C),r: MEMPTR = BC + 1
        this.tStates += 4;
        break;

      case 2:
        // SBC/ADC HL,rr: 15T. Auto: 8T
        if (q === 0) {
          contendN(this, this.ir, 7);
          this.hl = this.sbc16(this.hl, this.getReg16(p));
        } else {
          contendN(this, this.ir, 7);
          this.hl = this.adc16(this.hl, this.getReg16(p));
        }
        break;

      case 3: {
        // ED LD (nn),rr / LD rr,(nn): 20T. Auto: 8T + 6T fetch16 = 14T
        // Inlined fetch16 (two +3T reads)
        const addrLo = this.read8(this.pc);
        this.pc = (this.pc + 1) & 0xFFFF;
        this.tStates += 3;
        const addrHi = this.read8(this.pc);
        this.pc = (this.pc + 1) & 0xFFFF;
        this.tStates += 3;
        const addr = (addrHi << 8) | addrLo;
        this.memptr = (addr + 1) & 0xFFFF;  // LD rp,(addr) / LD (addr),rp: MEMPTR = addr + 1
        if (q === 0) {
          // ED LD (nn),rr: writes@T+14,T+17
          this.write16(addr, this.getReg16(p));
          this.tStates += 3;
        } else {
          // ED LD rr,(nn): reads@T+14,T+17
          this.setReg16(p, this.read16(addr));
          this.tStates += 3;
        }
        break;
      }

      case 4: {
        // NEG: 8T (auto-counted)
        const old = this.a;
        this.a = this.sub8(0, old);
        break;
      }

      case 5:
        // RETI/RETN: 14T, reads@T+8,T+11. Auto: 8T
        this.memptr = this.pc = this.pop16();  // RETI/RETN: MEMPTR = PC = target
        this.iff1 = this.iff2;  // Restore interrupt state
        this.tStates += 3;
        break;

      case 6:
        // IM n: 8T (auto-counted)
        switch (y & 3) {
          case 0: case 1: this.im = 0; break;
          case 2: this.im = 1; break;
          case 3: this.im = 2; break;
        }
        break;

      case 7:
        switch (y) {
          case 0:
            // LD I,A: 9T. Auto: 8T
            this.contend(this.ir); this.tStates += 1;
            this.i = this.a;
            break;
          case 1:
            // LD R,A: 9T. Auto: 8T
            // All 8 bits of A are copied to R (including bit 7)
            this.contend(this.ir); this.tStates += 1;
            this.r = this.a;
            break;
          case 2:
            // LD A,I: 9T. Auto: 8T
            this.contend(this.ir); this.tStates += 1;
            this.a = this.i;
            this.f = (this.f & 0x01) | SZ[this.a] | (this.iff2 ? 0x04 : 0);
            this._qReg = this.f;
            break;
          case 3:
            // LD A,R: 9T. Auto: 8T
            this.contend(this.ir); this.tStates += 1;
            this.a = this.r;
            this.f = (this.f & 0x01) | SZ[this.a] | (this.iff2 ? 0x04 : 0);
            this._qReg = this.f;
            break;
          case 4: {
            // RRD: 18T, read@T+8, write@T+15. Auto: 8T
            const hlVal = this.read8(this.hl);
            this.tStates += 3;  // read cycle
            contendN(this, this.hl, 4);
            const newHL = ((this.a & 0x0F) << 4) | (hlVal >> 4);
            this.a = (this.a & 0xF0) | (hlVal & 0x0F);
            this.f = (this.f & 0x01) | SZP[this.a];
            this._qReg = this.f;
            this.memptr = (this.hl + 1) & 0xFFFF;  // RRD: MEMPTR = HL + 1
            this.write8(this.hl, newHL);
            this.tStates += 3;
            break;
          }
          case 5: {
            // RLD: 18T, read@T+8, write@T+15. Auto: 8T
            const hlVal = this.read8(this.hl);
            this.tStates += 3;  // read cycle
            contendN(this, this.hl, 4);
            const newHL = ((hlVal << 4) | (this.a & 0x0F)) & 0xFF;
            this.a = (this.a & 0xF0) | (hlVal >> 4);
            this.f = (this.f & 0x01) | SZP[this.a];
            this._qReg = this.f;
            this.memptr = (this.hl + 1) & 0xFFFF;  // RLD: MEMPTR = HL + 1
            this.write8(this.hl, newHL);
            this.tStates += 3;
            break;
          }
          default:
            // ED NOP: 8T (auto-counted)
            break;
        }
        break;
    }
  } else if (x === 2 && y >= 4) {
    switch (z) {
      case 0: {
        // LDI/LDD/LDIR/LDDR: read@T+8, write@T+11. Auto: 8T
        const val = this.read8(this.hl);
        this.tStates += 3;  // read cycle
        this.write8(this.de, val);
        this.tStates += 3;  // write cycle
        // 2 internal processing cycles at DE (before inc/dec)
        contendN(this, this.de, 2);

        this.bc = (this.bc - 1) & 0xFFFF;
        const n = (val + this.a) & 0xFF;

        if ((y === 6 || y === 7) && this.bc !== 0) {
          // LDIR/LDDR repeating: 5 more internal cycles at DE
          contendN(this, this.de, 5);
          this.pc = (this.pc - 2) & 0xFFFF;
          this.f = (this.f & 0xC1) | ((this.pc >> 8) & 0x28) | 0x04;
          this.memptr = (this.pc + 1) & 0xFFFF;
        } else {
          // LDI/LDD or LDIR/LDDR final: bits 3,5 from (val + A)
          this.f = (this.f & 0xC1) | (n & 0x08) | ((n << 4) & 0x20);
          if (this.bc !== 0) this.f |= 0x04;
        }
        // Inc/dec HL, DE after all contention (matches real Z80 bus timing)
        if (y & 1) {
          this.hl = (this.hl - 1) & 0xFFFF;
          this.de = (this.de - 1) & 0xFFFF;
        } else {
          this.hl = (this.hl + 1) & 0xFFFF;
          this.de = (this.de + 1) & 0xFFFF;
        }
        this._qReg = this.f;
        break;
      }

      case 1: {
        // CPI/CPD/CPIR/CPDR: read@T+8. Auto: 8T
        const val = this.read8(this.hl);
        this.tStates += 3;  // read cycle
        // 5 internal processing cycles at HL (before inc/dec)
        contendN(this, this.hl, 5);

        const result = (this.a - val) & 0xFF;
        const h = ((this.a ^ val ^ result) & 0x10);
        const n = result - (h ? 1 : 0);

        if (y === 4 || y === 6) {
          this.hl = (this.hl + 1) & 0xFFFF;
          this.memptr = (this.memptr + 1) & 0xFFFF;  // CPI/CPIR: MEMPTR = MEMPTR + 1
        } else {
          this.hl = (this.hl - 1) & 0xFFFF;
          this.memptr = (this.memptr - 1) & 0xFFFF;  // CPD/CPDR: MEMPTR = MEMPTR - 1
        }

        this.bc = (this.bc - 1) & 0xFFFF;

        this.f = (this.f & 0x01) |
                 (result & 0x80) |
                 (result === 0 ? 0x40 : 0) |
                 h |
                 0x02 |
                 (this.bc !== 0 ? 0x04 : 0) |
                 (n & 0x08) | ((n << 4) & 0x20);
        this._qReg = this.f;

        if ((y === 6 || y === 7) && this.bc !== 0 && result !== 0) {
          // CPIR/CPDR: 5 more internal cycles at HL (already incremented)
          contendN(this, this.hl, 5);
          this.pc = (this.pc - 2) & 0xFFFF;
          this.memptr = (this.pc + 1) & 0xFFFF;  // CPIR/CPDR repeating: MEMPTR = PC + 1
        }
        break;
      }

      case 2: {
        // INI/IND/INIR/INDR: I/O@T+9, write@T+13. Auto: 8T
        this.contend(this.ir); this.tStates += 1;  // internal at IR
        const bcBeforeDec = this.bc;
        const val = this.portIn(this.bc);
        this.tStates += 4;  // I/O base cycle
        this.write8(this.hl, val);
        this.b = (this.b - 1) & 0xFF;

        // INI/IND: MEMPTR = BC_before_decrementing_B ± 1
        if (y === 4 || y === 6) {
          this.memptr = (bcBeforeDec + 1) & 0xFFFF;  // INI/INIR
        } else {
          this.memptr = (bcBeforeDec - 1) & 0xFFFF;  // IND/INDR
        }

        const nf = (val >> 6) & 0x02;  // N = bit 7 of I/O value
        const t = (y === 4 || y === 6)
          ? (val + ((this.c + 1) & 0xFF)) & 0x1FF  // INI/INIR
          : (val + ((this.c - 1) & 0xFF)) & 0x1FF; // IND/INDR
        const hcf = t > 0xFF;
        const p = ((t & 0x07) ^ this.b) & 0xFF;

        if (y === 4 || y === 6) {
          this.hl = (this.hl + 1) & 0xFFFF;
        } else {
          this.hl = (this.hl - 1) & 0xFFFF;
        }

        if ((y === 6 || y === 7) && this.b !== 0) {
          // INIR/INDR repeating: Y,X from PCH; complex PF/HF
          this.pc = (this.pc - 2) & 0xFFFF;
          const pch = (this.pc >> 8) & 0xFF;
          let f = (this.b & 0x80) |               // S from B
                  (pch & 0x28) |                   // Y, X from PCH
                  nf;                              // N
          if (hcf) {
            f |= 0x01;   // C
            let pAdj: number;
            if (nf) {
              // N set: HF = !(B & 0xF), PF uses (B-1)&7
              if (!(this.b & 0x0F)) f |= 0x10;  // H
              pAdj = (this.b - 1) & 7;
            } else {
              // N clear: HF = ((B & 0xF) == 0xF), PF uses (B+1)&7
              if ((this.b & 0x0F) === 0x0F) f |= 0x10;  // H
              pAdj = (this.b + 1) & 7;
            }
            let par = (p ^ pAdj) & 0xFF;
            par ^= par >> 4; par ^= par >> 2; par ^= par >> 1;
            if (!(par & 1)) f |= 0x04;  // PV (even parity)
          } else {
            // No carry: HF=0, CF=0
            let par = (p ^ (this.b & 7)) & 0xFF;
            par ^= par >> 4; par ^= par >> 2; par ^= par >> 1;
            if (!(par & 1)) f |= 0x04;  // PV
          }
          this.f = f;
          this.memptr = (this.pc + 1) & 0xFFFF;  // During repeat: MEMPTR = PC + 1
          // 5 internal cycles at HL (already incremented)
          contendN(this, this.hl, 5);
          this.tStates += 3;   // INIR/INDR: 21T total
        } else {
          // INI/IND or INIR/INDR final (B==0): Y,X from B; standard PF
          let par = p;
          par ^= par >> 4; par ^= par >> 2; par ^= par >> 1;
          this.f = (this.b & 0xA8) |              // S, Y, X from B
                   (this.b === 0 ? 0x40 : 0) |    // Z
                   (hcf ? 0x11 : 0) |             // H, C
                   ((par & 1) ? 0 : 0x04) |       // P/V
                   nf;                             // N
          this.tStates += 3;   // INI/IND: 16T total
        }
        this._qReg = this.f;
        break;
      }

      case 3: {
        // OUTI/OUTD/OTIR/OTDR: read@T+9. Auto: 8T
        this.contend(this.ir); this.tStates += 1;  // internal at IR
        const val = this.read8(this.hl);

        // Modify HL first (C code uses HL++ or HL-- in the READ itself)
        if (y === 4 || y === 6) {
          this.hl = (this.hl + 1) & 0xFFFF;  // OUTI/OTIR
        } else {
          this.hl = (this.hl - 1) & 0xFFFF;  // OUTD/OTDR
        }

        this.b = (this.b - 1) & 0xFF;
        this.portOut(this.bc, val);

        // OUTI/OUTD: MEMPTR = BC_after_decrementing_B ± 1
        if (y === 4 || y === 6) {
          this.memptr = (this.bc + 1) & 0xFFFF;  // OUTI/OTIR
        } else {
          this.memptr = (this.bc - 1) & 0xFFFF;  // OUTD/OTDR
        }

        // Compute t using L AFTER HL modification (C code: t = io + L after HL++)
        const nfO = (val >> 6) & 0x02;  // N = bit 7 of value
        const tO = (val + this.l) & 0x1FF;
        const hcfO = tO > 0xFF;
        const pO = ((tO & 0x07) ^ this.b) & 0xFF;

        if ((y === 6 || y === 7) && this.b !== 0) {
          // OTIR/OTDR repeating: Y,X from PCH; complex PF/HF
          this.pc = (this.pc - 2) & 0xFFFF;
          const pchO = (this.pc >> 8) & 0xFF;
          let fO = (this.b & 0x80) |              // S from B
                   (pchO & 0x28) |                 // Y, X from PCH
                   nfO;                            // N
          if (hcfO) {
            fO |= 0x01;   // C
            let pAdjO: number;
            if (nfO) {
              if (!(this.b & 0x0F)) fO |= 0x10;  // H
              pAdjO = (this.b - 1) & 7;
            } else {
              if ((this.b & 0x0F) === 0x0F) fO |= 0x10;  // H
              pAdjO = (this.b + 1) & 7;
            }
            let parO = (pO ^ pAdjO) & 0xFF;
            parO ^= parO >> 4; parO ^= parO >> 2; parO ^= parO >> 1;
            if (!(parO & 1)) fO |= 0x04;  // PV
          } else {
            let parO = (pO ^ (this.b & 7)) & 0xFF;
            parO ^= parO >> 4; parO ^= parO >> 2; parO ^= parO >> 1;
            if (!(parO & 1)) fO |= 0x04;  // PV
          }
          this.f = fO;
          this.memptr = (this.pc + 1) & 0xFFFF;  // During repeat: MEMPTR = PC + 1
          // 5 internal cycles at BC (after B decrement)
          contendN(this, this.bc, 5);
          this.tStates += 7;   // OTIR/OTDR: 21T total
        } else {
          // OUTI/OUTD or final: Y,X from B; standard PF
          let parO = pO;
          parO ^= parO >> 4; parO ^= parO >> 2; parO ^= parO >> 1;
          this.f = (this.b & 0xA8) |              // S, Y, X from B
                   (this.b === 0 ? 0x40 : 0) |    // Z
                   (hcfO ? 0x11 : 0) |            // H, C
                   ((parO & 1) ? 0 : 0x04) |      // P/V
                   nfO;                            // N
          this.tStates += 7;   // OUTI/OUTD: 16T total (9+7)
        }
        this._qReg = this.f;
        break;
      }

      default:
        // ED block default: 8T (auto-counted)
        break;
    }
  } else if (op === 0x00 && this.trapHandler) {
    // ED 00: trap instruction — calls handler with address of the ED byte
    this.trapHandler((this.pc - 2) & 0xFFFF);
    // 8T (auto-counted)
  } else {
    // ED NOP: 8T (auto-counted)
  }
};

declare module './core.ts' {
  interface Z80 {
    executeED(): void;
  }
}
