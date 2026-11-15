/**
 * The debugger's register panel, chosen by the active machine's CPU family.
 *
 * The pane itself stays family-blind: it renders <Registers /> and this module
 * resolves which layout that means. A family with a hand-laid-out panel gets it
 * (Z80); any other family falls back to the generic snapshot-driven table, so a
 * new CPU is debuggable the day its DebugService lands and gains a tailored
 * panel later by adding one line here.
 */

import type { Component } from 'solid-js';
import { createMemo } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { machine } from '@/shell/context.ts';
import { regsRev } from '@/state/debug-state.ts';
import type { CpuFamily } from '@/machines/machine.ts';
import { machineCpuFamily } from '@/state/machine-caps.ts';
import { Z80Registers } from './registers/Z80Registers.tsx';
import { GenericRegisters } from './registers/GenericRegisters.tsx';
import { M6502Registers } from './registers/M6502Registers.tsx';

/** Exhaustive over CpuFamily on purpose: adding a family is a decision here. */
const PANELS: Record<CpuFamily, Component> = {
  z80: Z80Registers,
  m6502: M6502Registers,
};

export function Registers() {
  // A machine with two CPUs (the Commodore 128's Z80 and 8502) debugs whichever
  // runs now; the others' family never changes, so their panel is never rebuilt.
  const family = createMemo(() => {
    regsRev();
    return machine?.services.debug.cpuFamily ?? machineCpuFamily();
  });
  return <Dynamic component={PANELS[family()] ?? GenericRegisters} />;
}
