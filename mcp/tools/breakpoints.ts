import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hex16 as h16 } from '../../src/utils/hex.ts';
import { state } from '../state.ts';
import { parseAddr, text } from '../format.ts';
import { NO_BEAM, armBeamLog } from '../beam.ts';
import type { Machine } from '../../src/machines/machine.ts';

type MemWatchEntry = Machine['memWatchpoints'][number];

export function register(server: McpServer): void {
  server.registerTool(
    'breakpoint',
    { description: 'Set breakpoints at one or more addresses, or list all breakpoints if none given. Accepts a single address or comma/space-separated list.', inputSchema: { address: z.string().optional().describe('Address(es) to set breakpoints at, e.g. "FE10" or "FE10,FE20,FE30" (omit to list all)') } },
    async ({ address }) => {
      const spec = state.spec;
      if (!address) {
        if (spec.breakpoints.size === 0) return text('No breakpoints');
        return text('Breakpoints: ' + [...spec.breakpoints].map(h16).join(', '));
      }
      const addrs = address.split(/[\s,]+/).filter(Boolean).map(s => parseAddr(s));
      for (const a of addrs) spec.breakpoints.add(a);
      return text(`Breakpoint${addrs.length > 1 ? 's' : ''} set at ${addrs.map(h16).join(', ')}`);
    },
  );

  server.registerTool(
    'delete_breakpoint',
    { description: 'Delete breakpoints at one or more addresses, or clear all if none given. Accepts a single address or comma/space-separated list.', inputSchema: { address: z.string().optional().describe('Address(es) to remove, e.g. "FE10" or "FE10,FE20" (omit to clear all)') } },
    async ({ address }) => {
      const spec = state.spec;
      if (!address) {
        spec.breakpoints.clear();
        return text('All breakpoints cleared');
      }
      const addrs = address.split(/[\s,]+/).filter(Boolean).map(s => parseAddr(s));
      for (const a of addrs) spec.breakpoints.delete(a);
      return text(`Breakpoint${addrs.length > 1 ? 's' : ''} at ${addrs.map(h16).join(', ')} removed`);
    },
  );

  server.registerTool(
    'port_watchpoint',
    { description: 'Set port watchpoints. Action "break" (default) stops on the first IN or OUT; action "log" records every access in the beam log (frame/line/cycle, the pc, the port and value — read with beam_log_read) and carries on. Ports match exactly (a Spectrum OUT (FE),A uses port A<<8|FE, so use OUT (C),r with BC=00FE to hit "00FE"). Accepts a single port or comma/space-separated list. Omit to list all.', inputSchema: {
      port: z.string().optional().describe('Port address(es) to watch, e.g. "3FFD" or "3FFD,2FFD" (omit to list all)'),
      action: z.enum(['break', 'log']).default('break').describe('break: stop on the first access; log: record every access in the beam log and continue'),
      frames: z.string().optional().describe('Log mode: capture the beam log only in these frames, e.g. "1500-1510" (applies to the whole beam log)'),
      lines: z.string().optional().describe('Log mode: capture the beam log only on these lines, e.g. "8-40" (applies to the whole beam log)'),
    } },
    async ({ port, action, frames, lines }) => {
      const spec = state.spec;
      if (!port) {
        if (spec.portWatchpoints.size === 0) return text('No port watchpoints');
        return text('Port watchpoints: ' + [...spec.portWatchpoints].map(p => spec.portLogPorts.has(p) ? `${h16(p)} (log)` : h16(p)).join(', '));
      }
      const ports = port.split(/[\s,]+/).filter(Boolean).map(s => parseAddr(s) & 0xFFFF);
      if (action === 'log' && armBeamLog(spec, frames, lines) === null) return text(NO_BEAM);
      for (const p of ports) {
        spec.portWatchpoints.add(p);
        // A port is either log or break, whichever was set last.
        if (action === 'log') spec.portLogPorts.add(p); else spec.portLogPorts.delete(p);
      }
      return text(`Port watchpoint${ports.length > 1 ? 's' : ''} set at ${ports.map(h16).join(', ')}${action === 'log' ? ' (log)' : ''}`);
    },
  );

  server.registerTool(
    'delete_port_watchpoint',
    { description: 'Delete port watchpoints. Accepts a single port or comma/space-separated list. Omit to clear all.', inputSchema: { port: z.string().optional().describe('Port address(es) to remove, e.g. "3FFD" or "3FFD,2FFD" (omit to clear all)') } },
    async ({ port }) => {
      const spec = state.spec;
      if (!port) {
        spec.portWatchpoints.clear();
        spec.portLogPorts.clear();
        return text('All port watchpoints cleared');
      }
      const ports = port.split(/[\s,]+/).filter(Boolean).map(s => parseAddr(s) & 0xFFFF);
      for (const p of ports) { spec.portWatchpoints.delete(p); spec.portLogPorts.delete(p); }
      return text(`Port watchpoint${ports.length > 1 ? 's' : ''} at ${ports.map(h16).join(', ')} removed`);
    },
  );

  server.registerTool(
    'memory_watchpoint',
    { description: 'Set a memory watchpoint on read, write, or either. Action "break" (default) stops at the first access; action "log" records every access in the beam log (frame/line/cycle, the pc of the accessing instruction, address and value — read with beam_log_read) and carries on. A range can cover a whole chip, e.g. address D000 length 32 for the Atari GTIA. Omit address to list all.', inputSchema: {
      address: z.string().optional().describe('Start address (hex, e.g. "4000"). Omit to list all watchpoints.'),
      length:  z.number().int().positive().default(1).describe('Number of bytes to watch (default 1)'),
      mode:    z.enum(['read', 'write', 'rw']).default('rw').describe('Access type to watch: read, write, or rw (default rw)'),
      action:  z.enum(['break', 'log']).default('break').describe('break: stop at the first access; log: record every access in the beam log and continue'),
      values:  z.string().optional().describe('Log mode: only record accesses of these byte values, hex comma/space-separated, e.g. "03,0C"'),
      frames:  z.string().optional().describe('Log mode: capture the beam log only in these frames, e.g. "1500-1510" (applies to the whole beam log)'),
      lines:   z.string().optional().describe('Log mode: capture the beam log only on these lines, e.g. "8-40" (applies to the whole beam log)'),
    } },
    async ({ address, length, mode, action, values, frames, lines }) => {
      const spec = state.spec;
      if (!address) {
        if (spec.memWatchpoints.length === 0) return text('No memory watchpoints');
        const rows = spec.memWatchpoints.map(wp => {
          const range = wp.start === wp.end ? h16(wp.start) : `${h16(wp.start)}-${h16(wp.end)}`;
          return `${range} ${wp.mode}${wp.action === 'log' ? ' (log)' : ''}${wp.values ? ` values=${wp.values.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join(',')}` : ''}`;
        });
        return text('Memory watchpoints:\n' + rows.join('\n'));
      }
      const start = parseAddr(address) & 0xFFFF;
      const end = (start + length - 1) & 0xFFFF;
      if (action === 'log' && armBeamLog(spec, frames, lines) === null) return text(NO_BEAM);
      const wp: MemWatchEntry = { start, end, mode };
      if (action === 'log') {
        wp.action = 'log';
        if (values) wp.values = values.split(/[\s,]+/).filter(Boolean).map(v => parseInt(v, 16) & 0xFF);
      }
      spec.memWatchpoints.push(wp);
      const range = start === end ? h16(start) : `${h16(start)}-${h16(end)}`;
      return text(`Memory watchpoint set: ${range} (${mode}${action === 'log' ? ', log' : ''})`);
    },
  );

  server.registerTool(
    'delete_memory_watchpoint',
    { description: 'Delete a memory watchpoint by start address, or omit to clear all.', inputSchema: { address: z.string().optional().describe('Start address of watchpoint to remove (omit to clear all)') } },
    async ({ address }) => {
      const spec = state.spec;
      if (!address) {
        spec.memWatchpoints.length = 0;
        return text('All memory watchpoints cleared');
      }
      const start = parseAddr(address) & 0xFFFF;
      const before = spec.memWatchpoints.length;
      spec.memWatchpoints = spec.memWatchpoints.filter(wp => wp.start !== start);
      const removed = before - spec.memWatchpoints.length;
      return removed > 0
        ? text(`Memory watchpoint at ${h16(start)} removed`)
        : text(`No memory watchpoint found at ${h16(start)}`);
    },
  );
}
