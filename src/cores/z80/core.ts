/*
  Z80 CPU Core
  Based on the official Z80 documentation and various online resources.
  Includes full instruction set, flags, and interrupt handling plus undocumented behavior.
  Passes full zexdoc and zexall test suites.

  I/O is chip-agnostic — wire portOutHandler / portInHandler after construction:
    const cpu = new Z80();
    cpu.portOutHandler = (port, val) => { ... };
    cpu.portInHandler  = (port) => { return 0xFF; };

  The class is declared here. Instruction implementations (ALU, rotates, the
  opcode dispatcher, and the CB/ED/DD/FD prefix decoders) are attached to
  `Z80.prototype` from sibling modules and type-merged via `declare module`
  blocks. Importing this module alone does NOT populate those methods —
  always import the class via `./index.ts` (which side-effect-imports every
  method module) or via `@/cores/z80.ts` (the re-export shim).
*/

export class Z80 {
  portOutHandler: ((port: number, val: number) => void) | null;
  portInHandler: ((port: number) => number) | null;
  trapHandler: ((pc: number) => void) | null;

  // Main registers
  a = 0; f = 0;
  b = 0; c = 0;
  d = 0; e = 0;
  h = 0; l = 0;

  // MEMPTR (WZ) - internal 16-bit register for undocumented flags
  memptr = 0;

  // Q register — internal latch for SCF/CCF undocumented flag behaviour.
  // Tracks whether the previous instruction modified F (Patrik Rak, 2012).
  // _qReg is set to F after every flag-modifying instruction, 0 otherwise.
  // _prevQ holds the value from the previous instruction for SCF/CCF to read.
  _qReg = 0;
  _prevQ = 0;

  // Shadow registers
  a_ = 0; f_ = 0;
  b_ = 0; c_ = 0;
  d_ = 0; e_ = 0;
  h_ = 0; l_ = 0;

  // Index registers
  ix = 0;
  iy = 0;

  // Other registers
  sp = 0;
  pc = 0;
  i = 0;
  r = 0;

  // Interrupt state
  iff1 = false;
  iff2 = false;
  im = 1;
  halted = false;
  /** EI delay: interrupts suppressed for one instruction after EI. */
  eiDelay = false;

  // T-state counter
  tStates = 0;

  /** When false, memory/IO hooks short-circuit ULA contention work entirely.
   *  The Z80 still advances tStates from base instruction timing, but no
   *  per-access contention checks or contentionDelay() math runs. Used by
   *  the UI turbo button to remove the dominant non-CPU per-instruction cost.
   *  Default true so MCP and tests (which never set turbo) keep cycle-exact
   *  timing without opting in. */
  accurateTiming = true;

  /** Internal bus contention (no MREQ). Overridden by io-ports for Spectrum models.
   *  Swapped between `_contendAccurate` and a no-op when turbo toggles, so the
   *  hundreds of bare `this.contend(addr); this.tStates += 1` sites in exec-*
   *  collapse to an inlinable empty function in Firefox (which can't inline
   *  through an internal `accurateTiming` branch on an assigned closure). */
  contend: (addr: number) => void = () => {};
  /** Cycle-exact contend installed by io-ports. Held here so turbo can swap
   *  `contend` to a no-op and back without losing the accurate impl. */
  _contendAccurate: (addr: number) => void = () => {};

  /** I/R register pair (address placed on bus during internal processing cycles). */
  get ir(): number { return (this.i << 8) | this.r; }

  /** Vector byte for next IM 2 interrupt (0xFF = standard frame interrupt) */
  _pendingVector = 0xFF;

  // Flag constants
  static readonly FLAG_C = 0x01;
  static readonly FLAG_N = 0x02;
  static readonly FLAG_PV = 0x04;
  static readonly FLAG_H = 0x10;
  static readonly FLAG_Z = 0x40;
  static readonly FLAG_S = 0x80;

  constructor() {
    this.portOutHandler = null;
    this.portInHandler = null;
    this.trapHandler = null;
    this.reset();
  }

