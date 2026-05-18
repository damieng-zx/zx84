import { Z80 } from './core.ts';

Z80.prototype.executeCB = function (this: Z80): void {
  const op = this.fetch8();      // +3T (M1 read)
  this.contend(this.ir);         // IR contention during refresh (T3-T4)
  this.tStates += 1;             // +1T (M1 refresh)
  this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;

  const isMem = z === 6;
  let val: number;
  if (isMem) {
    // CB (HL): read@T+8. Auto: 4T(main M1) + 4T(CB M1) = 8T
    val = this.read8(this.hl);
  } else {
    val = this.getReg8(z);
  }

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
      if (isMem) {
        // CB shift/rotate (HL): 15T, write@T+12. Auto: 8T
        this.tStates += 3;
        this.contend(this.hl); this.tStates += 1;
        this.write8(this.hl, val);
        this.tStates += 3;
      } else {
        // CB shift/rotate r: 8T (auto-counted)
        this.setReg8(z, val);
      }
      break;

    case 1:
      if (isMem) {
        // BIT n,(HL): 12T. Auto: 8T
        // Undocumented flags come from MEMPTR high byte, not the value
        const r = val & (1 << y);
        const memptrH = (this.memptr >> 8) & 0xFF;
        this.f = (this.f & 0x01) |         // Preserve C
                 0x10 |                     // Set H
                 (r ? 0 : 0x44) |           // Set Z and P/V if bit is 0
                 (r & 0x80) |               // Set S if testing bit 7 and it's set
                 (memptrH & 0x28);          // Copy bits 3,5 from MEMPTR high byte
        this._qReg = this.f;
        this.tStates += 3;
        this.contend(this.hl); this.tStates += 1;
      } else {
        // BIT n,r: 8T (auto-counted)
        this.bit(y, val);
      }
      break;

    case 2:
      if (isMem) {
        // CB RES n,(HL): 15T, write@T+12. Auto: 8T
        val &= ~(1 << y);
        this.tStates += 3;
        this.contend(this.hl); this.tStates += 1;
        this.write8(this.hl, val);
        this.tStates += 3;
      } else {
        // CB RES n,r: 8T (auto-counted)
        this.setReg8(z, val & ~(1 << y));
      }
      break;

    case 3:
      if (isMem) {
        // CB SET n,(HL): 15T, write@T+12. Auto: 8T
        val |= (1 << y);
        this.tStates += 3;
        this.contend(this.hl); this.tStates += 1;
        this.write8(this.hl, val);
        this.tStates += 3;
      } else {
        // CB SET n,r: 8T (auto-counted)
        this.setReg8(z, val | (1 << y));
      }
      break;
  }
};

declare module './core.ts' {
  interface Z80 {
    executeCB(): void;
  }
}
