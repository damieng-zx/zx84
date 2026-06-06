/**
 * Pure formatting + parsing helpers shared by every tool module.
 * No global state mutation here; reads `symbols` from state.ts.
 */

import { is128kClass } from '../src/models.ts';
import { type Machine, asSpectrum } from '../src/machine.ts';
import { disasmOne, stripMarkers } from '../src/debug/z80-disasm.ts';
import { h8, h16 } from './hex.ts';
import { symbols } from './state.ts';

export function parseAddr(s: string): number {
  const raw = s.trim();
  // Explicit hex prefix wins — never resolve as a symbol.
  if (raw.startsWith('0x') || raw.startsWith('0X')) return parseInt(raw.slice(2), 16);
  if (raw.startsWith('$')) return parseInt(raw.slice(1), 16);
  // Identifier-shaped tokens resolve via the symbol table when one is loaded.
  // (Hex addresses can't start with a letter — `face`, `dead` etc. are rare
  // enough that symbol-first is the right default; users can disambiguate
  // with a `0x` prefix.)
  if (/^[A-Za-z_]/.test(raw)) {
    const sym = symbols.lookup(raw);
    if (sym) return sym.value;
  }
  // Plain hex — this is a Z80 debugger.
  return parseInt(raw, 16);
}

export const KEY_NAME_MAP: Record<string, string> = {
  'a': 'KeyA', 'b': 'KeyB', 'c': 'KeyC', 'd': 'KeyD', 'e': 'KeyE',
  'f': 'KeyF', 'g': 'KeyG', 'h': 'KeyH', 'i': 'KeyI', 'j': 'KeyJ',
  'k': 'KeyK', 'l': 'KeyL', 'm': 'KeyM', 'n': 'KeyN', 'o': 'KeyO',
  'p': 'KeyP', 'q': 'KeyQ', 'r': 'KeyR', 's': 'KeyS', 't': 'KeyT',
  'u': 'KeyU', 'v': 'KeyV', 'w': 'KeyW', 'x': 'KeyX', 'y': 'KeyY',
  'z': 'KeyZ',
  '0': 'Digit0', '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', '4': 'Digit4',
  '5': 'Digit5', '6': 'Digit6', '7': 'Digit7', '8': 'Digit8', '9': 'Digit9',
  'enter': 'Enter', 'space': 'Space',
  'shift': 'ShiftLeft', 'sym': 'ControlLeft',
  'backspace': 'Backspace', 'delete': 'Delete',
  'left': 'ArrowLeft', 'right': 'ArrowRight',
  'up': 'ArrowUp', 'down': 'ArrowDown',
  'capslock': 'CapsLock', 'escape': 'Escape', 'esc': 'Escape',
};

/** Spectrum keyboard mapping for printable characters (used by `type`). */
export const CHAR_KEYS: Record<string, string[]> = {
  '"': ['sym', 'p'], ':': ['sym', 'z'], ';': ['sym', 'o'],
  ',': ['sym', 'n'], '.': ['sym', 'm'], '!': ['sym', '1'],
  '@': ['sym', '2'], '#': ['sym', '3'], '$': ['sym', '4'],
  '%': ['sym', '5'], '&': ['sym', '6'], "'": ['sym', '7'],
  '(': ['sym', '8'], ')': ['sym', '9'], '_': ['sym', '0'],
  '<': ['sym', 'r'], '>': ['sym', 't'], '-': ['sym', 'j'],
  '+': ['sym', 'k'], '=': ['sym', 'l'], '*': ['sym', 'b'],
  '/': ['sym', 'v'], '?': ['sym', 'c'], '^': ['sym', 'h'],
  '~': ['sym', 'a'], '|': ['sym', 's'], '\\': ['sym', 'd'],
  '{': ['sym', 'f'], '}': ['sym', 'g'],
  '[': ['shift', 'sym', 'y'], ']': ['shift', 'sym', 'u'],  // extended mode
  '\n': ['enter'],
};

