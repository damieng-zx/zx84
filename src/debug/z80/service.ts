/**
 * Z80 debug family module.
 *
 * Everything Z80-*shaped* about debugging lives here, shared by every Z80-based
 * machine (all four today): the register snapshot/poke surface, disassembly
 * formatting for the debugger pane, the step-into/over/out opcode reasoning
 * (moved out of managers/debug-manager.ts), and the clipboard CPU-state block.
 * A future 6502 machine adds a sibling `debug/m6502/` module and its own panels;
 * nothing here is reached by machines of another family.
 *
 * This is CPU-family substrate, not a machine: machine folders may import
 * their family's module; it imports only cores, the sibling disassembler, and
 * the SPI *types* from machine.ts.
 */

import { Z80 } from '@/cores/z80.ts';
import { disasmOne, disassembleAroundPC, formatDisasmHtml, stripMarkers } from '@/debug/z80/disasm.ts';
import { hex8, hex16 } from '@/utils/hex.ts';
import type {
  CpuPorts, DebugPanelDescriptor, DebugService, DisasmRow, Machine, RegisterDesc, RegisterSnapshot,
} from '@/machines/machine.ts';

/** The structural surface a Z80 machine offers its debug service. Every Z80
 *  machine class satisfies this with its ordinary concrete members — the
 *  members stay OFF the machine-blind `Machine` interface. */
export interface Z80DebugTarget extends Machine {
  cpu: Z80;
  startTrace(mode?: string): void;
  stopTrace(): string;
  ocrScreenForMcp(mode?: string): string;
  resolveMemoryRegion?(value: string): { data: Uint8Array; baseAddr: number } | null;
  screenExportBytes?(): Uint8Array | null;
  ramExportBytes?(): { data: Uint8Array; filename: string } | null;
}

/** Family accessor: the Z80 CPU of a machine, or null for another family.
 *  The ONLY sanctioned way for a host (MCP) to reach a CPU object. */
export function z80Cpu(m: Machine): Z80 | null {
  return m.descriptor.cpuFamily === 'z80' ? (m as Z80DebugTarget).cpu : null;
}

/** When the CPU is halted with interrupts enabled, fire the frame interrupt so
 *  a step lands on the handler's first instruction instead of spinning on the
 *  HALT (the maskable interrupt is normally raised only at the frame boundary).
 *  Returns false when parked in a DI HALT — the caller falls back to a step. */
function wakeHaltedIntoInterrupt(cpu: Z80): boolean {
  if (cpu.halted && cpu.iff1 && !cpu.eiDelay) {
    cpu.interrupt();
    return true;
  }
  return false;
}

export class Z80DebugService implements DebugService {
  readonly cpuFamily = 'z80' as const;

  /** The Z80 has a real 64K port space — IN/OUT straight onto the CPU's own
   *  handlers, exactly as an `IN A,(n)` would drive them. */
  readonly ports: CpuPorts;

  constructor(private readonly m: Z80DebugTarget) {
    this.ports = {
      in: (port: number) => this.m.cpu.portIn(port),
      out: (port: number, value: number) => this.m.cpu.portOut(port, value),
    };
  }

  get pc(): number { return this.m.cpu.pc; }
  get tStates(): number { return this.m.cpu.tStates; }

  regs(): RegisterSnapshot {
    const cpu = this.m.cpu;
    const r16 = (name: string, value: number, group: string): RegisterDesc =>
      ({ name, width: 16, value, group });
    const r8 = (name: string, value: number, group: string): RegisterDesc =>
      ({ name, width: 8, value, group });
    return {
      pc: cpu.pc,
      sp: cpu.sp,
      tStates: cpu.tStates,
      im: cpu.im,
      iff1: cpu.iff1,
      halted: cpu.halted,
      flags: [
        { name: 'S', set: (cpu.f & Z80.FLAG_S) !== 0 },
        { name: 'Z', set: (cpu.f & Z80.FLAG_Z) !== 0 },
        { name: 'H', set: (cpu.f & Z80.FLAG_H) !== 0 },
        { name: 'P', set: (cpu.f & Z80.FLAG_PV) !== 0 },
        { name: 'N', set: (cpu.f & Z80.FLAG_N) !== 0 },
        { name: 'C', set: (cpu.f & Z80.FLAG_C) !== 0 },
      ],
      regs: [
        r16('AF', cpu.af, 'main'), r16("AF'", (cpu.a_ << 8) | cpu.f_, 'alt'),
        r16('BC', cpu.bc, 'main'), r16("BC'", (cpu.b_ << 8) | cpu.c_, 'alt'),
        r16('DE', cpu.de, 'main'), r16("DE'", (cpu.d_ << 8) | cpu.e_, 'alt'),
        r16('HL', cpu.hl, 'main'), r16("HL'", (cpu.h_ << 8) | cpu.l_, 'alt'),
        r16('IX', cpu.ix, 'index'), r16('IY', cpu.iy, 'index'),
        r16('SP', cpu.sp, 'main'), r16('PC', cpu.pc, 'main'),
        r8('I', cpu.i, 'system'), r8('R', cpu.r, 'system'),
      ],
    };
  }

