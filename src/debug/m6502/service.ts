/**
 * 6502 debug family module.
 *
 * The family-formatted register surface, step-into/over/out reasoning,
 * disassembly text and clipboard block for every 6502 machine. Mirrors
 * `debug/z80/service.ts`; a 6502 machine wires `M6502DebugService` with its
 * concrete CPU and memory. Imports only cores, the sibling disassembler, and
 * the SPI *types* from machine.ts.
 */

import { M6502, FLAG_C, FLAG_D, FLAG_I, FLAG_N, FLAG_V, FLAG_Z } from '@/cores/m6502.ts';
import { disasmOne, disassembleAroundPC, formatDisasmHtml, stripMarkers } from '@/debug/m6502/disasm.ts';
import { hex8, hex16 } from '@/utils/hex.ts';
import type {
  CpuPorts, DebugPanelDescriptor, DebugService, DisasmRow, Machine,
  RegisterDesc, RegisterSnapshot,
} from '@/machines/machine.ts';

/** The structural surface a 6502 machine offers its debug service. */
export interface M6502DebugTarget extends Machine {
  cpu: M6502;
  startTrace(mode?: string): void;
  stopTrace(): string;
  ocrScreenForMcp(mode?: string): string;
  resolveMemoryRegion?(value: string): { data: Uint8Array; baseAddr: number } | null;
  screenExportBytes?(): Uint8Array | null;
  ramExportBytes?(): { data: Uint8Array; filename: string } | null;
}

/** Family accessor: the 6502 CPU of a machine, or null for another family. */
export function m6502Cpu(m: Machine): M6502 | null {
  return m.descriptor.cpuFamily === 'm6502' ? (m as M6502DebugTarget).cpu : null;
}

export class M6502DebugService implements DebugService {
  readonly cpuFamily = 'm6502' as const;

  /** The 6502 has no I/O-port space — hardware is memory-mapped. */
  readonly ports: CpuPorts | null = null;

  constructor(private readonly m: M6502DebugTarget) {}

  get pc(): number { return this.m.cpu.pc; }
  get tStates(): number { return this.m.cpu.tStates; }

  regs(): RegisterSnapshot {
    const cpu = this.m.cpu;
    const r8 = (name: string, value: number, group: string): RegisterDesc =>
      ({ name, width: 8, value, group });
    const r16 = (name: string, value: number, group: string): RegisterDesc =>
      ({ name, width: 16, value, group });
    return {
      pc: cpu.pc,
      sp: cpu.sp,
      tStates: cpu.tStates,
      im: 0,
      iff1: (cpu.p & FLAG_I) !== 0,
      halted: false,
      flags: [
        { name: 'N', set: (cpu.p & FLAG_N) !== 0 },
        { name: 'V', set: (cpu.p & FLAG_V) !== 0 },
        { name: 'D', set: (cpu.p & FLAG_D) !== 0 },
        { name: 'I', set: (cpu.p & FLAG_I) !== 0 },
        { name: 'Z', set: (cpu.p & FLAG_Z) !== 0 },
        { name: 'C', set: (cpu.p & FLAG_C) !== 0 },
      ],
      regs: [
        r8('A', cpu.a, 'main'), r8('X', cpu.x, 'main'), r8('Y', cpu.y, 'main'),
        r8('P', cpu.p, 'main'),
        r16('SP', 0x0100 | cpu.sp, 'main'), r16('PC', cpu.pc, 'main'),
      ],
    };
  }

  getReg(name: string): number | null {
    const cpu = this.m.cpu;
    switch (name.toUpperCase()) {
      case 'A':  return cpu.a;
      case 'X':  return cpu.x;
      case 'Y':  return cpu.y;
      case 'P':  case 'F': case 'SR': return cpu.p;
      case 'S':  case 'SP': return cpu.sp;
      case 'PC': return cpu.pc;
      default: return null;
    }
  }

  setReg(name: string, value: number): boolean {
    const cpu = this.m.cpu;
    switch (name.toUpperCase()) {
      case 'A':  cpu.a = value & 0xFF; break;
      case 'X':  cpu.x = value & 0xFF; break;
      case 'Y':  cpu.y = value & 0xFF; break;
      case 'P':  case 'F': case 'SR': cpu.p = value & 0xFF; break;
      case 'S':  case 'SP': cpu.sp = value & 0xFF; break;
      case 'PC': cpu.pc = value & 0xFFFF; break;
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
      const bytes = Array.from({ length: dl.length }, (_, j) => hex8(snap[(a + j) & 0xFFFF])).join(' ');
      out.push({
        addr: dl.addr, bytes, text: stripMarkers(dl.text),
        length: dl.length, isTerminal: dl.isTerminal,
      });
      a = (a + dl.length) & 0xFFFF;
    }
    return out;
  }

  disasmPaneHtml(lines: number): string {
    const snap = this.m.memory.snapshot();
    const pc = this.m.cpu.pc;
    return formatDisasmHtml(disassembleAroundPC(snap, pc, lines), snap, pc, this.m.breakpoints);
  }

