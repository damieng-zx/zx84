/**
 * Debug Manager — the shell's family-neutral debugging orchestration.
 *
 * All CPU-family reasoning (halted-wake, step-over/step-out opcode analysis,
 * register/disassembly formatting) lives in the machine's `services.debug`
 * provider (`machines/debug-z80/` for the Z80 machines); this manager only
 * sequences those operations against UI callbacks and owns the generic
 * breakpoint conveniences (toggle, run-to).
 */

import type { Machine } from '@/machines/machine.ts';
import { hex16 } from '@/utils/hex.ts';

export type TraceMode = 'full' | 'portio' | 'zxtl';

export class DebugManager {
  /** Address of a temporary "run to" breakpoint to clean up on hit */
  private pendingRunTo = -1;

  getPendingRunTo(): number {
    return this.pendingRunTo;
  }

  clearPendingRunTo(): void {
    this.pendingRunTo = -1;
  }

  /** Execute a single instruction (a halted CPU steps into its interrupt
   *  handler instead of spinning on the HALT — family provider semantics). */
  stepInto(machine: Machine, onUpdate: () => void): void {
    machine.services.debug.stepInto();
    onUpdate();
  }

  /** Step over CALL/RST/conditional-jump/block-repeat instructions. */
  stepOver(machine: Machine, onUpdate: () => void): void {
    machine.services.debug.stepOver();
    onUpdate();
  }

  /** Step out of the current function (run until RET brings SP back). */
  stepOut(machine: Machine, onUpdate: () => void): void {
    machine.services.debug.stepOut();
    onUpdate();
  }

  /** Run exactly one frame (to the next frame boundary) and update the display. */
  stepFrame(machine: Machine, onUpdate: () => void): void {
    machine.tick();
    if (machine.display) machine.display.updateTexture(machine.pixels);
    onUpdate();
  }

  /** Toggle breakpoint at address. */
  toggleBreakpoint(
    machine: Machine,
    addr: number,
    onStatus: (msg: string) => void,
    onUpdate: () => void
  ): void {
    if (machine.breakpoints.has(addr)) {
      machine.breakpoints.delete(addr);
      onStatus(`Breakpoint removed at ${hex16(addr)}`);
    } else {
      machine.breakpoints.add(addr);
      onStatus(`Breakpoint set at ${hex16(addr)}`);
    }
    onUpdate();
  }

  /** Run to address (set temporary breakpoint). */
  runTo(
    machine: Machine,
    addr: number,
    emulationPaused: boolean,
    onResume: () => void
  ): void {
    const wasSet = machine.breakpoints.has(addr);
    machine.breakpoints.add(addr);

    if (!wasSet) {
      this.pendingRunTo = addr;
    }

    if (emulationPaused) {
      machine.start();
      onResume();
    }
  }

  /** Start execution tracing. */
  startTrace(machine: Machine, mode: TraceMode = 'full', onStart: () => void): void {
    machine.services.debug.startTrace(mode);
    onStart();
  }

  /** Stop execution tracing and return trace text. */
  stopTrace(machine: Machine, onStop: (text: string, lineCount: number) => void): void {
    const text = machine.services.debug.stopTrace();
    const lines = text === '' ? 0 : text.split('\n').length;
    onStop(text, lines);
  }

  /**
   * Copy CPU state and disassembly to clipboard. Awaits the clipboard write so
   * a permission denial or transient failure is reported via `onStatus`.
   */
  async copyCpuState(machine: Machine, onStatus: (msg: string) => void): Promise<void> {
    try {
      await navigator.clipboard.writeText(machine.services.debug.cpuStateText());
      onStatus('CPU state + disassembly copied to clipboard');
    } catch (err) {
      onStatus(`Clipboard copy failed: ${(err as Error).message}`);
    }
  }
}
