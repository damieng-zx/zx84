/**
 * Z80 execution trace — the trace engine every Z80 machine drives.
 *
 * Modes:
 *  - 'full': one line per instruction — address, disassembly, the registers
 *    and T-state count as the instruction starts, and a short operand context
 *    (memory operand value, branch taken or not, block-op registers). A loop
 *    going round without changing a register folds into one "loops back to"
 *    line.
 *  - 'portio': no per-instruction lines; a tally of every IN and OUT by port,
 *    with the instructions that made them and the values seen.
 *  - 'zxtl': the ZXTL V0001 column layout (cycles, address, four opcode bytes,
 *    disassembly, the registers after the instruction), for comparing against
 *    other emulators' logs.
 *
 * Port accesses reach the engine one of two ways: by default a portio trace
 * taps the CPU's port hooks for its duration (so a machine's port decode is
 * not touched and costs nothing while no trace runs), and a machine whose
 * port decode already feeds `logPortAccess` itself turns the tap off.
 *
 * Debug substrate: imports cores, the sibling disassembler, utils and SPI
 * types only.
 */

import type { Z80 } from '@/cores/z80.ts';
import type { MachineTraceMode } from '@/machines/machine.ts';
import { disasmOne, stripMarkers, type DisasmLine } from '@/debug/z80/disasm.ts';
import { TraceEngine, formatIoSummary, tallyAccess, type IoTally } from '@/debug/trace.ts';
import { hex8, hex16 } from '@/utils/hex.ts';
import { signed8 } from '@/utils/signed.ts';

/** What a Z80 machine hands its trace engine: its CPU and its address space.
 *  Both are read at each use, so a machine may replace either. */
export interface Z80TraceHost {
  readonly cpu: Z80;
  readonly memory: { readByte(addr: number): number; peekByte?(addr: number): number };
}

export interface Z80TraceOptions {
  /** Tap the CPU's port hooks while a portio trace runs (default true). */
  tapPorts?: boolean;
  /** A short name for a port in the portio summary ('' for none). */
  portLabel?: (port: number) => string;
  /** Line cap (default `TRACE_MAX_LINES`). */
  maxLines?: number;
}

const ZXTL_HEADER = [
  'ZXTL V0001, ZX84 Emulator, JUMPS ADDRESS CYCLES MEM4 DISASSEMBLY REGS',
  'J   Cycle Addr. +0 +1 +2 +3 DISASSEMBLY          A  F  B  C  D  E  H  L  XH XL YH YL SP   PC   W  Z  I  R',
];

const Z80_MODES: readonly MachineTraceMode[] = ['full', 'portio', 'zxtl'];

export class Z80Trace extends TraceEngine {
  protected portTallyIn: IoTally | null = null;
  protected portTallyOut: IoTally | null = null;
  private zxtlPrevPC = -1;
  private zxtlPrevLen = 0;
  private readonly tapPorts: boolean;
  private readonly labelFor: (port: number) => string;
  private readonly scratch = new Uint8Array(0x10000);

  constructor(protected readonly host: Z80TraceHost, options: Z80TraceOptions = {}) {
    super(options.maxLines);
    this.tapPorts = options.tapPorts ?? true;
    this.labelFor = options.portLabel ?? (() => '');
  }

  supports(mode: string): mode is MachineTraceMode {
    return (Z80_MODES as readonly string[]).includes(mode);
  }

  /** A byte of the address space, without side effects where the machine
   *  offers a peek. */
  protected peek(addr: number): number {
    const m = this.host.memory;
    return m.peekByte ? m.peekByte(addr & 0xFFFF) : m.readByte(addr & 0xFFFF);
  }

  /** The instruction at `pc`. Its bytes are copied into a 64K scratch at
   *  their own address, so relative branch targets come out right. */
  disasmAt(pc: number): DisasmLine {
    pc &= 0xFFFF;
    const buf = this.scratch;
    for (let i = 0; i < 8; i++) buf[(pc + i) & 0xFFFF] = this.peek(pc + i);
    return disasmOne(buf, pc);
  }

  protected begin(mode: MachineTraceMode): void {
    if (mode === 'portio') {
      this.portTallyIn = new Map();
      this.portTallyOut = new Map();
      if (this.tapPorts) this.installTap();
    }
    if (mode === 'zxtl') {
      this.zxtlPrevPC = -1;
      this.zxtlPrevLen = 0;
      this.buffer.push(...ZXTL_HEADER);
    }
  }

  before(): void {
    const pc = this.host.cpu.pc;
    this.insnPc = pc;
    if (this.mode === 'full') this.captureFullAt(pc);
  }

  after(): void {
    if (this.mode === 'zxtl' && this.insnPc >= 0) this.captureZxtl(this.insnPc);
  }

