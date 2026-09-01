/**
 * Trap system: pre-configured PC hooks with three modes —
 *   log     — record the call (registers, decoded info) to the buffer, continue
 *   break   — halt execution (like a breakpoint) so the MCP client can inspect
 *   respond — stuff registers from a pre-loaded response queue and RET, skipping
 *             the real code. Responses are consumed in FIFO order; when the queue
 *             is empty the trap reverts to "break".
 */

import type { Machine } from '../src/machines/machine.ts';
import { hex16 as h16 } from '../src/utils/hex.ts';
import { spectrumPagingLine } from './format.ts';

export interface TrapResponse {
  /** Register values to set before RETurning. Only listed regs are changed. */
  regs: Record<string, number>;
}

export interface Trap {
  address: number;
  action: 'log' | 'break' | 'respond';
  /** Optional: only fire when a named register holds this value (BDOS function
   *  filtering uses C). The register is looked up through the CPU family's
   *  debug service, so a family without that register simply never matches. */
  cond?: { reg: string; value: number };
  /** Label shown in log output */
  label: string;
  /** Pre-queued responses for 'respond' mode */
  responses: TrapResponse[];
}

export const traps = new Map<number, Trap[]>();

/** Cap on retained trap-log lines — same bound as the FDC log ring buffer.
 *  A 'log'-mode trap fires once per instruction passing its PC, so an
 *  unbounded log grows without limit on long runs. */
const TRAP_LOG_MAX = 2000;
export const trapLog: string[] = [];

function pushTrapLog(line: string): void {
  trapLog.push(line);
  if (trapLog.length > TRAP_LOG_MAX) trapLog.shift();
}

/**
 * Reset trap: catches the whole class of "machine reboots" — loaders RET/JP/RST 0
 * to 0x0000 as their tape-read-error handler (and crashes run off into it too).
 * When armed, execution breaks the moment PC reaches 0x0000 via control flow, and
 * we snapshot the culprit instruction, the stack (the RET-chain it unwound), and
 * the paging state so the reboot can be diagnosed without hand-tracing.
 *
 *   lastPc — PC of the instruction executed immediately before this one. onTrap
 *            runs once per instruction with the about-to-execute PC, so when PC
 *            lands on 0x0000 the previous call's PC is the branch that did it.
 */
export interface ResetHit { text: string; culpritPc: number; }
export const resetTrap = { armed: false, lastPc: -1, hit: null as ResetHit | null };

/** Arm or disarm the reset trap, clearing any prior capture. */
export function setResetTrap(on: boolean): void {
  resetTrap.armed = on;
  resetTrap.lastPc = -1;
  resetTrap.hit = null;
}

/** Pull and clear the most recent reset capture (consumed by run/step tools). */
export function consumeResetHit(): ResetHit | null {
  const hit = resetTrap.hit;
  resetTrap.hit = null;
  return hit;
}

/** Snapshot the reboot: culprit instruction + return-address chain + paging. */
function captureReset(spec: Machine, culpritPc: number): ResetHit {
  const dbg = spec.services.debug;
  const culprit = dbg.disasm(culpritPc, 1)[0].text;
  // The unwound return-address chain — what RET'd through to 0x0000.
  const stack = dbg.returnStack(8).map(h16);

  const lines = [
    '*** RESET TRAP: PC reached 0x0000 (reboot) ***',
    `Culprit: ${h16(culpritPc)}  ${culprit}`,
    `SP=${h16(dbg.regs().sp)}  stack: ${stack.join(' ')}`,
    `T=${dbg.tStates}`,
  ];
  const paging = spectrumPagingLine();
  if (paging) lines.push(paging);
  return { text: lines.join('\n'), culpritPc };
}

/** Read a '$'-terminated CP/M string from memory starting at addr. */
function readCpmString(spec: Machine, addr: number, maxLen = 256): string {
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const ch = spec.memory.readByte((addr + i) & 0xFFFF);
    if (ch === 0x24) break; // '$'
    s += (ch >= 0x20 && ch < 0x7F) ? String.fromCharCode(ch) : '.';
  }
  return s;
}