  reset(): void {
    this.a = 0; this.f = 0;
    this.b = 0; this.c = 0;
    this.d = 0; this.e = 0;
    this.h = 0; this.l = 0;

    this.a_ = 0; this.f_ = 0;
    this.b_ = 0; this.c_ = 0;
    this.d_ = 0; this.e_ = 0;
    this.h_ = 0; this.l_ = 0;

    this.ix = 0;
    this.iy = 0;

    this.sp = 0;
    this.pc = 0;
    this.i = 0;
    this.r = 0;

    this.iff1 = false;
    this.iff2 = false;
    this.im = 1;
    this.halted = false;
    this.eiDelay = false;

    this.memptr = 0;
    this._qReg = 0;
    this._prevQ = 0;
    this.tStates = 0;
    this._pendingVector = 0xFF;
  }

  // Helper register pair access
  get bc(): number { return (this.b << 8) | this.c; }
  set bc(v: number) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
  get de(): number { return (this.d << 8) | this.e; }
  set de(v: number) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }
  get hl(): number { return (this.h << 8) | this.l; }
  set hl(v: number) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }
  get af(): number { return (this.a << 8) | this.f; }
  set af(v: number) { this.a = (v >> 8) & 0xFF; this.f = v & 0xFF; }

  // Memory access — overridden by io-ports.ts hooks before execution.
  read8(_addr: number): number { return 0xFF; }
  write8(_addr: number, _val: number): void {}

  read16(addr: number): number {
    const lo = this.read8(addr);
    this.tStates += 3;  // 3T between consecutive memory reads
    return lo | (this.read8(addr + 1) << 8);
  }

  write16(addr: number, val: number): void {
    this.write8(addr, val & 0xFF);
    this.tStates += 3;  // 3T between consecutive memory writes
    this.write8(addr + 1, (val >> 8) & 0xFF);
  }

  push16(val: number): void {
    // Real Z80 writes high byte first to (--SP), then low byte to (--SP).
    // This order matters for contention timing when SP is in contended memory.
    this.sp = (this.sp - 1) & 0xFFFF;
    this.write8(this.sp, (val >> 8) & 0xFF);
    this.tStates += 3;
    this.sp = (this.sp - 1) & 0xFFFF;
    this.write8(this.sp, val & 0xFF);
  }

  pop16(): number {
    const val = this.read16(this.sp);
    this.sp = (this.sp + 2) & 0xFFFF;
    return val;
  }

  // Flag helpers
  getFlag(flag: number): boolean { return (this.f & flag) !== 0; }
  setFlag(flag: number, val: boolean): void { this.f = val ? (this.f | flag) : (this.f & ~flag); }

  // --- I/O port handling ---
  portOut(port: number, val: number): void {
    if (this.portOutHandler) this.portOutHandler(port, val);
  }

  portIn(port: number): number {
    return this.portInHandler ? this.portInHandler(port) : 0xFF;
  }

  // --- Interrupt handling ---
  interrupt(): number {
    if (!this.iff1 || this.eiDelay) {
      this._pendingVector = 0xFF;
      return 0;
    }

    this.halted = false;
    this.iff1 = false;
    this.iff2 = false;
    // INT acknowledge is an M1 cycle — R increments like any opcode fetch.
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

    switch (this.im) {
      case 0:
        // IM 0: RST 38h on Spectrum. 13T: ack(7T), push@T+7/T+10
        this.tStates += 7;
        this.push16(this.pc);
        this.memptr = this.pc = 0x0038;
        this.tStates += 3;
        return 13;

      case 1:
        // IM 1: RST 38h. 13T: ack(7T), push@T+7/T+10
        this.tStates += 7;
        this.push16(this.pc);
        this.memptr = this.pc = 0x0038;
        this.tStates += 3;
        return 13;

      case 2: {
        // IM 2: vectored interrupt. 19T: ack(7T), push@T+7/T+10, read@T+13/T+16
        // Real Z80 pushes PC first, then reads the vector table.
        // Standard frame interrupt puts 0xFF on the bus; peripheral interrupts
        // supply their own vector byte via interruptWithVector().
        const vectorAddr = ((this.i << 8) | (this._pendingVector & 0xFF)) & 0xFFFF;
        this._pendingVector = 0xFF;
        this.tStates += 7;
        this.push16(this.pc);
        this.tStates += 3;
        this.memptr = this.pc = this.read16(vectorAddr);
        this.tStates += 3;
        return 19;
      }

      default:
        this.tStates += 7;
        this.push16(this.pc);
        this.memptr = this.pc = 0x0038;
        this.tStates += 3;
        return 13;
    }
  }

  /** Non-maskable interrupt: pushes PC, jumps to 0x0066.
   *  IFF1 is cleared (disabling maskable interrupts); IFF2 is preserved
   *  so RETN can restore IFF1 from IFF2. Takes 11 T-states. */
  nmi(): void {
    this.halted = false;
    // Documented Zilog NMI sequence: IFF2 ← IFF1; IFF1 ← 0.
    // IFF2 preserves the pre-NMI maskable-interrupt state so RETN can restore
    // it via `IFF1 ← IFF2`. Without this, RETN after an NMI silently masks
    // all subsequent maskable interrupts.
    this.iff2 = this.iff1;
    this.iff1 = false;
    // NMI acknowledge is an M1 cycle — R increments like any opcode fetch.
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
    this.tStates += 5;       // NMI acknowledge: 5T
    this.push16(this.pc);    // push PC: 2×3T (inside push16's write16)
    this.memptr = this.pc = 0x0066;
    this.tStates += 3;       // total = 5 + 3 + 3 = 11T
  }

  /** Fire an IM 2 interrupt with a specific vector byte (for peripheral devices like Z80 PIO). */
  interruptWithVector(vector: number): number {
    this._pendingVector = vector & 0xFE; // PIO vectors are always even
    return this.interrupt();
  }

  // --- Get/set 8-bit register by 3-bit code ---
  getReg8(code: number): number {
    switch (code) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 6: return this.read8(this.hl);
      case 7: return this.a;
    }
    return 0;
  }

  setReg8(code: number, val: number): void {
    val &= 0xFF;
    switch (code) {
      case 0: this.b = val; break;
      case 1: this.c = val; break;
      case 2: this.d = val; break;
      case 3: this.e = val; break;
      case 4: this.h = val; break;
      case 5: this.l = val; break;
      case 6: this.write8(this.hl, val); break;
      case 7: this.a = val; break;
    }
  }

  getReg16(code: number): number {
    switch (code) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return this.hl;
      case 3: return this.sp;
    }
    return 0;
  }

  setReg16(code: number, val: number): void {
    val &= 0xFFFF;
    switch (code) {
      case 0: this.bc = val; break;
      case 1: this.de = val; break;
      case 2: this.hl = val; break;
      case 3: this.sp = val; break;
    }
  }

  getReg16AF(code: number): number {
    switch (code) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return this.hl;
      case 3: return this.af;
    }
    return 0;
  }

  setReg16AF(code: number, val: number): void {
    val &= 0xFFFF;
    switch (code) {
      case 0: this.bc = val; break;
      case 1: this.de = val; break;
      case 2: this.hl = val; break;
      case 3: this.af = val; break;
    }
  }

  checkCondition(cc: number): boolean {
    switch (cc) {
      case 0: return !(this.f & 0x40);
      case 1: return !!(this.f & 0x40);
      case 2: return !(this.f & 0x01);
      case 3: return !!(this.f & 0x01);
      case 4: return !(this.f & 0x04);
      case 5: return !!(this.f & 0x04);
      case 6: return !(this.f & 0x80);
      case 7: return !!(this.f & 0x80);
    }
    return false;
  }

  // --- Execute one instruction ---
  step(): void {
    if (this.halted) {
      // HALT repeats a NOP-like M1 fetch from PC — apply contention.
      // No contention probe during the T3-T4 refresh: the ULA only stalls
      // the CPU on MREQ cycles, and refresh (with IR on the bus) is not one.
      // azesmbog's ULA128 test runs with I=0xFE and contended bank 7 paged
      // at 0xC000 — probing IR here breaks its hardware-calibrated timing.
      this.read8(this.pc);
      this.tStates += 3;              // M1 fetch cycle
      this.tStates += 1;              // M1 refresh cycle
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      return;
    }

    this._prevQ = this._qReg;
    this._qReg = 0;
    // Inlined fetch8 (M1 opcode read, +3T)
    const opcode = this.read8(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    this.tStates += 3;
    this.tStates += 1;                 // +1T (M1 refresh cycle — never contended)
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);

    this.executeMain(opcode);
  }
}