  stepOne(): void { this.m.cpu.step(); }

  stepInto(): void { this.m.cpu.step(); }

  /** Step over JSR (0x20); everything else completes in one instruction. */
  stepOver(): void {
    const cpu = this.m.cpu;
    const op = this.m.memory.readByte(cpu.pc);
    if (op !== 0x20) { cpu.step(); return; }
    const targetSP = cpu.sp;
    const limit = cpu.tStates + 10_000_000;
    cpu.step();
    while (cpu.sp !== targetSP && cpu.tStates < limit) cpu.step();
  }

  /** Run until the current subroutine's RTS returns (SP moves back past it). */
  stepOut(): void {
    const cpu = this.m.cpu;
    const targetSP = (cpu.sp + 2) & 0xFF;
    const limit = cpu.tStates + 20_000_000;
    while (cpu.sp !== targetSP && cpu.tStates < limit) cpu.step();
  }

  cpuStateText(): string {
    const cpu = this.m.cpu;
    const flagStr = [
      (cpu.p & FLAG_N) ? 'N' : '-',
      (cpu.p & FLAG_V) ? 'V' : '-',
      (cpu.p & FLAG_D) ? 'D' : '-',
      (cpu.p & FLAG_I) ? 'I' : '-',
      (cpu.p & FLAG_Z) ? 'Z' : '-',
      (cpu.p & FLAG_C) ? 'C' : '-',
    ].join('');

    const lines = [
      `A   ${hex8(cpu.a)}   X   ${hex8(cpu.x)}   Y   ${hex8(cpu.y)}`,
      `P   ${hex8(cpu.p)}  ${flagStr}`,
      `SP  ${hex16(0x0100 | cpu.sp)}   PC  ${hex16(cpu.pc)}`,
      `T-states: ${cpu.tStates}`,
      '',
      'Disassembly:',
    ];

    const snap = this.m.memory.snapshot();
    let addr = cpu.pc;
    for (let i = 0; i < 16; i++) {
      const dl = disasmOne(snap, addr);
      const bytesStr = Array.from({ length: dl.length }, (_, j) => hex8(snap[(addr + j) & 0xFFFF]))
        .join(' ')
        .padEnd(11, ' ');
      const mnem = stripMarkers(dl.text).padEnd(24, ' ');
      lines.push(`${dl.addr === cpu.pc ? '>' : ' '} ${hex16(addr)}  ${bytesStr}  ${mnem}`);
      addr = (addr + dl.length) & 0xFFFF;
    }
    return lines.join('\n');
  }

  stepLine(): string {
    const cpu = this.m.cpu;
    const mnem = this.disasm(cpu.pc, 1)[0].text.padEnd(18);
    return (
      `${hex16(cpu.pc)}  ${mnem}` +
      `A=${hex8(cpu.a)} X=${hex8(cpu.x)} Y=${hex8(cpu.y)} ` +
      `SP=${hex16(0x0100 | cpu.sp)} P=${hex8(cpu.p)}  T=${cpu.tStates}`
    );
  }

  regsText(): string {
    const cpu = this.m.cpu;
    const flagBits: readonly (readonly [number, string])[] = [
      [FLAG_N, 'N'], [FLAG_V, 'V'], [FLAG_D, 'D'],
      [FLAG_I, 'I'], [FLAG_Z, 'Z'], [FLAG_C, 'C'],
    ];
    const flags = flagBits.map(([bit, ch]) => (cpu.p & bit) ? ch : '-').join('');
    return [
      `A  ${hex8(cpu.a)}  X  ${hex8(cpu.x)}  Y  ${hex8(cpu.y)}   P  ${hex8(cpu.p)}  Flags: ${flags}`,
      `SP ${hex16(0x0100 | cpu.sp)}  PC ${hex16(cpu.pc)}`,
      `T-states: ${cpu.tStates}`,
    ].join('\n');
  }

  regsSummary(): string {
    const cpu = this.m.cpu;
    return `A=${hex8(cpu.a)} X=${hex8(cpu.x)} Y=${hex8(cpu.y)} P=${hex8(cpu.p)}`;
  }

  /** Words on the stack from SP upward — the RTS chain, innermost first. */
  returnStack(depth: number): number[] {
    const mem = this.m.memory;
    const sp = this.m.cpu.sp;
    const out: number[] = [];
    for (let i = 0; i < depth; i++) {
      const lo = mem.readByte((sp + 1 + i * 2) & 0xFF);
      const hi = mem.readByte((sp + 2 + i * 2) & 0xFF);
      out.push((hi << 8) | lo);
    }
    return out;
  }

  /** Synthetic RTS: pop the return address into PC (and skip its +1 byte). */
  returnFromCall(): void {
    const cpu = this.m.cpu;
    const lo = this.m.memory.readByte((cpu.sp + 1) & 0xFF);
    const hi = this.m.memory.readByte((cpu.sp + 2) & 0xFF);
    cpu.sp = (cpu.sp + 2) & 0xFF;
    cpu.pc = ((hi << 8) | lo) + 1 & 0xFFFF;
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
