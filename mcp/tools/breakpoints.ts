import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { h16 } from '../hex.ts';
import { state } from '../state.ts';
import { parseAddr, text } from '../format.ts';

export function register(server: McpServer): void {
  server.tool(
    'breakpoint',
    'Set breakpoints at one or more addresses, or list all breakpoints if none given. Accepts a single address or comma/space-separated list.',
    { address: z.string().optional().describe('Address(es) to set breakpoints at, e.g. "FE10" or "FE10,FE20,FE30" (omit to list all)') },
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

  server.tool(
    'delete_breakpoint',
    'Delete breakpoints at one or more addresses, or clear all if none given. Accepts a single address or comma/space-separated list.',
    { address: z.string().optional().describe('Address(es) to remove, e.g. "FE10" or "FE10,FE20" (omit to clear all)') },
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

  server.tool(
    'port_watchpoint',
    'Set port watchpoints (breaks on IN or OUT). Accepts a single port or comma/space-separated list. Omit to list all.',
    { port: z.string().optional().describe('Port address(es) to watch, e.g. "3FFD" or "3FFD,2FFD" (omit to list all)') },
    async ({ port }) => {
      const spec = state.spec;
      if (!port) {
        if (spec.portWatchpoints.size === 0) return text('No port watchpoints');
        return text('Port watchpoints: ' + [...spec.portWatchpoints].map(h16).join(', '));
      }
      const ports = port.split(/[\s,]+/).filter(Boolean).map(s => parseAddr(s) & 0xFFFF);
      for (const p of ports) spec.portWatchpoints.add(p);
      return text(`Port watchpoint${ports.length > 1 ? 's' : ''} set at ${ports.map(h16).join(', ')}`);
    },
  );

  server.tool(
    'delete_port_watchpoint',
    'Delete port watchpoints. Accepts a single port or comma/space-separated list. Omit to clear all.',
    { port: z.string().optional().describe('Port address(es) to remove, e.g. "3FFD" or "3FFD,2FFD" (omit to clear all)') },
    async ({ port }) => {
      const spec = state.spec;
      if (!port) {
        spec.portWatchpoints.clear();
        return text('All port watchpoints cleared');
      }
      const ports = port.split(/[\s,]+/).filter(Boolean).map(s => parseAddr(s) & 0xFFFF);
      for (const p of ports) spec.portWatchpoints.delete(p);
      return text(`Port watchpoint${ports.length > 1 ? 's' : ''} at ${ports.map(h16).join(', ')} removed`);
    },
  );

  server.tool(
    'memory_watchpoint',
    'Set a memory watchpoint that breaks on read, write, or either. Omit address to list all.',
    {
      address: z.string().optional().describe('Start address (hex, e.g. "4000"). Omit to list all watchpoints.'),
      length:  z.number().int().positive().default(1).describe('Number of bytes to watch (default 1)'),
      mode:    z.enum(['read', 'write', 'rw']).default('rw').describe('Access type to watch: read, write, or rw (default rw)'),
    },
    async ({ address, length, mode }) => {
      const spec = state.spec;
      if (!address) {
        if (spec.memWatchpoints.length === 0) return text('No memory watchpoints');
        const lines = spec.memWatchpoints.map(wp =>
          wp.start === wp.end ? `${h16(wp.start)} ${wp.mode}` : `${h16(wp.start)}-${h16(wp.end)} ${wp.mode}`
        );
        return text('Memory watchpoints:\n' + lines.join('\n'));
      }
      const start = parseAddr(address) & 0xFFFF;
      const end = (start + length - 1) & 0xFFFF;
      spec.memWatchpoints.push({ start, end, mode });
      const range = start === end ? h16(start) : `${h16(start)}-${h16(end)}`;
      return text(`Memory watchpoint set: ${range} (${mode})`);
    },
  );

  server.tool(
    'delete_memory_watchpoint',
    'Delete a memory watchpoint by start address, or omit to clear all.',
    { address: z.string().optional().describe('Start address of watchpoint to remove (omit to clear all)') },
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
