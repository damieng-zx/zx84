/**
 * Machine — the common surface shared by every emulated computer.
 *
 * ZX84 began as a Spectrum-only emulator with a single concrete `Spectrum`
 * class that the UI, frame-bridge, and MCP server reached into directly. Adding
 * a fundamentally different machine (the Amstrad CPC) means those consumers need
 * a machine-agnostic handle. This interface is that handle: the minimal surface
 * the lifecycle/driver layer (`emulator.ts`) and the debug layer (`mcp/`) need
 * to talk to *either* a `Spectrum` or a `CpcMachine`.
 *
 * Machine-specific concerns (the Spectrum's ULA/contention/tape/Multiface, the
 * CPC's CRTC/Gate Array/PPI) stay off this interface. Consumers that need them
 * narrow with `asSpectrum()` / a `kind` check.
 */

import type { Z80 } from '@/cores/z80.ts';
import type { AY3891x } from '@/cores/ay-3-8910.ts';
import type { UPD765A } from '@/cores/upd765a.ts';
import type { WD179x } from '@/cores/wd179x.ts';
import type { DskImage } from '@/floppy/disk-image.ts';
import type { AudioMixer } from '@/peripherals/audio-mixer.ts';
import type { TapeDeck } from '@/tape/tap.ts';
import type { IScreenRenderer } from '@/display/display.ts';
import type { DisasmLine } from '@/debug/z80-disasm.ts';
import type { ByteReader } from '@/memory.ts';
import type { MachineModel } from '@/models.ts';
import type { OcrGridName } from '@/debug/screen-text.ts';

export type MachineKind = 'spectrum' | 'cpc' | 'einstein';

/** The floppy controller as seen through the shared interface. The +3/CPC use
 *  the NEC uPD765A; the Einstein (and the +D/Beta Disk interfaces) use a Western
 *  Digital WD179x. Both expose the common surface the lifecycle/UI layer needs
 *  (insert/eject/getDiskImage, write-protect, force-ready, tickFrame). */
export type MachineFdc = UPD765A | WD179x;

/** Border-size selector shared by both machines: 0=none, 1=small, 2=normal. */
export type BorderMode = 0 | 1 | 2;

/** Trace flavours supported by the debug layer. */
export type MachineTraceMode = 'full' | 'portio' | 'zxtl';

/**
 * The common memory surface. Both `SpectrumMemory` and the CPC's memory expose
 * a live flat 64KB Z80 view plus the bulk accessors used by snapshots, the
 * debug tools, and MCP. Machine-specific paging state (port7FFD, ROM overlays)
 * stays on the concrete classes.
 */
export interface IMachineMemory extends ByteReader {
  readByte(addr: number): number;
  writeByte(addr: number, val: number): void;
  readBlock(addr: number, len: number): Uint8Array;
  /** Fresh 64KB copy of the current paged address space (debug/snapshot). */
  snapshot(): Uint8Array;
  /** A specific 16KB physical RAM bank as a live view. */
  getRamBank(n: number): Uint8Array;
  reset(): void;
}

export interface Machine {
  readonly kind: MachineKind;
  readonly model: MachineModel;

  // ── Shared cores ─────────────────────────────────────────────────────
  cpu: Z80;
  memory: IMachineMemory;
  ay: AY3891x;
  fdc: MachineFdc;
  /** Cassette deck. Both machines load TZX/CDT/TAP through the same pulse-level
   *  engine; machine-specific loader extras (the Spectrum's loader detector,
   *  tape turbo) stay off this interface and are reached via `asSpectrum()`. */
  tape: TapeDeck;
  mixer: AudioMixer;
  display: IScreenRenderer | null;

  /** RGBA frame buffer the machine renders into. */
  readonly pixels: Uint8Array;

  /** Nominal T-states per video frame (for the debugger's register readout). */
  readonly tStatesPerFrame: number;

  // ── Lifecycle / driver ───────────────────────────────────────────────
  start(): Promise<void>;
  stop(): void;
  destroy(): void;
  reset(): void;
  loadROM(data: Uint8Array): void;
  /** Insert a parsed disk image into a drive of the shared uPD765A FDC. */
  loadDisk(image: DskImage, unit?: number): void;
  setBorderSize(mode: BorderMode): void;
  /** Run one frame (headless / test harness). */
  tick(): void;
  /** Run up to maxFrames, stopping early on a breakpoint/watchpoint hit. */
  runUntil(maxFrames: number): number;
  turbo: boolean;

  // ── Debug surface (consumed by the MCP server) ───────────────────────
  breakpoints: Set<number>;
  breakpointHit: number;
  portWatchpoints: Set<number>;
  portWatchHit: { port: number; value: number; dir: 'in' | 'out' } | null;
  memWatchpoints: { start: number; end: number; mode: 'read' | 'write' | 'rw' }[];
  memWatchHit: { addr: number; value: number; dir: 'read' | 'write' } | null;
  onTrap: ((pc: number) => boolean) | null;
  onStatus: ((msg: string) => void) | null;
  onFrame: (() => void) | null;

  disasmAt(pc: number): DisasmLine;
  startTrace(mode?: MachineTraceMode): void;
  stopTrace(): string;
  ocrScreenForMcp(mode?: OcrGridName | 'auto'): string;
}

/** Narrow a Machine to a Spectrum, or null if it is a different machine. */
export function asSpectrum(m: Machine | null): import('@/spectrum.ts').Spectrum | null {
  return m && m.kind === 'spectrum' ? (m as unknown as import('@/spectrum.ts').Spectrum) : null;
}

/** Narrow a Machine to a CpcMachine, or null if it is a different machine. */
export function asCpc(m: Machine | null): import('@/cpc/cpc-machine.ts').CpcMachine | null {
  return m && m.kind === 'cpc' ? (m as unknown as import('@/cpc/cpc-machine.ts').CpcMachine) : null;
}

/** Narrow a Machine to an EinsteinMachine, or null if it is a different machine. */
export function asEinstein(m: Machine | null): import('@/einstein/einstein-machine.ts').EinsteinMachine | null {
  return m && m.kind === 'einstein' ? (m as unknown as import('@/einstein/einstein-machine.ts').EinsteinMachine) : null;
}
