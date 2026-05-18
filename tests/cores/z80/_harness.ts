/**
 * Shared test harness for the Z80 CPU core tests.
 *
 * Builds short programs in a flat 64KB RAM, wires it to a fresh CPU via
 * cpu.read8/write8, and assert post-execution register/flag/memory state.
 * No reliance on the Spectrum harness — these are pure CPU tests.
 *
 * Flag constants — documented Z80 layout:
 *   S Z F5 H F3 PV N C
 *   7 6  5 4  3  2 1 0
 */

import { Z80 } from '@/cores/z80.ts';

export const F_S  = 0x80;
export const F_Z  = 0x40;
export const F_F5 = 0x20;
export const F_H  = 0x10;
export const F_F3 = 0x08;
export const F_PV = 0x04;
export const F_N  = 0x02;
export const F_C  = 0x01;

export interface Harness {
  cpu: Z80;
  mem: Uint8Array;
  ports: Map<number, number>;
  portReads: number[];
  portWrites: { port: number; val: number }[];
}

export function newCpu(): Harness {
  const cpu = new Z80();
  const mem = new Uint8Array(0x10000);
  const ports = new Map<number, number>();
  const portReads: number[] = [];
  const portWrites: { port: number; val: number }[] = [];
  cpu.read8 = (a) => mem[a & 0xFFFF];
  cpu.write8 = (a, v) => { mem[a & 0xFFFF] = v & 0xFF; };
  cpu.portInHandler = (port) => { portReads.push(port); return ports.get(port & 0xFFFF) ?? 0xFF; };
  cpu.portOutHandler = (port, val) => { portWrites.push({ port, val }); ports.set(port & 0xFFFF, val & 0xFF); };
  cpu.pc = 0;
  cpu.sp = 0xFFFF;
  return { cpu, mem, ports, portReads, portWrites };
}

export function load(mem: Uint8Array, addr: number, ...bytes: number[]): void {
  for (let i = 0; i < bytes.length; i++) mem[(addr + i) & 0xFFFF] = bytes[i] & 0xFF;
}

export function step(h: Harness, n = 1): void {
  for (let i = 0; i < n; i++) h.cpu.step();
}
