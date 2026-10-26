import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hex8 as h8, hex16 as h16 } from '../../src/utils/hex.ts';
import { state, initMachine } from '../state.ts';
import {
  zx8x16kRam, zx81MemotechHrg, zx81QuickSilvaHrg, zx81Udg128Ram, zx81UdgRam, zx81WrxHires,
} from '../concrete.ts';
import { formatStep, formatRegs, parseAddr, text, checkWatchHit } from '../format.ts';
import { traps, resetTrap, consumeResetHit } from '../traps.ts';
import { MCP_MODELS } from '../models.ts';
import { cyclesText, lineCycle } from '../beam.ts';

export function register(server: McpServer): void {
  server.registerTool(
    'run',
    { description: 'Run the emulator for N frames (default 1, max 5000). Returns breakpoint info if hit. With until_line, instead run to a raster position and stop there between two instructions, mid-frame: until_line (and optionally until_cycle) is the next time the beam reaches it (this frame if it is still ahead, otherwise the next), or in frame until_frame. The machine is left paused and resumable — step_frame, run and continue finish the frame as normal — so memory can be read exactly as the program will see it at that point. frames is then the give-up limit. Lines count from the frame start; beam_log_read\'s header says where the display starts. Supported on the Atari and the Spectrum family.', inputSchema: {
      frames: z.number().int().positive().max(5000).default(1).describe('Number of frames to run (with until_line: the most to run before giving up)'),
      until_line: z.number().int().min(0).optional().describe('Stop at this raster line'),
      until_cycle: z.number().int().min(0).optional().describe('...and this cycle within the line (default 0)'),
      until_frame: z.number().int().min(0).optional().describe('...in this absolute frame number (default: the next time the beam reaches it)'),
    } },
    async ({ frames, until_line, until_cycle, until_frame }) => {
      const spec = state.spec;
      if (until_line === undefined && (until_cycle !== undefined || until_frame !== undefined)) {
        return text('until_cycle and until_frame need until_line.');
      }
      if (until_line !== undefined) {
        const info = spec.beamInfo();
        if (info === null || !spec.supportsBeamStops()) {
          return text(`Running to a raster position is not supported on this machine (${state.model.toUpperCase()}).`);
        }
        if (until_line >= info.linesPerFrame) return text(`until_line must be below ${info.linesPerFrame}, this machine's lines per frame.`);
        const cycle = until_cycle ?? 0;
        if (cycle >= info.cyclesPerLine) return text(`until_cycle must be below ${cyclesText(info.cyclesPerLine)}, this machine's cycles per line.`);
        const t = until_line * info.cyclesPerLine + cycle;
        const here = spec.beam()!;
        if (until_frame !== undefined && (until_frame < here.frame || (until_frame === here.frame && t <= here.t))) {
          return text(`Frame ${until_frame}, line ${until_line}, cycle ${until_cycle ?? 0} has already gone by: the beam is at frame ${here.frame}, t=${here.t}.`);
        }
        const frame = until_frame ?? (here.t < t ? here.frame : here.frame + 1);
        spec.beamTarget = { frame, t };
        const limit = Math.min(5000, Math.max(frames, frame - here.frame + 2));
        const ran = spec.runUntil(limit);
        spec.beamTarget = null;
        const reset = consumeResetHit();
        if (reset) return text(`${reset.text}\nafter ${ran} call(s)\n${formatStep(spec)}`);
        if (spec.stopReason?.kind === 'beam') {
          const at = spec.beam()!;
          const { line, cycle: atCycle } = lineCycle(at.t, info, false);
          return text(`Stopped at frame ${at.frame}, line ${line}, cycle ${atCycle} (t=${at.t}); target was frame ${frame}, line ${until_line}, cycle ${cycle}. Paused mid-frame.\n${formatStep(spec)}`);
        }
        const hit = checkWatchHit(spec);
        if (hit) return text(`${hit}\nbefore reaching frame ${frame}, line ${until_line}, cycle ${cycle}`);
        return text(`Did not reach frame ${frame}, line ${until_line}, cycle ${cycle} within ${limit} frame(s). T=${spec.services.debug.tStates}`);
      }
      const ran = spec.runUntil(frames);
      const reset = consumeResetHit();
      if (reset) return text(`${reset.text}\nafter ${ran}/${frames} frame(s)\n${formatStep(spec)}`);
      const hit = checkWatchHit(spec);
      if (hit) return text(`${hit}\nafter ${ran}/${frames} frame(s)`);
      return text(`Ran ${frames} frame(s). T=${spec.services.debug.tStates}`);
    },
  );

  server.registerTool(
    'step_frame',
    { description: 'Run exactly one frame (to the next frame boundary). Equivalent to run with frames=1.' },
    async () => {
      const spec = state.spec;
      spec.tick();
      const reset = consumeResetHit();
      if (reset) return text(`${reset.text}\n${formatStep(spec)}`);
      const hit = checkWatchHit(spec);
      if (hit) return text(hit);
      return text(`Frame complete. T=${spec.services.debug.tStates}`);
    },
  );

  server.registerTool(
    'step',
    { description: 'Single-step N CPU instructions (default 1), showing disassembly and registers for each.', inputSchema: { count: z.number().int().positive().default(1).describe('Number of instructions to step') } },
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
      const reset = consumeResetHit();
      if (reset) return text(`${reset.text}\nafter ${ran} frame(s)\n${formatStep(spec)}`);
      const hit = checkWatchHit(spec);
      if (hit) return text(`${hit}\nafter ${ran} frame(s)`);
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
    { description: 'Set a CPU register, named as its family names it (Z80: A F AF B C BC D E DE H L HL SP PC IX IY).', inputSchema: {
      register: z.string().describe('Register name (Z80: A, BC, HL, SP, PC, IX, IY)'),
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
    { description: 'Show or switch the machine model. Creates a fresh machine when switching. ZX80/ZX81 may select 16KB RAM; ZX81 may select one high-resolution graphics device.', inputSchema: {
      target: z.enum(MCP_MODELS).optional().describe('Model to switch to (omit to show current)'),
      ram16k: z.boolean().optional().describe('ZX80/ZX81 only: enable or disable 16KB RAM'),
      udgRam: z.boolean().optional().describe('ZX81 only: map UDG character RAM at $3000-$3FFF'),
      udg128Ram: z.boolean().optional().describe('ZX81 only: map the 128-character UDG board at $3000-$3FFF'),
      wrxHires: z.boolean().optional().describe('ZX81 only: enable WRX refresh-readable bitmap RAM (disables UDG RAM)'),
      memotechHrg: z.boolean().optional().describe('ZX81 only: enable the Memotech 248x192 HRG board'),
      quickSilvaHrg: z.boolean().optional().describe('ZX81 only: enable the QuickSilva 256x192 HRG board'),
    } },
    async ({ target, ram16k, udgRam, udg128Ram, wrxHires, memotechHrg, quickSilvaHrg }) => {
      if (!target && ram16k === undefined && udgRam === undefined && udg128Ram === undefined
          && wrxHires === undefined && memotechHrg === undefined && quickSilvaHrg === undefined) {
        const ram = state.spec.kind === 'zx8x' ? ` (${zx8x16kRam() ? '16KB' : '1KB'} RAM)` : '';
        const hires = state.model === 'zx81'
          ? ` (hi-res: ${zx81QuickSilvaHrg() ? 'QuickSilva' : zx81MemotechHrg() ? 'Memotech'
            : zx81WrxHires() ? 'WRX' : zx81Udg128Ram() ? 'UDG-128' : zx81UdgRam() ? 'UDG' : 'off'})`
          : '';
        return text(`Current model: ${state.model}${ram}${hires}`);
      }
      const next = target ?? state.model;
      const sameModel = next === state.model;
      const explicit = quickSilvaHrg === true ? 'quicksilva'
        : memotechHrg === true ? 'memotech'
        : wrxHires === true ? 'wrx'
        : udg128Ram === true ? 'udg128'
        : udgRam === true ? 'udg'
        : null;
      const hardwareTouched = udgRam !== undefined || udg128Ram !== undefined || wrxHires !== undefined
        || memotechHrg !== undefined || quickSilvaHrg !== undefined;
      const keep = sameModel && next === 'zx81' && !hardwareTouched ? {
        zx81UdgRam: zx81UdgRam(),
        zx81Udg128Ram: zx81Udg128Ram(),
        zx81WrxHires: zx81WrxHires(),
        zx81MemotechHrg: zx81MemotechHrg(),
        zx81QuickSilvaHrg: zx81QuickSilvaHrg(),
      } : {};
      const msg = await initMachine(next, {
        zx8x16kRam: ram16k ?? (sameModel ? zx8x16kRam() : false),
        ...keep,
        ...(explicit ? {
          zx81UdgRam: explicit === 'udg', zx81Udg128Ram: explicit === 'udg128',
          zx81WrxHires: explicit === 'wrx', zx81MemotechHrg: explicit === 'memotech',
          zx81QuickSilvaHrg: explicit === 'quicksilva',
        } : {}),
      });
      return text(`Switched to ${next.toUpperCase()}. ${msg}`);
    },
  );
}
