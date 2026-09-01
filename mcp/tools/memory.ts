import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hex16 as h16 } from '../../src/utils/hex.ts';
import { state } from '../state.ts';
import { parseAddr, formatHexDump, doFindBytes, text } from '../format.ts';

export function register(server: McpServer): void {
  server.registerTool(
    'read_memory',
    { description: 'Hex dump of memory. Without bank: reads from the 64KB address space. With bank (0-7): reads from that 16KB RAM bank directly, address is offset within the bank.', inputSchema: {
      address: z.string().describe('Start address (hex, or offset within bank)'),
      length: z.number().int().positive().max(0x10000).default(64).describe('Number of bytes to dump'),
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
    { description: 'Disassemble code at a given address (default: PC), in the CPU dialect of the active machine. Shows N lines (default 16).', inputSchema: {
      address: z.string().optional().describe('Start address (hex/decimal). Defaults to current PC.'),
      lines: z.number().int().positive().default(16).describe('Number of lines to disassemble'),
    } },
    async ({ address, lines: n }) => {
      const dbg = state.spec.services.debug;
      const pc = dbg.pc;
      const rows = dbg.disasm(address ? parseAddr(address) : pc, n);
      // Stop at the end of the routine: past an unconditional RET/JP the bytes
      // are usually data, and disassembling them is noise.
      const end = rows.findIndex(l => l.isTerminal);
      const out = rows.slice(0, end < 0 ? rows.length : end + 1).map(l =>
        `${l.addr === pc ? '>' : ' '} ${h16(l.addr)}  ${l.bytes.padEnd(11)}  ${l.text}`);
      return text(out.join('\n'));
    },
  );
}
