import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { h8, h16 } from '../hex.ts';
import { state, initMachine } from '../state.ts';
import { formatStep, formatRegs, parseAddr, text } from '../format.ts';
import { traps, resetTrap, consumeResetHit } from '../traps.ts';

export function register(server: McpServer): void {
  server.registerTool(
    'run',
    { description: 'Run the emulator for N frames (default 1). Returns breakpoint info if hit.', inputSchema: { frames: z.number().int().positive().default(1).describe('Number of frames to run') } },
    async ({ frames }) => {
      const spec = state.spec;
      const ran = spec.runUntil(frames);
      if (spec.portWatchHit !== null) {
        const { port, value, dir } = spec.portWatchHit;
        return text(`Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
      }
      if (spec.memWatchHit !== null) {
        const { addr, value, dir } = spec.memWatchHit;
        return text(`Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
      }
      if (spec.breakpointHit >= 0) {
        const reset = consumeResetHit();
        if (reset) return text(`${reset.text}\nafter ${ran}/${frames} frame(s)\n${formatStep(spec)}`);
        return text(`Breakpoint hit at ${h16(spec.breakpointHit)} after ${ran}/${frames} frame(s). T=${spec.cpu.tStates}\n${formatStep(spec)}`);
      }
      return text(`Ran ${frames} frame(s). T=${spec.cpu.tStates}`);
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
        return text(`Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
      }
      if (spec.memWatchHit !== null) {
        const { addr, value, dir } = spec.memWatchHit;
        return text(`Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
      }
      if (spec.breakpointHit >= 0) {
        const reset = consumeResetHit();
        if (reset) return text(`${reset.text}\n${formatStep(spec)}`);
        return text(`Breakpoint at ${h16(spec.breakpointHit)}. T=${spec.cpu.tStates}\n${formatStep(spec)}`);
      }
      return text(`Frame complete. T=${spec.cpu.tStates}`);
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
        spec.cpu.step();
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
        return text(`Port watchpoint: ${dir === 'out' ? 'OUT' : 'IN '} (${h16(port)}) = ${h8(value)}  after ${ran} frame(s)  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
      }
      if (spec.memWatchHit !== null) {
        const { addr, value, dir } = spec.memWatchHit;
        return text(`Memory watchpoint: ${dir === 'write' ? 'WR' : 'RD'} (${h16(addr)}) = ${h8(value)}  after ${ran} frame(s)  PC=${h16(spec.cpu.pc)}\n${formatStep(spec)}`);
      }
      if (spec.breakpointHit >= 0) {
        const reset = consumeResetHit();
        if (reset) return text(`${reset.text}\nafter ${ran} frame(s)\n${formatStep(spec)}`);
        return text(`Breakpoint hit at ${h16(spec.breakpointHit)} after ${ran} frame(s). T=${spec.cpu.tStates}\n${formatStep(spec)}`);
      }
      return text(`No breakpoint hit after ${max_frames} frames (T=${spec.cpu.tStates})`);
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
      const cpu = state.spec.cpu;
      switch (reg) {
        case 'A':  cpu.a  = val & 0xFF; break;
        case 'F':  cpu.f  = val & 0xFF; break;
        case 'AF': cpu.af = val & 0xFFFF; break;
        case 'B':  cpu.b  = val & 0xFF; break;
        case 'C':  cpu.c  = val & 0xFF; break;
        case 'BC': cpu.bc = val & 0xFFFF; break;
        case 'D':  cpu.d  = val & 0xFF; break;
        case 'E':  cpu.e  = val & 0xFF; break;
        case 'DE': cpu.de = val & 0xFFFF; break;
        case 'H':  cpu.h  = val & 0xFF; break;
        case 'L':  cpu.l  = val & 0xFF; break;
        case 'HL': cpu.hl = val & 0xFFFF; break;
        case 'SP': cpu.sp = val & 0xFFFF; break;
        case 'PC': cpu.pc = val & 0xFFFF; break;
        case 'IX': cpu.ix = val & 0xFFFF; break;
        case 'IY': cpu.iy = val & 0xFFFF; break;
        default: return text(`Unknown register: ${reg}`);
      }
      return text(`${reg} = ${val <= 0xFF ? h8(val) : h16(val)}`);
    },
  );

  server.registerTool(
    'model',
    { description: 'Show or switch the Spectrum model. Creates a fresh machine when switching.', inputSchema: { target: z.enum(['16k', '48k', '128k', '+2', '+2A', '+3']).optional().describe('Model to switch to (omit to show current)') } },
    async ({ target }) => {
      if (!target) return text(`Current model: ${state.model}`);
      const msg = await initMachine(target);
      return text(`Switched to ${target.toUpperCase()}. ${msg}`);
    },
  );
}
