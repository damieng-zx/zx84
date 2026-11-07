/**
 * Execution-trace substrate shared by the CPU-family trace engines
 * (`debug/z80/trace.ts`, `debug/m6502/trace.ts`).
 *
 * What is common to every family lives here: the `MachineTracer` contract a
 * machine's frame loop drives, and `TraceEngine` — the session lifecycle, the
 * line buffer and its cap, tight-loop folding, and the I/O tally and its
 * summary. The family engines add the CPU-shaped parts (register layout,
 * disassembly, operand context, how I/O accesses are tapped).
 *
 * Nothing here runs unless a trace is capturing: the frame loop checks
 * `active` once per instruction and calls in only when it is set.
 */

import type { MachineTraceMode } from '@/machines/machine.ts';
import { hex8, hex16 } from '@/utils/hex.ts';

/** The most lines a trace keeps. At that point it stops capturing (the frame
 *  probe reports it, so the UI stops and copies it) and `stop()` appends a
 *  marker, so a trace left running cannot exhaust the tab. A full-mode line is
 *  roughly 100 one-byte characters, so the cap is about 50MB of text. */
export const TRACE_MAX_LINES = 500_000;

/** The contract between a machine's frame loop and its trace engine. The loop
 *  calls `before()` right before each CPU step and `after()` right after it,
 *  each only while `active` is set. */
export interface MachineTracer {
  /** Capturing: the frame loop feeds it. Clears when stopped or full. */
  readonly active: boolean;
  /** The mode of the trace started and not yet stopped (it may have stopped
   *  capturing at the cap), or null. */
  readonly session: MachineTraceMode | null;
  supports(mode: string): mode is MachineTraceMode;
  start(mode: MachineTraceMode): void;
  stop(): string;
  before(): void;
  after(): void;
}

/** A machine with no trace engine: never captures. */
export const IDLE_TRACER: MachineTracer = {
  active: false,
  session: null,
  supports: (_mode: string): _mode is MachineTraceMode => false,
  start: () => {},
  stop: () => '',
  before: () => {},
  after: () => {},
};

/** One address (port, or memory-mapped register) in an I/O tally. */
export interface TallyEntry { count: number; pcs: Set<number>; vals: Set<number> }
export type IoTally = Map<number, TallyEntry>;

/** Count one access in a tally, keeping up to 32 distinct PCs and 64 values. */
export function tallyAccess(tally: IoTally, addr: number, pc: number, val: number): void {
  let entry = tally.get(addr);
  if (!entry) { entry = { count: 0, pcs: new Set(), vals: new Set() }; tally.set(addr, entry); }
  entry.count++;
  if (entry.pcs.size < 32) entry.pcs.add(pc);
  if (entry.vals.size < 64) entry.vals.add(val);
}

/** An I/O summary: a header, then each non-empty section, busiest address
 *  first. `label` names an address ('' for none). */
export function formatIoSummary(
  header: string, sections: readonly (readonly [string, IoTally | null])[], label: (addr: number) => string,
): string {
  const parts = [header, ''];
  for (const [title, tally] of sections) {
    if (!tally?.size) continue;
    const lines = [`${title}:`];
    for (const [addr, info] of [...tally.entries()].sort((a, b) => b[1].count - a[1].count)) {
      lines.push(`  ${hex16(addr)}  ${String(info.count).padStart(8)}x  ${(label(addr) || '').padEnd(6)} from ${[...info.pcs].map(hex16).join(',')}  vals ${[...info.vals].map(hex8).join(',')}`);
    }
    parts.push(lines.join('\n'), '');
  }
  return parts.join('\n');
}

/**
 * The family-independent half of a trace engine.
 *
 * Tight-loop folding: an instruction is folded when the last time its slot
 * (pc & 0x3FF) was traced it was at the same pc with the same register hash —
 * a loop going round without changing anything. A run of folded instructions
 * becomes one "loops back to" line.
 */
export abstract class TraceEngine implements MachineTracer {
  active = false;
  session: MachineTraceMode | null = null;
  mode: MachineTraceMode = 'full';
  buffer: string[] = [];
  /** The cap stopped the capture. */
  truncated = false;
  readonly maxLines: number;
  protected loopPC = new Int32Array(1024).fill(-1);
  protected loopHash = new Int32Array(1024);
  protected loopAddr = -1;
  protected loopCount = 0;
  /** Where the instruction being executed starts (set by `before`). */
  protected insnPc = -1;
  private untap: (() => void) | null = null;

  constructor(maxLines = TRACE_MAX_LINES) {
    this.maxLines = maxLines;
  }

  abstract supports(mode: string): mode is MachineTraceMode;
  abstract before(): void;
  after(): void {}
  /** Set up a new session in `mode` (tallies, headers, taps). */
  protected abstract begin(mode: MachineTraceMode): void;
  /** The portio summary (and drop the tallies). */
  protected abstract ioSummary(): string;

  start(mode: MachineTraceMode = 'full'): void {
    if (!this.supports(mode)) return;
    this.removeTap();
    this.buffer = [];
    this.mode = mode;
    this.truncated = false;
    this.insnPc = -1;
    this.loopPC.fill(-1);
    this.loopHash.fill(0);
    this.loopAddr = -1;
    this.loopCount = 0;
    this.begin(mode);
    this.session = mode;
    this.active = true;
  }

  stop(): string {
    this.active = false;
    this.session = null;
    this.removeTap();
    if (this.mode === 'portio') return this.ioSummary();
    if (this.mode === 'full') {
      this.flushLoop();
      if (this.truncated) {
        this.buffer.push(`      ... trace truncated: stopped capturing at ${this.maxLines.toLocaleString('en-US')} lines`);
      }
    }
    return this.buffer.join('\n');
  }

  /** True when the instruction at `pc` with register hash `hash` folds; when
   *  it does not, a pending loop marker is written first. */
  protected fold(pc: number, hash: number): boolean {
    const slot = pc & 0x3FF;
    if (this.loopPC[slot] === pc && this.loopHash[slot] === hash) {
      if (this.loopCount === 0) this.loopAddr = pc;
      this.loopCount++;
      return true;
    }
    this.flushLoop();
    this.loopPC[slot] = pc;
    this.loopHash[slot] = hash;
    return false;
  }

  /** Write the pending loop marker, if any. */
  protected flushLoop(): void {
    if (this.loopCount > 0) {
      this.buffer.push(`      ... loops back to ${hex16(this.loopAddr)} x${this.loopCount}`);
      this.loopCount = 0;
    }
  }

  protected push(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length >= this.maxLines) this.capReached();
  }

  /** Stop capturing: the cap is reached. The session stays open for `stop()`. */
  protected capReached(): void {
    this.active = false;
    this.truncated = true;
    this.removeTap();
  }

  /** Register how to undo the I/O tap a session installed. */
  protected setTap(untap: () => void): void {
    this.untap = untap;
  }

  private removeTap(): void {
    if (this.untap) { this.untap(); this.untap = null; }
  }
}
