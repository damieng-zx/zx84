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
import { Dynamic } from 'solid-js/web';
import type { CpuFamily } from '@/machines/machine.ts';
import { machineCpuFamily } from '@/state/machine-caps.ts';
import { Z80Registers } from './registers/Z80Registers.tsx';
import { GenericRegisters } from './registers/GenericRegisters.tsx';

/** Exhaustive over CpuFamily on purpose: adding a family is a decision here. */
const PANELS: Record<CpuFamily, Component> = {
  z80: Z80Registers,
  m6502: GenericRegisters,
};

export function Registers() {
  return <Dynamic component={PANELS[machineCpuFamily()] ?? GenericRegisters} />;
}
