/**
 * Pure formatting + parsing helpers shared by every tool module.
 * No global state mutation here; reads `symbols` from state.ts.
 */

import { is128kClass } from '../src/models.ts';
import type { Machine } from '../src/machines/machine.ts';
import { hex8 as h8, hex16 as h16 } from '../src/utils/hex.ts';
import { symbols } from './state.ts';
import { activeSpectrum } from './concrete.ts';

/** Throws instead of returning NaN: NaN & 0xFFFF is 0, so a typo'd symbol
 *  or bad hex would otherwise silently read — or write — address 0x0000. */
export function parseAddr(s: string): number {
  const raw = s.trim();
  // Explicit hex prefix wins — never resolve as a symbol.
  if (raw.startsWith('0x') || raw.startsWith('0X')) return parseHex(raw.slice(2), s);
  if (raw.startsWith('$')) return parseHex(raw.slice(1), s);
  // Identifier-shaped tokens resolve via the symbol table when one is loaded.
  // (Hex addresses can't start with a letter — `face`, `dead` etc. are rare
  // enough that symbol-first is the right default; users can disambiguate
  // with a `0x` prefix.)
  if (/^[A-Za-z_]/.test(raw)) {
    const sym = symbols.lookup(raw);
    if (sym) return sym.value;
  }
  // Plain hex — addresses are hex by default in every CPU family we debug.
  return parseHex(raw, s);
}

function parseHex(digits: string, original: string): number {
  if (!/^[0-9A-Fa-f]+$/.test(digits)) {
    throw new Error(
      `Invalid address "${original}" — expected hex (optionally 0x/$-prefixed) or a loaded symbol name`);
  }
  return parseInt(digits, 16);
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
  'enter': 'Enter', 'space': 'Space', 'period': 'Period',
  'shift': 'ShiftLeft', 'sym': 'ControlLeft',
  'backspace': 'Backspace', 'delete': 'Delete',
  'left': 'ArrowLeft', 'right': 'ArrowRight',
  'up': 'ArrowUp', 'down': 'ArrowDown',
  'capslock': 'CapsLock', 'escape': 'Escape', 'esc': 'Escape',
  // Numeric keypad — on the CPC these are the function keys (f0–f9), e.g. the
  // firmware boot menu's "f2 Burnin' Rubber" is Numpad2. Harmless on machines
  // whose matrix has no numpad (handleKeyEvent just returns false).
  'numpad0': 'Numpad0', 'numpad1': 'Numpad1', 'numpad2': 'Numpad2',
  'numpad3': 'Numpad3', 'numpad4': 'Numpad4', 'numpad5': 'Numpad5',
  'numpad6': 'Numpad6', 'numpad7': 'Numpad7', 'numpad8': 'Numpad8',
  'numpad9': 'Numpad9', 'numpadenter': 'NumpadEnter', 'numpaddot': 'NumpadDecimal',
  // Aliases so "f2" works as the CPC firmware function key.
  'f0': 'Numpad0', 'f1': 'Numpad1', 'f2': 'Numpad2', 'f3': 'Numpad3',
  'f4': 'Numpad4', 'f5': 'Numpad5', 'f6': 'Numpad6', 'f7': 'Numpad7',
  'f8': 'Numpad8', 'f9': 'Numpad9',
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

/** One-line "PC, instruction, working registers, elapsed time" step trace.
 *  The layout is the CPU family's — this is only where the tools reach it. */
export function formatStep(spec: Machine): string {
  return spec.services.debug.stepLine();
}

/** One-line 128K-class Spectrum paging state, or null on 16K/48K and on
 *  non-Spectrum machines. Shared by `registers`, `port_out`, and the reset
 *  trap so the banking readout is formatted in exactly one place. */
export function spectrumPagingLine(): string | null {
  const s = activeSpectrum();
  if (!s || !is128kClass(s.model)) return null;
  const mem = s.memory;
  return `Bank: ${mem.currentBank}  ROM: ${mem.currentROM}  7FFD: ${h8(mem.port7FFD)}  Locked: ${mem.pagingLocked ? 'Y' : 'N'}`;
}

/** The `registers` readout: the CPU family's own register/flag block, plus the
 *  machine's banking line when it has one. */
export function formatRegs(spec: Machine): string {
  const lines = [spec.services.debug.regsText()];
  const paging = spectrumPagingLine();
  if (paging) lines.push(paging);
  return lines.join('\n');
}

/** Returns a one-line watchpoint/breakpoint hit message, or null if none. */
export function checkWatchHit(spec: Machine): string | null {
  const dbg = spec.services.debug;
  if (spec.portWatchHit !== null) {
    const { port, value, dir } = spec.portWatchHit;
    return `Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  PC=${h16(dbg.pc)}\n${formatStep(spec)}`;
  }
  if (spec.memWatchHit !== null) {
    const { addr, value, dir } = spec.memWatchHit;
    return `Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  PC=${h16(dbg.pc)}\n${formatStep(spec)}`;
  }
  if (spec.breakpointHit >= 0) {
    return `Breakpoint at ${h16(spec.breakpointHit)}. T=${dbg.tStates}\n${formatStep(spec)}`;
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
