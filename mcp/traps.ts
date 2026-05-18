/**
 * Trap system: pre-configured PC hooks with three modes —
 *   log     — record the call (registers, decoded info) to the buffer, continue
 *   break   — halt execution (like a breakpoint) so the MCP client can inspect
 *   respond — stuff registers from a pre-loaded response queue and RET, skipping
 *             the real code. Responses are consumed in FIFO order; when the queue
 *             is empty the trap reverts to "break".
 */

import type { Spectrum } from '../src/spectrum.ts';
import { h8, h16 } from './hex.ts';

export interface TrapResponse {
  /** Register values to set before RETurning. Only listed regs are changed. */
  regs: Record<string, number>;
}

export interface Trap {
  address: number;
  action: 'log' | 'break' | 'respond';
  /** Optional: only fire when C register equals this value (for BDOS function filtering) */
  condC?: number;
  /** Label shown in log output */
  label: string;
  /** Pre-queued responses for 'respond' mode */
  responses: TrapResponse[];
}

export const traps = new Map<number, Trap[]>();
export const trapLog: string[] = [];

/** Read a '$'-terminated CP/M string from memory starting at addr. */
function readCpmString(spec: Spectrum, addr: number, maxLen = 256): string {
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const ch = spec.memory.readByte((addr + i) & 0xFFFF);
    if (ch === 0x24) break; // '$'
    s += (ch >= 0x20 && ch < 0x7F) ? String.fromCharCode(ch) : '.';
  }
  return s;
}

/** Format a trap log entry with registers and optional CP/M decoding. */
export function formatTrapLog(trap: Trap, spec: Spectrum): string {
  const cpu = spec.cpu;
  let line = `[${h16(cpu.pc)}] ${trap.label}  C=${h8(cpu.c)} DE=${h16(cpu.de)} A=${h8(cpu.a)} T=${cpu.tStates}`;
  // Auto-decode common BDOS calls
  if (trap.address === 0x0005) {
    const fn = cpu.c;
    if (fn === 2) line += `  CON_OUT char='${String.fromCharCode(cpu.e)}'`;
    else if (fn === 9) line += `  PRINT_STR "${readCpmString(spec, cpu.de)}"`;
    else if (fn === 1) line += '  CON_IN';
    else if (fn === 10) line += `  READ_LINE buf=${h16(cpu.de)}`;
    else if (fn === 12) line += '  GET_VERSION';
    else if (fn === 15) line += `  OPEN fcb=${h16(cpu.de)}`;
    else if (fn === 16) line += `  CLOSE fcb=${h16(cpu.de)}`;
    else if (fn === 17) line += `  SEARCH_FIRST fcb=${h16(cpu.de)}`;
    else if (fn === 18) line += '  SEARCH_NEXT';
    else if (fn === 19) line += `  DELETE fcb=${h16(cpu.de)}`;
    else if (fn === 20) line += `  READ_SEQ fcb=${h16(cpu.de)}`;
    else if (fn === 21) line += `  WRITE_SEQ fcb=${h16(cpu.de)}`;
    else if (fn === 22) line += `  CREATE fcb=${h16(cpu.de)}`;
    else if (fn === 26) line += `  SET_DMA addr=${h16(cpu.de)}`;
    else if (fn === 33) line += `  READ_RND fcb=${h16(cpu.de)}`;
    else if (fn === 34) line += `  WRITE_RND fcb=${h16(cpu.de)}`;
    else if (fn === 35) line += `  FILE_SIZE fcb=${h16(cpu.de)}`;
    else if (fn === 36) line += `  SET_RND fcb=${h16(cpu.de)}`;
  }
  return line;
}

/** Execute a synthetic RET: pop PC from stack. */
function execRET(spec: Spectrum): void {
  const cpu = spec.cpu;
  const lo = spec.memory.readByte(cpu.sp & 0xFFFF);
  const hi = spec.memory.readByte((cpu.sp + 1) & 0xFFFF);
  cpu.sp = (cpu.sp + 2) & 0xFFFF;
  cpu.pc = (hi << 8) | lo;
}

/** Install the onTrap callback on the given spec. Called from initMachine. */
export function installTrapHook(spec: Spectrum): void {
  spec.onTrap = (pc: number): boolean => {
    const list = traps.get(pc);
    if (!list) return false;
    for (const trap of list) {
      if (trap.condC !== undefined && spec.cpu.c !== trap.condC) continue;

      if (trap.action === 'log') {
        trapLog.push(formatTrapLog(trap, spec));
        return false;
      }
      if (trap.action === 'break') {
        trapLog.push(formatTrapLog(trap, spec) + '  [BREAK]');
        return true;
      }
      if (trap.action === 'respond') {
        const resp = trap.responses.shift();
        if (!resp) {
          trapLog.push(formatTrapLog(trap, spec) + '  [RESPOND queue empty — BREAK]');
          return true;
        }
        trapLog.push(formatTrapLog(trap, spec) + `  [RESPOND ${JSON.stringify(resp.regs)}]`);
        const cpu = spec.cpu;
        for (const [reg, val] of Object.entries(resp.regs)) {
          switch (reg.toUpperCase()) {
            case 'A':  cpu.a  = val & 0xFF; break;
            case 'F':  cpu.f  = val & 0xFF; break;
            case 'B':  cpu.b  = val & 0xFF; break;
            case 'C':  cpu.c  = val & 0xFF; break;
            case 'D':  cpu.d  = val & 0xFF; break;
            case 'E':  cpu.e  = val & 0xFF; break;
            case 'H':  cpu.h  = val & 0xFF; break;
            case 'L':  cpu.l  = val & 0xFF; break;
            case 'BC': cpu.bc = val & 0xFFFF; break;
            case 'DE': cpu.de = val & 0xFFFF; break;
            case 'HL': cpu.hl = val & 0xFFFF; break;
          }
        }
        execRET(spec);
        return false;
      }
    }
    return false;
  };
}