  /** Count a port access (portio), or check the cap (the other modes). `pc`
   *  defaults to the CPU's, which mid-instruction is past the opcode. */
  logPortAccess(dir: string, port: number, val: number, pc = this.host.cpu.pc): void {
    if (this.mode === 'portio') {
      const tally = dir === 'IN' ? this.portTallyIn : this.portTallyOut;
      if (tally) tallyAccess(tally, port, pc, val);
      return;
    }
    if (this.buffer.length >= this.maxLines) this.capReached();
  }

  /** A full-mode line for the instruction at the CPU's pc. */
  captureFull(): void {
    this.captureFullAt(this.host.cpu.pc);
  }

  private captureFullAt(pc: number): void {
    const cpu = this.host.cpu;
    let hash = cpu.a;
    hash = Math.imul(hash, 31) + cpu.f | 0;
    hash = Math.imul(hash, 31) + cpu.bc | 0;
    hash = Math.imul(hash, 31) + cpu.de | 0;
    hash = Math.imul(hash, 31) + cpu.hl | 0;
    hash = Math.imul(hash, 31) + cpu.ix | 0;
    hash = Math.imul(hash, 31) + cpu.iy | 0;
    hash = Math.imul(hash, 31) + cpu.sp | 0;
    hash = Math.imul(hash, 31) + cpu.i | 0;
    if (this.fold(pc, hash)) return;
    this.push(this.fullLine(pc, stripMarkers(this.disasmAt(pc).text), this.operandContext(pc)));
  }

  /** The full-mode line: address, disassembly, registers and T-states as the
   *  instruction starts, then the operand context. */
  protected fullLine(pc: number, text: string, ctx: string): string {
    const c = this.host.cpu;
    const line = `${hex16(pc)}  ${text.padEnd(18)} AF=${hex16(c.af)} BC=${hex16(c.bc)} DE=${hex16(c.de)} ` +
      `HL=${hex16(c.hl)} IX=${hex16(c.ix)} IY=${hex16(c.iy)} SP=${hex16(c.sp)} T=${c.tStates}`;
    return ctx ? `${line}  ${ctx}` : line;
  }

  /** A ZXTL line for the instruction that started at `prePC` and has just run. */
  captureZxtl(prePC: number): void {
    const cpu = this.host.cpu;
    const dl = this.disasmAt(prePC);
    const isJump = this.zxtlPrevPC >= 0 && prePC !== ((this.zxtlPrevPC + this.zxtlPrevLen) & 0xFFFF);
    this.zxtlPrevPC = prePC;
    this.zxtlPrevLen = dl.length;
    this.push(
      `${isJump ? '*' : ' '} ${String(cpu.tStates).padStart(7)} ${String(prePC).padStart(5)} ` +
      `${hex8(this.peek(prePC))} ${hex8(this.peek(prePC + 1))} ${hex8(this.peek(prePC + 2))} ${hex8(this.peek(prePC + 3))} ` +
      `${stripMarkers(dl.text).padEnd(20)} ${hex8(cpu.a)} ${hex8(cpu.f)} ` +
      `${hex8(cpu.bc >> 8)} ${hex8(cpu.bc)} ${hex8(cpu.de >> 8)} ${hex8(cpu.de)} ${hex8(cpu.hl >> 8)} ${hex8(cpu.hl)} ` +
      `${hex8(cpu.ix >> 8)} ${hex8(cpu.ix)} ${hex8(cpu.iy >> 8)} ${hex8(cpu.iy)} ${hex16(cpu.sp)} ${hex16(cpu.pc)} ` +
      `${hex8(cpu.memptr >> 8)} ${hex8(cpu.memptr)} ${hex8(cpu.i)} ${hex8(cpu.r)}`,
    );
  }