/** Format a trap log entry with registers and optional CP/M decoding.
 *
 *  The register text is the CPU family's own summary; the BDOS decode below is
 *  a CP/M calling convention, so it engages only when the family actually has
 *  the C/DE/E registers CP/M passes arguments in (getReg returns null when it
 *  does not) — no CPU-family branch needed. */
export function formatTrapLog(trap: Trap, spec: Machine): string {
  const dbg = spec.services.debug;
  let line = `[${h16(dbg.pc)}] ${trap.label}  ${dbg.regsSummary()} T=${dbg.tStates}`;
  const fn = trap.address === 0x0005 ? dbg.getReg('C') : null;
  if (fn !== null) {
    const de = dbg.getReg('DE') ?? 0;
    const e = dbg.getReg('E') ?? 0;
    if (fn === 2) line += `  CON_OUT char='${String.fromCharCode(e)}'`;
    else if (fn === 9) line += `  PRINT_STR "${readCpmString(spec, de)}"`;
    else if (fn === 1) line += '  CON_IN';
    else if (fn === 10) line += `  READ_LINE buf=${h16(de)}`;
    else if (fn === 12) line += '  GET_VERSION';
    else if (fn === 15) line += `  OPEN fcb=${h16(de)}`;
    else if (fn === 16) line += `  CLOSE fcb=${h16(de)}`;
    else if (fn === 17) line += `  SEARCH_FIRST fcb=${h16(de)}`;
    else if (fn === 18) line += '  SEARCH_NEXT';
    else if (fn === 19) line += `  DELETE fcb=${h16(de)}`;
    else if (fn === 20) line += `  READ_SEQ fcb=${h16(de)}`;
    else if (fn === 21) line += `  WRITE_SEQ fcb=${h16(de)}`;
    else if (fn === 22) line += `  CREATE fcb=${h16(de)}`;
    else if (fn === 26) line += `  SET_DMA addr=${h16(de)}`;
    else if (fn === 33) line += `  READ_RND fcb=${h16(de)}`;
    else if (fn === 34) line += `  WRITE_RND fcb=${h16(de)}`;
    else if (fn === 35) line += `  FILE_SIZE fcb=${h16(de)}`;
    else if (fn === 36) line += `  SET_RND fcb=${h16(de)}`;
  }
  return line;
}

/** Install the onTrap callback on the given spec. Called from initMachine. */
export function installTrapHook(spec: Machine): void {
  spec.onTrap = (pc: number): boolean => {
    if (resetTrap.armed) {
      // Fire on the transition *into* 0x0000 (lastPc must be a real prior
      // instruction, so arming while already at boot PC=0 can't false-fire).
      if (pc === 0x0000 && resetTrap.lastPc > 0) {
        resetTrap.hit = captureReset(spec, resetTrap.lastPc);
        pushTrapLog(resetTrap.hit.text);
        resetTrap.lastPc = pc;
        return true;
      }
      resetTrap.lastPc = pc;
    }
    const list = traps.get(pc);
    if (!list) return false;
    const dbg = spec.services.debug;
    for (const trap of list) {
      if (trap.cond && dbg.getReg(trap.cond.reg) !== trap.cond.value) continue;

      if (trap.action === 'log') {
        pushTrapLog(formatTrapLog(trap, spec));
        return false;
      }
      if (trap.action === 'break') {
        pushTrapLog(formatTrapLog(trap, spec) + '  [BREAK]');
        return true;
      }
      if (trap.action === 'respond') {
        const resp = trap.responses.shift();
        if (!resp) {
          pushTrapLog(formatTrapLog(trap, spec) + '  [RESPOND queue empty — BREAK]');
          return true;
        }
        pushTrapLog(formatTrapLog(trap, spec) + `  [RESPOND ${JSON.stringify(resp.regs)}]`);
        for (const [reg, val] of Object.entries(resp.regs)) dbg.setReg(reg, val);
        dbg.returnFromCall();
        return false;
      }
    }
    return false;
  };
}