  getReg(name: string): number | null {
    const cpu = this.m.cpu;
    switch (name.toUpperCase()) {
      case 'A':  return cpu.a;
      case 'F':  return cpu.f;
      case 'AF': return cpu.af;
      case 'B':  return cpu.b;
      case 'C':  return cpu.c;
      case 'BC': return cpu.bc;
      case 'D':  return cpu.d;
      case 'E':  return cpu.e;
      case 'DE': return cpu.de;
      case 'H':  return cpu.h;
      case 'L':  return cpu.l;
      case 'HL': return cpu.hl;
      case 'IX': return cpu.ix;
      case 'IY': return cpu.iy;
      case 'SP': return cpu.sp;
      case 'PC': return cpu.pc;
      case 'I':  return cpu.i;
      case 'R':  return cpu.r;
      default: return null;
    }
  }

  setReg(name: string, value: number): boolean {
    const cpu = this.m.cpu;
    switch (name.toUpperCase()) {
      case 'A':  cpu.a  = value & 0xFF; break;
      case 'F':  cpu.f  = value & 0xFF; break;
      case 'AF': cpu.af = value & 0xFFFF; break;
      case 'B':  cpu.b  = value & 0xFF; break;
      case 'C':  cpu.c  = value & 0xFF; break;
      case 'BC': cpu.bc = value & 0xFFFF; break;
      case 'D':  cpu.d  = value & 0xFF; break;
      case 'E':  cpu.e  = value & 0xFF; break;
      case 'DE': cpu.de = value & 0xFFFF; break;
      case 'H':  cpu.h  = value & 0xFF; break;
      case 'L':  cpu.l  = value & 0xFF; break;
      case 'HL': cpu.hl = value & 0xFFFF; break;
      case 'SP': cpu.sp = value & 0xFFFF; break;
      case 'PC': cpu.pc = value & 0xFFFF; break;
      case 'IX': cpu.ix = value & 0xFFFF; break;
      case 'IY': cpu.iy = value & 0xFFFF; break;
      default: return false;
    }
    return true;
  }

  disasm(addr: number, lines: number): DisasmRow[] {
    const snap = this.m.memory.snapshot();
    const out: DisasmRow[] = [];
    let a = addr & 0xFFFF;
    for (let i = 0; i < lines; i++) {
      const dl = disasmOne(snap, a);
      const bytes = Array.from({ length: dl.length }, (_, j) => hex8(snap[(dl.addr + j) & 0xFFFF])).join(' ');
      // Markers are the pane's HTML scaffolding (disasmPaneHtml) — a DisasmRow
      // is contracted to be printable text.
      out.push({
        addr: dl.addr, bytes, text: stripMarkers(dl.text),
        length: dl.length, isTerminal: dl.isTerminal,
      });
      a = (a + dl.length) & 0xFFFF;
    }
    return out;
  }

  /** The debugger pane's disassembly-around-PC HTML (breakpoint markers etc.),
   *  exactly as frame-bridge's updateDisasm built it. */
  disasmPaneHtml(lines: number): string {
    const snap = this.m.memory.snapshot();
    const pc = this.m.cpu.pc;
    return formatDisasmHtml(disassembleAroundPC(snap, pc, lines), snap, pc, this.m.breakpoints);
  }

  /** Raw single instruction — no halted-wake semantics (MCP `step`). */
  stepOne(): void { this.m.cpu.step(); }

  /** UI step-into: wake a halted CPU into the interrupt handler first. */
  stepInto(): void {
    if (!wakeHaltedIntoInterrupt(this.m.cpu)) this.m.cpu.step();
  }

