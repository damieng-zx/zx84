/**
 * C128DebugService — the debugger over the 128's two CPUs.
 *
 * The machine starts on the Z80 (its BIOS) and runs on the 8502, one at a time
 * (the MMU's mode register says which). This delegates to the 6502 family's
 * service while the 8502 is in charge and to the Z80 family's while the Z80
 * is, so the registers, disassembly, stepping, breakpoints and trace are those
 * of whichever CPU runs. The Z80 sees its own address space (its BIOS at
 * $0000, I/O only through IN and OUT); it is given to the Z80 service as a
 * host of its own over the machine.
 */

import { M6502DebugService } from '@/debug/m6502/service.ts';
import { Z80DebugService } from '@/debug/z80/service.ts';
import type { ChipSection } from '@/debug/chip-state.ts';
import type {
  CpuFamily, CpuPorts, DebugPanelDescriptor, DebugService, DisasmRow, MachineTraceMode, RegisterSnapshot,
} from '@/machines/machine.ts';
import type { C128Machine } from '../c128-machine.ts';

export class C128DebugService implements DebugService {
  private readonly e8502: M6502DebugService;
  private readonly z80: Z80DebugService;

  constructor(private readonly m: C128Machine) {
    this.e8502 = new M6502DebugService(m);
    const mem = m.memory;
    this.z80 = new Z80DebugService({
      cpu: m.z80,
      memory: { readByte: a => mem.z80Read(a), snapshot: () => mem.z80Snapshot() },
      get breakpoints() { return m.breakpoints; },
      stepInstruction: () => m.stepInstruction(),
      startTrace: mode => m.startTrace(mode),
      stopTrace: () => m.stopTrace(),
      traceSession: () => m.traceSession(),
      ocrScreenForMcp: mode => m.ocrScreenForMcp(mode),
      resolveMemoryRegion: value => m.resolveMemoryRegion(value),
      ramExportBytes: () => m.ramExportBytes(),
    });
  }

  /** The service of the CPU in charge. */
  private get cur(): DebugService { return this.m.cpuIs8502 ? this.e8502 : this.z80; }

  get cpuFamily(): CpuFamily { return this.cur.cpuFamily; }
  get ports(): CpuPorts | null { return this.cur.ports; }
  get pc(): number { return this.cur.pc; }
  get tStates(): number { return this.cur.tStates; }

  regs(): RegisterSnapshot { return this.cur.regs(); }
  getReg(name: string): number | null { return this.cur.getReg(name); }
  setReg(name: string, value: number): boolean { return this.cur.setReg(name, value); }
  disasm(addr: number, lines: number): DisasmRow[] { return this.cur.disasm(addr, lines); }
  disasmPaneHtml(lines: number): string { return this.cur.disasmPaneHtml(lines); }
  stepOne(): void { this.cur.stepOne(); }
  stepInto(): void { this.cur.stepInto(); }
  stepOver(): void { this.cur.stepOver(); }
  stepOut(): void { this.cur.stepOut(); }
  cpuStateText(): string { return this.cur.cpuStateText(); }
  stepLine(): string { return this.cur.stepLine(); }
  regsText(): string { return this.cur.regsText(); }
  regsSummary(): string { return this.cur.regsSummary(); }
  returnStack(depth: number): number[] { return this.cur.returnStack(depth); }
  returnFromCall(): void { this.cur.returnFromCall(); }

  startTrace(mode?: string): void { this.m.startTrace(mode); }
  stopTrace(): string { return this.m.stopTrace(); }
  traceSession(): MachineTraceMode | null { return this.m.traceSession(); }
  ocr(mode?: string): string { return this.m.ocrScreenForMcp(mode); }

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null { return this.m.resolveMemoryRegion(value); }
  screenExport(): Uint8Array | null { return this.e8502.screenExport(); }
  ramExport(): { data: Uint8Array; filename: string } | null { return this.m.ramExportBytes(); }
  panels(): DebugPanelDescriptor[] { return []; }
  chips(): readonly ChipSection[] { return this.m.chips(); }
}
