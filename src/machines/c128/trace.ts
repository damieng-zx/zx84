/**
 * The 128's execution trace: one session over both of its CPUs.
 *
 * The 128 starts on the Z80 (its BIOS copies the 8502's start-up code into RAM
 * and hands over through the MMU's mode register) and runs on the 8502, so a
 * trace of a boot has both. Each CPU keeps its own family's engine
 * (`debug/z80/trace.ts`, `debug/m6502/trace.ts`) and its own line cap; this
 * one hands each instruction to the engine of the CPU that runs it, and joins
 * the two texts when the trace stops, the one that ran first first, each under
 * a heading. A trace that only ever saw one CPU is that engine's text as it
 * is. Modes are the union: `zxtl` is a Z80 layout and only the Z80 takes it.
 */

import type { MachineTraceMode } from '@/machines/machine.ts';
import type { MachineTracer } from '@/debug/trace.ts';

/** A family engine as this composite drives it. */
export interface CpuTraceEngine extends MachineTracer {
  /** Lines held, for the empty-section check. */
  readonly buffer: readonly string[];
}

export class C128Trace implements MachineTracer {
  session: MachineTraceMode | null = null;
  /** Engines that were started this session, in the order they first ran. */
  private ran: CpuTraceEngine[] = [];
  private started: CpuTraceEngine[] = [];
  /** The engine `before()` handed the instruction in progress to. */
  private current: CpuTraceEngine | null = null;

  constructor(
    private readonly z80: CpuTraceEngine,
    private readonly m6502: CpuTraceEngine,
    /** The CPU in charge: true for the 8502. */
    private readonly running8502: () => boolean,
  ) {}

  get active(): boolean { return this.z80.active || this.m6502.active; }

  supports(mode: string): mode is MachineTraceMode { return this.z80.supports(mode) || this.m6502.supports(mode); }

  start(mode: MachineTraceMode): void {
    this.stop();
    this.ran = [];
    this.current = null;
    this.started = [this.z80, this.m6502].filter(e => e.supports(mode));
    for (const e of this.started) e.start(mode);
    this.session = mode;
  }

  before(): void {
    const e = this.running8502() ? this.m6502 : this.z80;
    this.current = e.active ? e : null;
    if (!this.current) return;
    if (!this.ran.includes(e)) this.ran.push(e);
    e.before();
  }

  after(): void {
    this.current?.after();
    this.current = null;
  }

  stop(): string {
    const started = this.started;
    this.started = [];
    this.session = null;
    this.current = null;
    if (started.length === 0) return '';
    const texts = new Map<CpuTraceEngine, string>(started.map(e => [e, e.stop()]));
    // The engines that never ran an instruction have nothing to say; one that ran alone is as it is.
    const order = [...this.ran, ...started.filter(e => !this.ran.includes(e))];
    const speaking = order.filter(e => this.ran.includes(e) && (texts.get(e) ?? '') !== '');
    if (speaking.length === 0) return texts.get(started[0]) ?? '';
    if (speaking.length === 1) return texts.get(speaking[0]) ?? '';
    return speaking.map(e => `--- ${e === this.z80 ? 'Z80' : '8502'} ---\n${texts.get(e)}`).join('\n\n');
  }
}