  /**
   * Step over CALL/RST/conditional-jump/block-repeat instructions.
   * CALL/RST complete when SP returns to its pre-call level; conditional jumps
   * and block repeats when PC reaches the next sequential instruction (block
   * repeats don't touch SP — they rewind PC by 2 each iteration).
   */
  stepOver(): void {
    const cpu = this.m.cpu;
    if (wakeHaltedIntoInterrupt(cpu)) return;
    const op = this.m.memory.readByte(cpu.pc);

    // Block repeats: ED B0..B3 / ED B8..BB — `1011 0xxx` ignoring bit 3.
    const isBlockRepeat = op === 0xED &&
      ((this.m.memory.readByte((cpu.pc + 1) & 0xFFFF) & 0xF4) === 0xB0);

    const isCall =
      op === 0xCD ||                  // CALL nn
      (op & 0xC7) === 0xC4 ||         // CALL cc,nn
      (op & 0xC7) === 0xC7;           // RST n

    const isPcOver =
      isBlockRepeat ||
      op === 0x10 ||                  // DJNZ e         (2 bytes)
      (op & 0xE7) === 0x20 ||         // JR cc,e        (2 bytes)
      (op & 0xC7) === 0xC2;           // JP cc,nn       (3 bytes)

    if (isPcOver) {
      const instrLen = (op & 0xC7) === 0xC2 ? 3 : 2;
      const nextPC = (cpu.pc + instrLen) & 0xFFFF;
      const limit = cpu.tStates + 5_000_000;
      cpu.step();
      while (cpu.pc !== nextPC && cpu.tStates < limit) cpu.step();
    } else if (!isCall) {
      cpu.step();
    } else {
      const targetSP = cpu.sp;
      const limit = cpu.tStates + 5_000_000; // safety: max ~1.4 seconds
      cpu.step(); // execute the CALL/RST
      while (((targetSP - cpu.sp) & 0xFFFF) > 0 && cpu.tStates < limit) cpu.step();
    }
  }

  /** Run until RET brings SP back past the current frame (16-bit circular). */
  stepOut(): void {
    const cpu = this.m.cpu;
    const targetSP = (cpu.sp + 2) & 0xFFFF;
    const limit = cpu.tStates + 10_000_000; // safety: max ~2.8 seconds
    while (((targetSP - cpu.sp) & 0xFFFF) > 0 && cpu.tStates < limit) cpu.step();
  }

  /** The clipboard CPU-state + disassembly block (Copy CPU state button). */
  cpuStateText(): string {
    const cpu = this.m.cpu;
    const f = cpu.f;
    const flags = [
      `Sign=${(f & Z80.FLAG_S) ? 1 : 0}`,
      `Zero=${(f & Z80.FLAG_Z) ? 1 : 0}`,
      `Half=${(f & Z80.FLAG_H) ? 1 : 0}`,
      `P/V=${(f & Z80.FLAG_PV) ? 1 : 0}`,
      `Sub=${(f & Z80.FLAG_N) ? 1 : 0}`,
      `Carry=${(f & Z80.FLAG_C) ? 1 : 0}`,
    ].join('  ');

    const iff = cpu.iff1 ? 'EI' : 'DI';
    const halt = cpu.halted ? ' HALT' : '';

    const lines = [
      `AF  ${hex16(cpu.af)}  AF' ${hex16((cpu.a_ << 8) | cpu.f_)}`,
      `BC  ${hex16(cpu.bc)}  BC' ${hex16((cpu.b_ << 8) | cpu.c_)}`,
      `DE  ${hex16(cpu.de)}  DE' ${hex16((cpu.d_ << 8) | cpu.e_)}`,
      `HL  ${hex16(cpu.hl)}  HL' ${hex16((cpu.h_ << 8) | cpu.l_)}`,
      `IX  ${hex16(cpu.ix)}  IY  ${hex16(cpu.iy)}`,
      `PC  ${hex16(cpu.pc)}  SP  ${hex16(cpu.sp)}`,
      `I   ${hex8(cpu.i)}    R   ${hex8(cpu.r)}  IM ${cpu.im}  ${iff}${halt}`,
      `Flags: ${flags}`,
      '',
      'Disassembly:',
    ];

    const snap = this.m.memory.snapshot();
    let addr = cpu.pc;
    for (let i = 0; i < 16; i++) {
      const dl = disasmOne(snap, addr);
      const bytesStr = Array.from({ length: dl.length }, (_, j) => hex8(snap[(dl.addr + j) & 0xFFFF]))
        .join(' ')
        .padEnd(12, ' ');
      const mnem = dl.text.padEnd(24, ' ');
      lines.push(`${dl.addr === cpu.pc ? '>' : ' '} ${hex16(addr)}  ${bytesStr}  ${mnem}`);
      addr = (addr + dl.length) & 0xFFFF;
    }
    return lines.join('\n');
  }

