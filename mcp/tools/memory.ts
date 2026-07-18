import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { disassemble, stripMarkers } from '../../src/debug/z80-disasm.ts';
import { h8, h16 } from '../hex.ts';
import { state } from '../state.ts';
import { parseAddr, formatHexDump, doFindBytes, text } from '../format.ts';

export function register(server: McpServer): void {
  server.registerTool(
    'read_memory',
    { description: 'Hex dump of memory. Without bank: reads from the 64KB address space. With bank (0-7): reads from that 16KB RAM bank directly, address is offset within the bank.', inputSchema: {
      address: z.string().describe('Start address (hex, or offset within bank)'),
      length: z.number().int().positive().default(64).describe('Number of bytes to dump'),
      bank: z.number().int().min(0).max(7).optional().describe('RAM bank 0-7 (omit for flat 64KB address space)'),
    } },
    async ({ address, length, bank }) => {
      const spec = state.spec;
      if (bank !== undefined) {
        const view = spec.memory.getRamBank(bank);
        if (!view) return text(`Bank ${bank} not available`);
        const offset = parseAddr(address) & 0x3FFF;
        const len = Math.min(length, 0x4000 - offset);
        return text(`Bank ${bank}, offset ${h16(offset)}:\n${formatHexDump(a => view[a] ?? 0xFF, offset, len)}`);
      }
      return text(formatHexDump(addr => spec.memory.readByte(addr), parseAddr(address), length));
    },
  );

  server.registerTool(
    'write_memory',
    { description: 'Write a hex byte sequence to memory. Without bank: writes to the 64KB address space. With bank (0-7): writes to that 16KB RAM bank directly, address is offset within the bank.', inputSchema: {
      address: z.string().describe('Start address (hex, or offset within bank)'),
      hex_bytes: z.string().describe('Hex byte string to write, e.g. "CD0050FF"'),
      bank: z.number().int().min(0).max(7).optional().describe('RAM bank 0-7 (omit for flat 64KB address space)'),
    } },
    async ({ address, hex_bytes, bank }) => {
      const spec = state.spec;
      const hex = hex_bytes.replace(/\s/g, '');
      if (hex.length % 2 !== 0) return text('Hex string must have even length');
      const count = hex.length / 2;
      if (bank !== undefined) {
        const view = spec.memory.getRamBank(bank);
        if (!view) return text(`Bank ${bank} not available`);
        const offset = parseAddr(address) & 0x3FFF;
        for (let i = 0; i < count; i++) {
          const val = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
          if (isNaN(val)) return text(`Invalid hex at position ${i * 2}: "${hex.slice(i * 2, i * 2 + 2)}"`);
          view[(offset + i) & 0x3FFF] = val;
        }
        return text(`Wrote ${count} byte${count !== 1 ? 's' : ''} to bank ${bank} at ${h16(offset)}..${h16((offset + count - 1) & 0x3FFF)}`);
      }
      const addr = parseAddr(address) & 0xFFFF;
      for (let i = 0; i < count; i++) {
        const val = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        if (isNaN(val)) return text(`Invalid hex at position ${i * 2}: "${hex.slice(i * 2, i * 2 + 2)}"`);
        spec.memory.writeByte((addr + i) & 0xFFFF, val);
      }
      return text(`Wrote ${count} byte${count !== 1 ? 's' : ''} at ${h16(addr)}..${h16((addr + count - 1) & 0xFFFF)}`);
    },
  );

  server.registerTool(
    'find',
    { description: 'Search all 64KB of memory for a byte sequence. Returns up to 64 matches.', inputSchema: { hex_bytes: z.string().describe('Hex byte string to search for, e.g. "CD0050"') } },
    async ({ hex_bytes }) => {
      const spec = state.spec;
      const hex = hex_bytes.replace(/\s/g, '');
      if (hex.length % 2 !== 0) return text('Hex string must have even length');
      const needle = new Uint8Array(hex.length / 2);
      for (let i = 0; i < needle.length; i++) needle[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return text(doFindBytes(addr => spec.memory.readByte(addr), needle));
    },
  );

  server.registerTool(
    'disassemble',
    { description: 'Disassemble Z80 code at a given address (default: PC). Shows N lines (default 16).', inputSchema: {
      address: z.string().optional().describe('Start address (hex/decimal). Defaults to current PC.'),
      lines: z.number().int().positive().default(16).describe('Number of lines to disassemble'),
    } },
    async ({ address, lines: n }) => {
      const spec = state.spec;
      const addr = address ? parseAddr(address) : spec.services.debug.pc;
      const snap = spec.memory.snapshot();
      const result = disassemble(snap, addr, n);
      const out: string[] = [];
      for (const l of result) {
        const bytes: string[] = [];
        for (let i = 0; i < l.length; i++) bytes.push(h8(snap[(l.addr + i) & 0xFFFF]));
        const prefix = l.addr === spec.services.debug.pc ? '>' : ' ';
        out.push(`${prefix} ${h16(l.addr)}  ${bytes.join(' ').padEnd(11)}  ${stripMarkers(l.text)}`);
      }
      return text(out.join('\n'));
    },
  );
}
