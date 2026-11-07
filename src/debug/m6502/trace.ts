/**
 * 6502 execution trace — the trace engine every 6502 machine drives.
 *
 * Modes:
 *  - 'full': one line per instruction — address, disassembly, the registers
 *    and cycle count as the instruction starts, and the operand context
 *    (effective address and the byte there, the value a store writes, whether
 *    a branch is taken, where an indirect jump goes). A step that enters an
 *    interrupt instead of running the instruction at pc gets an `<IRQ>` or
 *    `<NMI>` line. A loop going round without changing a register folds into
 *    one "loops back to" line.
 *  - 'portio': the 6502 has no port space; its hardware is memory-mapped, so
 *    this tallies the CPU's reads and writes inside the machine's I/O window
 *    by address, with the instructions that made them and the values seen.
 *
 * 'zxtl' is a Z80 register layout and is not offered here.
 *
 * The I/O tally taps the CPU's `read`/`write` bus callbacks for the length of a
 * portio trace only, so a machine's memory map is not touched and costs nothing
 * while no trace runs.
 *
 * Debug substrate: imports cores, the sibling disassembler, utils and SPI
 * types only.
 */

import { FLAG_C, FLAG_N, FLAG_V, FLAG_Z, type M6502 } from '@/cores/m6502.ts';
import type { MachineTraceMode } from '@/machines/machine.ts';
import { disasmOne, isaOf, opcodeInfo, stripMarkers, type M6502Mode } from '@/debug/m6502/disasm.ts';
import { TraceEngine, formatIoSummary, tallyAccess, type IoTally } from '@/debug/trace.ts';
import { hex8, hex16 } from '@/utils/hex.ts';

/** What a 6502 machine hands its trace engine: its CPU and its address space.
 *  Both are read at each use, so a machine may replace either. */
export interface M6502TraceHost {
  readonly cpu: M6502;
  readonly memory: { readByte(addr: number): number; peekByte?(addr: number): number };
}

/** An inclusive address range of memory-mapped hardware. */
export type IoWindow = readonly [lo: number, hi: number];

export interface M6502TraceOptions {
  /** The machine's memory-mapped I/O: the portio tally counts accesses here. */
  io: readonly IoWindow[];
  /** Where a read through `readByte` has side effects, for a machine with no
   *  side-effect-free `peekByte`: the trace never reads there (default: `io`). */
  noRead?: readonly IoWindow[];
  /** A short name for an I/O address in the portio summary ('' for none). */
  ioLabel?: (addr: number) => string;
  /** Line cap (default `TRACE_MAX_LINES`). */
  maxLines?: number;
}

const M6502_MODES: readonly MachineTraceMode[] = ['full', 'portio'];

/** Instruction length by addressing mode. */
const MODE_LENGTH: Readonly<Record<M6502Mode, number>> = {
  imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, inx: 2, iny: 2, izp: 2, rel: 2,
  abs: 3, abx: 3, aby: 3, ind: 3, iax: 3, zprel: 3,
};

function inWindows(windows: readonly IoWindow[], addr: number): boolean {
  for (const [lo, hi] of windows) if (addr >= lo && addr <= hi) return true;
  return false;
}

/** Mnemonics whose memory operand is written, with the register stored. */
const STORES: Readonly<Record<string, (c: M6502) => number>> = {
  STA: c => c.a, STX: c => c.x, STY: c => c.y, STZ: () => 0, SAX: c => c.a & c.x,
};

export class M6502Trace extends TraceEngine {
  private readTally: IoTally | null = null;
  private writeTally: IoTally | null = null;
  private readonly io: readonly IoWindow[];
  private readonly noRead: readonly IoWindow[];
  private readonly labelFor: (addr: number) => string;
  private readonly scratch = new Uint8Array(0x10000);

  constructor(private readonly host: M6502TraceHost, options: M6502TraceOptions) {
    super(options.maxLines);
    this.io = options.io;
    this.noRead = options.noRead ?? options.io;
    this.labelFor = options.ioLabel ?? (() => '');
  }

  supports(mode: string): mode is MachineTraceMode {
    return (M6502_MODES as readonly string[]).includes(mode);
  }

  /** `addr` lies in the machine's I/O window. */
  inIo(addr: number): boolean {
    return inWindows(this.io, addr);
  }

  /** A byte of the address space, read without side effects: through the
   *  machine's peek where it has one, else never where a read has side
   *  effects (-1). */
  private peek(addr: number): number {
    addr &= 0xFFFF;
    const m = this.host.memory;
    if (m.peekByte) return m.peekByte(addr);
    return inWindows(this.noRead, addr) ? -1 : m.readByte(addr);
  }

  protected begin(mode: MachineTraceMode): void {
    if (mode === 'portio') {
      this.readTally = new Map();
      this.writeTally = new Map();
      this.installTap();
    }
  }

  before(): void {
    const pc = this.host.cpu.pc;
    this.insnPc = pc;
    if (this.mode === 'full') this.captureFull(pc);
  }