  /* ── Family-formatted text ────────────────────────────────────────────────
   * Which registers a step line carries, the AF/AF' pairing, the SZHPNC flag
   * letters — all Z80 convention, so the layout lives here rather than being
   * reassembled from regs() by every host that prints CPU state.
   */

  /** `PC  mnemonic  A=.. F=.. BC=.. DE=.. HL=.. SP=..  T=..` (one traced step). */
  stepLine(): string {
    const cpu = this.m.cpu;
    const mnem = this.disasm(cpu.pc, 1)[0].text.padEnd(20);
    return (
      `${hex16(cpu.pc)}  ${mnem}` +
      `A=${hex8(cpu.a)} F=${hex8(cpu.f)} ` +
      `BC=${hex16(cpu.bc)} DE=${hex16(cpu.de)} HL=${hex16(cpu.hl)} ` +
      `SP=${hex16(cpu.sp)}  T=${cpu.tStates}`
    );
  }

  /** The register/flag block: main + shadow pairs, index regs, IFF/IM, IR. */
  regsText(): string {
    const cpu = this.m.cpu;
    const flagBits: readonly (readonly [number, string])[] = [
      [Z80.FLAG_S, 'S'], [Z80.FLAG_Z, 'Z'], [Z80.FLAG_H, 'H'],
      [Z80.FLAG_PV, 'P'], [Z80.FLAG_N, 'N'], [Z80.FLAG_C, 'C'],
    ];
    const flags = flagBits.map(([bit, ch]) => (cpu.f & bit) ? ch : '-').join('');
    const iff = cpu.iff1 ? 'EI' : 'DI';
    const halt = cpu.halted ? ' HALT' : '';
    return [
      `AF  ${hex16(cpu.af)}  AF' ${hex16((cpu.a_ << 8) | cpu.f_)}   Flags: ${flags}`,
      `BC  ${hex16(cpu.bc)}  BC' ${hex16((cpu.b_ << 8) | cpu.c_)}`,
      `DE  ${hex16(cpu.de)}  DE' ${hex16((cpu.d_ << 8) | cpu.e_)}`,
      `HL  ${hex16(cpu.hl)}  HL' ${hex16((cpu.h_ << 8) | cpu.l_)}`,
      `IX  ${hex16(cpu.ix)}  IY  ${hex16(cpu.iy)}   ${iff}  IM${cpu.im}${halt}`,
      `SP  ${hex16(cpu.sp)}  PC  ${hex16(cpu.pc)}   IR  ${hex8(cpu.i)}${hex8(cpu.r)}`,
      `T-states: ${cpu.tStates}`,
    ].join('\n');
  }

  /** Trap-log tail: the registers CP/M and firmware calls pass arguments in. */
  regsSummary(): string {
    const cpu = this.m.cpu;
    return `C=${hex8(cpu.c)} DE=${hex16(cpu.de)} A=${hex8(cpu.a)}`;
  }

  /** Words on the stack from SP upward — the RET chain, innermost first. */
  returnStack(depth: number): number[] {
    const mem = this.m.memory;
    const sp = this.m.cpu.sp;
    const out: number[] = [];
    for (let i = 0; i < depth; i++) {
      const a = (sp + i * 2) & 0xFFFF;
      out.push((mem.readByte((a + 1) & 0xFFFF) << 8) | mem.readByte(a));
    }
    return out;
  }

  /** Synthetic RET: pop the return address into PC. */
  returnFromCall(): void {
    const cpu = this.m.cpu;
    const lo = this.m.memory.readByte(cpu.sp & 0xFFFF);
    const hi = this.m.memory.readByte((cpu.sp + 1) & 0xFFFF);
    cpu.sp = (cpu.sp + 2) & 0xFFFF;
    cpu.pc = (hi << 8) | lo;
  }

  startTrace(mode?: string): void { this.m.startTrace(mode); }
  stopTrace(): string { return this.m.stopTrace(); }
  ocr(mode?: string): string { return this.m.ocrScreenForMcp(mode); }

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    return this.m.resolveMemoryRegion?.(value) ?? null;
  }

  screenExport(): Uint8Array | null { return this.m.screenExportBytes?.() ?? null; }
  ramExport(): { data: Uint8Array; filename: string } | null { return this.m.ramExportBytes?.() ?? null; }

  panels(): DebugPanelDescriptor[] { return []; }
}
