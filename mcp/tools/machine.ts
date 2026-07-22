import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hex8 as h8, hex16 as h16 } from '../../src/utils/hex.ts';
import { state, initMachine } from '../state.ts';
import { zx8x16kRam } from '../concrete.ts';
import { formatStep, formatRegs, parseAddr, text } from '../format.ts';
import { traps, resetTrap, consumeResetHit } from '../traps.ts';
import { MCP_MODELS } from '../models.ts';

export function register(server: McpServer): void {
  server.registerTool(
    'run',
    { description: 'Run the emulator for N frames (default 1). Returns breakpoint info if hit.', inputSchema: { frames: z.number().int().positive().default(1).describe('Number of frames to run') } },
    async ({ frames }) => {
      const spec = state.spec;
      const ran = spec.runUntil(frames);
      if (spec.portWatchHit !== null) {
        const { port, value, dir } = spec.portWatchHit;
        return text(`Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  PC=${h16(spec.services.debug.pc)}\n${formatStep(spec)}`);
      }
      if (spec.memWatchHit !== null) {
        const { addr, value, dir } = spec.memWatchHit;
        return text(`Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  PC=${h16(spec.services.debug.pc)}\n${formatStep(spec)}`);
      }
      if (spec.breakpointHit >= 0) {
        const reset = consumeResetHit();
        if (reset) return text(`${reset.text}\nafter ${ran}/${frames} frame(s)\n${formatStep(spec)}`);
        return text(`Breakpoint hit at ${h16(spec.breakpointHit)} after ${ran}/${frames} frame(s). T=${spec.services.debug.tStates}\n${formatStep(spec)}`);
      }
      return text(`Ran ${frames} frame(s). T=${spec.services.debug.tStates}`);
    },
  );

  server.registerTool(
    'step_frame',
    { description: 'Run exactly one frame (to the next frame boundary). Equivalent to run with frames=1.' },
    async () => {
      const spec = state.spec;
      spec.tick();
      if (spec.portWatchHit !== null) {
        const { port, value, dir } = spec.portWatchHit;
        return text(`Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  PC=${h16(spec.services.debug.pc)}\n${formatStep(spec)}`);
      }
      if (spec.memWatchHit !== null) {
        const { addr, value, dir } = spec.memWatchHit;
        return text(`Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  PC=${h16(spec.services.debug.pc)}\n${formatStep(spec)}`);
      }
      if (spec.breakpointHit >= 0) {
        const reset = consumeResetHit();
        if (reset) return text(`${reset.text}\n${formatStep(spec)}`);
        return text(`Breakpoint at ${h16(spec.breakpointHit)}. T=${spec.services.debug.tStates}\n${formatStep(spec)}`);
      }
      return text(`Frame complete. T=${spec.services.debug.tStates}`);
    },
  );

  server.registerTool(
    'step',
    { description: 'Single-step N Z80 instructions (default 1), showing disassembly and registers for each.', inputSchema: { count: z.number().int().positive().default(1).describe('Number of instructions to step') } },
    async ({ count }) => {
      const spec = state.spec;
      const lines: string[] = [];
      for (let i = 0; i < count; i++) {
        lines.push(formatStep(spec));
        spec.services.debug.stepOne();
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'continue',
    { description: 'Continue execution until a breakpoint is hit (max N frames, default 5000).', inputSchema: { max_frames: z.number().int().positive().default(5000).describe('Maximum frames before giving up') } },
    async ({ max_frames }) => {
      const spec = state.spec;
      if (spec.breakpoints.size === 0 && spec.portWatchpoints.size === 0 && spec.memWatchpoints.length === 0 && traps.size === 0 && !resetTrap.armed)
        return text('No breakpoints or traps set. Use "breakpoint", "port_watchpoint", "memory_watchpoint", "trap", or "reset_trap" first.');
      const ran = spec.runUntil(max_frames);
      if (spec.portWatchHit !== null) {
        const { port, value, dir } = spec.portWatchHit;
        return text(`Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  after ${ran} frame(s)  PC=${h16(spec.services.debug.pc)}\n${formatStep(spec)}`);
      }
      if (spec.memWatchHit !== null) {
        const { addr, value, dir } = spec.memWatchHit;
        return text(`Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  after ${ran} frame(s)  PC=${h16(spec.services.debug.pc)}\n${formatStep(spec)}`);
      }
      if (spec.breakpointHit >= 0) {
        const reset = consumeResetHit();
        if (reset) return text(`${reset.text}\nafter ${ran} frame(s)\n${formatStep(spec)}`);
        return text(`Breakpoint hit at ${h16(spec.breakpointHit)} after ${ran} frame(s). T=${spec.services.debug.tStates}\n${formatStep(spec)}`);
      }
      return text(`No breakpoint hit after ${max_frames} frames (T=${spec.services.debug.tStates})`);
    },
  );

  server.registerTool(
    'registers',
    { description: 'Display all CPU registers, flags, interrupt state, and banking info.' },
    async () => text(formatRegs(state.spec)),
  );

  server.registerTool(
    'set_register',
    { description: 'Set a CPU register. Supported: A F AF B C BC D E DE H L HL SP PC IX IY.', inputSchema: {
      register: z.string().describe('Register name (e.g. A, BC, HL, SP, PC, IX, IY)'),
      value: z.string().describe('Value (hex or decimal, e.g. "FF", "0x1234", "512")'),
    } },
    async ({ register, value }) => {
      const reg = register.toUpperCase();
      const val = parseAddr(value);
      if (!state.spec.services.debug.setReg(reg, val)) {
        return text(`Unknown register: ${reg}`);
      }
      return text(`${reg} = ${val <= 0xFF ? h8(val) : h16(val)}`);
    },
  );

  server.registerTool(
    'model',
    { description: 'Show or switch the machine model. Creates a fresh machine when switching. ZX80/ZX81 may select the 16KB RAM pack.', inputSchema: {
      target: z.enum(MCP_MODELS).optional().describe('Model to switch to (omit to show current)'),
      ram16k: z.boolean().optional().describe('ZX80/ZX81 only: enable or disable 16KB RAM'),
    } },
    async ({ target, ram16k }) => {
      if (!target && ram16k === undefined) {
        const ram = state.spec.kind === 'zx8x' ? ` (${zx8x16kRam() ? '16KB' : '1KB'} RAM)` : '';
        return text(`Current model: ${state.model}${ram}`);
      }
      const next = target ?? state.model;
      const msg = await initMachine(next, { zx8x16kRam: ram16k ?? (next === state.model ? zx8x16kRam() : false) });
      return text(`Switched to ${next.toUpperCase()}. ${msg}`);
    },
  );
}