  private captureFull(pc: number): void {
    const cpu = this.host.cpu;
    if (cpu.interruptPending()) {
      // This step pushes PC and P and takes the vector; the instruction at pc
      // does not run (yet).
      this.flushLoop();
      this.push(this.line(pc, cpu.nmiLatched ? '<NMI>' : '<IRQ>', ''));
      return;
    }
    let hash = cpu.a;
    hash = Math.imul(hash, 31) + cpu.x | 0;
    hash = Math.imul(hash, 31) + cpu.y | 0;
    hash = Math.imul(hash, 31) + cpu.p | 0;
    hash = Math.imul(hash, 31) + cpu.sp | 0;
    if (this.fold(pc, hash)) return;
    // Only the instruction's own bytes are read (the CPU fetches those anyway).
    const op = this.peek(pc) & 0xFF;
    const [mnem, mode] = opcodeInfo(op, isaOf(cpu));
    const length = MODE_LENGTH[mode];
    const buf = this.scratch;
    buf[pc] = op;
    for (let i = 1; i < length; i++) buf[(pc + i) & 0xFFFF] = this.peek(pc + i) & 0xFF;
    const dl = disasmOne(buf, pc, isaOf(cpu));
    const b1 = buf[(pc + 1) & 0xFFFF];
    const w = length === 3 ? b1 | (buf[(pc + 2) & 0xFFFF] << 8) : b1;
    this.push(this.line(pc, stripMarkers(dl.text), this.operandContext(mnem, mode, b1, w)));
  }

  private line(pc: number, text: string, ctx: string): string {
    const c = this.host.cpu;
    const line = `${hex16(pc)}  ${text.padEnd(14)} A=${hex8(c.a)} X=${hex8(c.x)} Y=${hex8(c.y)} ` +
      `P=${hex8(c.p)} SP=${hex8(c.sp)} T=${c.tStates}`;
    return ctx ? `${line}  ${ctx}` : line;
  }

  /** What the instruction is about to touch, read before it runs: `b1` is
   *  its first operand byte and `w` its 16-bit operand. */
  private operandContext(mnem: string, mode: M6502Mode, b1: number, w: number): string {
    const cpu = this.host.cpu;
    const zpWord = (z: number): number => (this.peek(z & 0xFF) & 0xFF) | ((this.peek((z + 1) & 0xFF) & 0xFF) << 8);
    let ea: number;
    switch (mode) {
      case 'rel': return branchTaken(mnem, cpu.p) ? 'taken' : '--';
      case 'ind': {
        // NMOS JMP (abs) takes the high byte from the same page.
        const hiAddr = cpu.cmos ? (w + 1) & 0xFFFF : (w & 0xFF00) | ((w + 1) & 0xFF);
        return `→${hex16((this.peek(w) & 0xFF) | ((this.peek(hiAddr) & 0xFF) << 8))}`;
      }
      case 'iax': {
        const a = (w + cpu.x) & 0xFFFF;
        return `→${hex16((this.peek(a) & 0xFF) | ((this.peek(a + 1) & 0xFF) << 8))}`;
      }
      case 'zp': ea = b1; break;
      case 'zpx': ea = (b1 + cpu.x) & 0xFF; break;
      case 'zpy': ea = (b1 + cpu.y) & 0xFF; break;
      case 'abs':
        if (mnem === 'JMP' || mnem === 'JSR') return '';
        ea = w; break;
      case 'abx': ea = (w + cpu.x) & 0xFFFF; break;
      case 'aby': ea = (w + cpu.y) & 0xFFFF; break;
      case 'inx': ea = zpWord(b1 + cpu.x); break;
      case 'iny': ea = (zpWord(b1) + cpu.y) & 0xFFFF; break;
      case 'izp': ea = zpWord(b1); break;
      default: return '';
    }
    const store = STORES[mnem];
    if (store) return `${hex8(store(cpu))}→(${hex16(ea)})`;
    const v = this.peek(ea);
    return v < 0 ? `(${hex16(ea)})` : `(${hex16(ea)})=${hex8(v)}`;
  }

  protected ioSummary(): string {
    const out = formatIoSummary('=== I/O Access Summary ===',
      [['READ', this.readTally], ['WRITE', this.writeTally]], this.labelFor);
    this.readTally = null;
    this.writeTally = null;
    return out;
  }

  /** Wrap the CPU's bus callbacks for the length of a portio trace: each
   *  access inside the I/O window is counted, then forwarded unchanged. */
  private installTap(): void {
    const cpu = this.host.cpu;
    const read = cpu.read;
    const write = cpu.write;
    const tapRead = (addr: number): number => {
      const v = read(addr);
      if (this.inIo(addr & 0xFFFF)) tallyAccess(this.readTally!, addr & 0xFFFF, this.insnPc, v & 0xFF);
      return v;
    };
    const tapWrite = (addr: number, val: number): void => {
      if (this.inIo(addr & 0xFFFF)) tallyAccess(this.writeTally!, addr & 0xFFFF, this.insnPc, val & 0xFF);
      write(addr, val);
    };
    cpu.read = tapRead;
    cpu.write = tapWrite;
    this.setTap(() => {
      if (cpu.read === tapRead) cpu.read = read;
      if (cpu.write === tapWrite) cpu.write = write;
    });
  }
}

/** Whether a conditional branch is taken with status `p` (BRA always is). */
function branchTaken(mnem: string, p: number): boolean {
  switch (mnem) {
    case 'BPL': return (p & FLAG_N) === 0;
    case 'BMI': return (p & FLAG_N) !== 0;
    case 'BVC': return (p & FLAG_V) === 0;
    case 'BVS': return (p & FLAG_V) !== 0;
    case 'BCC': return (p & FLAG_C) === 0;
    case 'BCS': return (p & FLAG_C) !== 0;
    case 'BNE': return (p & FLAG_Z) === 0;
    case 'BEQ': return (p & FLAG_Z) !== 0;
    default: return true;
  }
}