  /** What the instruction at `pc` is about to touch, read before it runs:
   *  the memory operand's value, whether a conditional branch is taken, the
   *  port of an IN/OUT (C), the registers of a block op. */
  protected operandContext(pc: number): string {
    const cpu = this.host.cpu;
    const rd = (a: number): number => this.peek(a);
    const op = rd(pc);
    if (op === 0xDD || op === 0xFD) {
      const ixr = op === 0xDD ? cpu.ix : cpu.iy;
      const op2 = rd(pc + 1);
      if (op2 === 0xCB) { const addr = (ixr + signed8(rd(pc + 2))) & 0xFFFF; return `(${hex16(addr)})=${hex8(rd(addr))}`; }
      if (op2 === 0xED || op2 === 0xDD || op2 === 0xFD) return '';
      const x = op2 >> 6, y = (op2 >> 3) & 7, z = op2 & 7;
      if ((x === 1 && (y === 6 || z === 6) && !(y === 6 && z === 6)) || (x === 2 && z === 6) || (x === 0 && (z === 4 || z === 5) && y === 6) || op2 === 0x36) {
        const addr = (ixr + signed8(rd(pc + 2))) & 0xFFFF;
        return x === 2 ? `A=${hex8(cpu.a)} (${hex16(addr)})=${hex8(rd(addr))}` : `(${hex16(addr)})=${hex8(rd(addr))}`;
      }
      return '';
    }
    if (op === 0xCB) return (rd(pc + 1) & 7) === 6 ? `(${hex16(cpu.hl)})=${hex8(rd(cpu.hl))}` : '';
    if (op === 0xED) {
      const ed = rd(pc + 1), x = ed >> 6, y = (ed >> 3) & 7, z = ed & 7;
      if (x === 1 && (z === 0 || z === 1)) return `port=${hex16(cpu.bc)}`;
      return x === 2 && y >= 4 && z < 4 ? `HL=${hex16(cpu.hl)} DE=${hex16(cpu.de)} BC=${hex16(cpu.bc)}` : '';
    }
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    if (x === 0) {
      if (z === 0 && y === 2) return `B=${hex8(cpu.bc >> 8)}`;
      if (z === 0 && y >= 4) return cpu.checkCondition(y - 4) ? 'taken' : '--';
      if (z === 2) {
        if (q === 0 && p <= 1) return `A=${hex8(cpu.a)}→(${hex16(p === 0 ? cpu.bc : cpu.de)})`;
        if (q === 1 && p <= 1) { const addr = p === 0 ? cpu.bc : cpu.de; return `(${hex16(addr)})=${hex8(rd(addr))}`; }
      }
      if ((z === 4 || z === 5) && y === 6) return `(${hex16(cpu.hl)})=${hex8(rd(cpu.hl))}`;
    }
    if (x === 1) {
      if (y === 6 && z !== 6) return `${hex8(cpu.getReg8(z))}→(${hex16(cpu.hl)})`;
      if (z === 6 && y !== 6) return `(${hex16(cpu.hl)})=${hex8(rd(cpu.hl))}`;
    }
    if (x === 2) return z === 6 ? `A=${hex8(cpu.a)} (${hex16(cpu.hl)})=${hex8(rd(cpu.hl))}` : `A=${hex8(cpu.a)}`;
    if (x === 3) {
      if (z === 0 || z === 2 || z === 4) return cpu.checkCondition(y) ? 'taken' : '--';
      if (z === 6 || (z === 3 && y === 2)) return `A=${hex8(cpu.a)}`;
    }
    return '';
  }

  /** A short name for a port in the portio summary. */
  protected portLabel(port: number): string {
    return this.labelFor(port);
  }

  protected ioSummary(): string {
    const out = formatIoSummary('=== Port IO Summary ===',
      [['IN', this.portTallyIn], ['OUT', this.portTallyOut]], port => this.portLabel(port));
    this.portTallyIn = null;
    this.portTallyOut = null;
    return out;
  }

  /** Wrap the CPU's port hooks for the length of a portio trace. A machine
   *  that installs its own `portIn`/`portOut` gets those wrapped; one that
   *  sets the core's handlers gets the handlers wrapped. Whichever the
   *  machine uses, the wrapper only counts and forwards. */
  private installTap(): void {
    const cpu = this.host.cpu;
    const own = (k: string): boolean => Object.prototype.hasOwnProperty.call(cpu, k);
    const restore: (() => void)[] = [];
    if (own('portIn')) {
      const orig = cpu.portIn;
      const tap = (port: number): number => {
        const v = orig.call(cpu, port);
        this.logPortAccess('IN', port, v & 0xFF, this.insnPc);
        return v;
      };
      cpu.portIn = tap;
      restore.push(() => { if (cpu.portIn === tap) cpu.portIn = orig; });
    } else {
      const orig = cpu.portInHandler;
      const tap = (port: number): number => {
        const v = orig ? orig(port) : 0xFF;
        this.logPortAccess('IN', port, v & 0xFF, this.insnPc);
        return v;
      };
      cpu.portInHandler = tap;
      restore.push(() => { if (cpu.portInHandler === tap) cpu.portInHandler = orig; });
    }
    if (own('portOut')) {
      const orig = cpu.portOut;
      const tap = (port: number, val: number): void => {
        this.logPortAccess('OUT', port, val & 0xFF, this.insnPc);
        orig.call(cpu, port, val);
      };
      cpu.portOut = tap;
      restore.push(() => { if (cpu.portOut === tap) cpu.portOut = orig; });
    } else {
      const orig = cpu.portOutHandler;
      const tap = (port: number, val: number): void => {
        this.logPortAccess('OUT', port, val & 0xFF, this.insnPc);
        if (orig) orig(port, val);
      };
      cpu.portOutHandler = tap;
      restore.push(() => { if (cpu.portOutHandler === tap) cpu.portOutHandler = orig; });
    }
    this.setTap(() => { for (const r of restore) r(); });
  }
}