export function formatStep(spec: Machine): string {
  const cpu = spec.cpu;
  const snap = spec.memory.snapshot();
  const line = disasmOne(snap, cpu.pc);
  const mnem = stripMarkers(line.text).padEnd(20);
  return (
    `${h16(cpu.pc)}  ${mnem}` +
    `A=${h8(cpu.a)} F=${h8(cpu.f)} ` +
    `BC=${h16(cpu.bc)} DE=${h16(cpu.de)} HL=${h16(cpu.hl)} ` +
    `SP=${h16(cpu.sp)}  T=${cpu.tStates}`
  );
}

export function formatRegs(spec: Machine): string {
  const cpu = spec.cpu;
  const f = cpu.f;
  const flags = [
    (f & 0x80) ? 'S' : '-', (f & 0x40) ? 'Z' : '-',
    (f & 0x10) ? 'H' : '-', (f & 0x04) ? 'P' : '-',
    (f & 0x02) ? 'N' : '-', (f & 0x01) ? 'C' : '-',
  ].join('');
  const iff = cpu.iff1 ? 'EI' : 'DI';
  const halt = cpu.halted ? ' HALT' : '';
  const lines = [
    `AF  ${h16(cpu.af)}  AF' ${h16((cpu.a_ << 8) | cpu.f_)}   Flags: ${flags}`,
    `BC  ${h16(cpu.bc)}  BC' ${h16((cpu.b_ << 8) | cpu.c_)}`,
    `DE  ${h16(cpu.de)}  DE' ${h16((cpu.d_ << 8) | cpu.e_)}`,
    `HL  ${h16(cpu.hl)}  HL' ${h16((cpu.h_ << 8) | cpu.l_)}`,
    `IX  ${h16(cpu.ix)}  IY  ${h16(cpu.iy)}   ${iff}  IM${cpu.im}${halt}`,
    `SP  ${h16(cpu.sp)}  PC  ${h16(cpu.pc)}   IR  ${h8(cpu.i)}${h8(cpu.r)}`,
    `T-states: ${cpu.tStates}`,
  ];
  const s = asSpectrum(spec);
  if (s && is128kClass(s.model)) {
    const mem = s.memory;
    lines.push(`Bank: ${mem.currentBank}  ROM: ${mem.currentROM}  7FFD: ${h8(mem.port7FFD)}  Locked: ${mem.pagingLocked ? 'Y' : 'N'}`);
  }
  return lines.join('\n');
}

/** Returns a one-line watchpoint/breakpoint hit message, or null if none. */
export function checkWatchHit(spec: Machine): string | null {
  if (spec.portWatchHit !== null) {
    const { port, value, dir } = spec.portWatchHit;
    return `Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`;
  }
  if (spec.memWatchHit !== null) {
    const { addr, value, dir } = spec.memWatchHit;
    return `Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`;
  }
  if (spec.breakpointHit >= 0) {
    return `Breakpoint at ${h16(spec.breakpointHit)}. T=${spec.cpu.tStates}\n${formatStep(spec)}`;
  }
  return null;
}

export function formatHexDump(readByte: (addr: number) => number, start: number, len: number): string {
  const lines: string[] = [];
  for (let i = 0; i < len; i += 16) {
    const addr = (start + i) & 0xFFFF;
    let hex = '';
    let ascii = '';
    for (let j = 0; j < 16 && i + j < len; j++) {
      const b = readByte((addr + j) & 0xFFFF);
      hex += h8(b) + ' ';
      ascii += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
    }
    lines.push(`${h16(addr)}  ${hex.padEnd(48)} ${ascii}`);
  }
  return lines.join('\n');
}

export function doFindBytes(readByte: (addr: number) => number, needle: Uint8Array): string {
  const results: number[] = [];
  for (let i = 0; i <= 0xFFFF - needle.length + 1; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (readByte(i + j) !== needle[j]) { match = false; break; }
    }
    if (match) results.push(i);
    if (results.length >= 64) break;
  }
  if (results.length === 0) return 'Not found';
  return `Found ${results.length} match(es): ${results.map(h16).join(', ')}`;
}

/** Wrap a string as an MCP text result. */
export function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}
