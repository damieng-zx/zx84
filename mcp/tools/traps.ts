import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hex8 as h8, hex16 as h16 } from '../../src/utils/hex.ts';
import { parseAddr, text } from '../format.ts';
import { traps, trapLog, resetTrap, setResetTrap, type Trap } from '../traps.ts';

export function register(server: McpServer): void {
  server.registerTool(
    'reset_trap',
    { description: 'Arm/disarm the reset trap. When armed, execution breaks the instant the CPU reaches 0x0000 (a reboot) via control flow, capturing the culprit instruction, the stack (RET-chain it unwound through), and the paging state. Loader self-reboots — e.g. a tape-read-error handler that RET/JP/RST 0s to 0x0000 — and runaway crashes all land here, so this catches the whole class generically. Omit `enabled` to show status.', inputSchema: {
      enabled: z.boolean().optional().describe('true to arm, false to disarm (omit to show status)'),
    } },
    async ({ enabled }) => {
      if (enabled === undefined) {
        return text(resetTrap.armed ? 'Reset trap: ARMED (breaks on PC→0x0000)' : 'Reset trap: off');
      }
      setResetTrap(enabled);
      return text(enabled
        ? 'Reset trap armed — will break on reboot to 0x0000 with culprit + stack + paging'
        : 'Reset trap disarmed');
    },
  );

  server.registerTool(
    'trap',
    { description: 'Set a trap at an address. Actions: "log" (record and continue), "break" (halt execution), "respond" (stuff registers and RET). Omit address to list all traps.', inputSchema: {
      address: z.string().optional().describe('Address to trap (omit to list all)'),
      action: z.enum(['log', 'break', 'respond']).default('log').describe('What to do when the trap fires'),
      cond_c: z.number().int().min(0).max(255).optional().describe('Only fire when C register equals this value (e.g. BDOS function number)'),
      label: z.string().default('').describe('Label for log output (e.g. "BDOS", "BIOS_CONOUT")'),
      responses: z.array(z.record(z.string(), z.number())).optional().describe('For respond mode: array of {reg: value} objects consumed in FIFO order'),
    } },
    async ({ address, action, cond_c, label, responses }) => {
      if (!address) {
        if (traps.size === 0) return text('No traps set');
        const lines: string[] = [];
        for (const [addr, list] of traps) {
          for (const t of list) {
            let desc = `${h16(addr)}  ${t.action}`;
            if (t.cond) desc += `  ${t.cond.reg}==${h8(t.cond.value)}`;
            if (t.label) desc += `  "${t.label}"`;
            if (t.action === 'respond') desc += `  queue=${t.responses.length}`;
            lines.push(desc);
          }
        }
        return text(lines.join('\n'));
      }
      const addr = parseAddr(address) & 0xFFFF;
      const trap: Trap = {
        address: addr,
        action,
        cond: cond_c === undefined ? undefined : { reg: 'C', value: cond_c },
        label: label || `trap@${h16(addr)}`,
        responses: (responses ?? []).map(r => ({ regs: r })),
      };
      if (!traps.has(addr)) traps.set(addr, []);
      traps.get(addr)!.push(trap);
      let msg = `Trap set at ${h16(addr)}: ${action}`;
      if (cond_c !== undefined) msg += ` when C==${h8(cond_c)}`;
      if (trap.responses.length > 0) msg += `, ${trap.responses.length} response(s) queued`;
      return text(msg);
    },
  );

  server.registerTool(
    'trap_delete',
    { description: 'Delete traps. If address given, removes all traps at that address. If cond_c also given, only removes matching traps. Omit address to clear all.', inputSchema: {
      address: z.string().optional().describe('Address to remove traps from (omit to clear all)'),
      cond_c: z.number().int().min(0).max(255).optional().describe('Only remove traps with this C condition'),
    } },
    async ({ address, cond_c }) => {
      if (!address) {
        const count = [...traps.values()].reduce((s, l) => s + l.length, 0);
        traps.clear();
        return text(`Cleared all ${count} trap(s)`);
      }
      const addr = parseAddr(address) & 0xFFFF;
      const list = traps.get(addr);
      if (!list || list.length === 0) return text(`No traps at ${h16(addr)}`);
      if (cond_c !== undefined) {
        const before = list.length;
        const filtered = list.filter(t => !(t.cond?.reg === 'C' && t.cond.value === cond_c));
        traps.set(addr, filtered);
        if (filtered.length === 0) traps.delete(addr);
        return text(`Removed ${before - filtered.length} trap(s) at ${h16(addr)} with C==${h8(cond_c)}`);
      }
      traps.delete(addr);
      return text(`Removed ${list.length} trap(s) at ${h16(addr)}`);
    },
  );

  server.registerTool(
    'trap_log',
    { description: 'Read the trap log buffer. Returns total line count and requested range.', inputSchema: {
      from: z.number().int().min(0).default(0).describe('Start line (0-based, inclusive)'),
      to: z.number().int().min(0).optional().describe('End line (exclusive, default: from+100)'),
      clear: z.boolean().default(false).describe('Clear the log after reading'),
    } },
    async ({ from, to, clear }) => {
      if (trapLog.length === 0) return text('Trap log is empty');
      const end = Math.min(to ?? from + 100, trapLog.length);
      const start = Math.min(from, trapLog.length);
      const chunk = trapLog.slice(start, end);
      const result = `Trap log: ${trapLog.length} total lines. Showing ${start}..${end - 1}:\n\n${chunk.join('\n')}`;
      if (clear) trapLog.length = 0;
      return text(result);
    },
  );

  server.registerTool(
    'trap_respond',
    { description: 'Queue additional responses for an existing respond-mode trap.', inputSchema: {
      address: z.string().describe('Trap address'),
      cond_c: z.number().int().min(0).max(255).optional().describe('Match trap with this C condition'),
      responses: z.array(z.record(z.string(), z.number())).describe('Array of {reg: value} response objects to append to the queue'),
    } },
    async ({ address, cond_c, responses }) => {
      const addr = parseAddr(address) & 0xFFFF;
      const list = traps.get(addr);
      if (!list) return text(`No traps at ${h16(addr)}`);
      const match = list.find(t => t.action === 'respond'
        && (cond_c === undefined || (t.cond?.reg === 'C' && t.cond.value === cond_c)));
      if (!match) return text(`No respond-mode trap at ${h16(addr)}${cond_c !== undefined ? ` with C==${h8(cond_c)}` : ''}`);
      for (const r of responses) match.responses.push({ regs: r });
      return text(`Queued ${responses.length} response(s) at ${h16(addr)}. Total queue: ${match.responses.length}`);
    },
  );
}
