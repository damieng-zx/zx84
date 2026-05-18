import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { disasmOne, stripMarkers } from '../../src/debug/z80-disasm.ts';
import { h8, h16 } from '../hex.ts';
import { state } from '../state.ts';
import { text } from '../format.ts';

/** Stored ZXTL trace lines, kept in memory for chunked reading via trace_read. */
let zxtlBuffer: string[] = [];

export function register(server: McpServer): void {
  server.tool(
    'trace',
    'Start a trace. Modes: "full" (all instructions), "portio" (port I/O), "zxtl" (ZXTL V0001 standardised format with full register dumps, stored in-memory — use stop_trace then trace_read to retrieve chunks).',
    { mode: z.enum(['full', 'portio', 'zxtl']).default('full') },
    async ({ mode }) => {
      if (mode === 'zxtl') zxtlBuffer = [];
      state.spec.startTrace(mode);
      return text(`Trace started (${mode} mode)`);
    },
  );

  server.tool(
    'stop_trace',
    'Stop the current trace and return the results. Full/portio: large traces written to file. ZXTL: stored in-memory — returns line count, use trace_read to fetch chunks.',
    {},
    async () => {
      const spec = state.spec;
      if (!spec.tracing) return text('Not tracing');
      const mode = spec.traceMode;
      if (mode === 'zxtl') {
        // Snapshot the buffer before stopTrace clears internal state
        zxtlBuffer = [...spec.traceBuffer];
        spec.stopTrace();
        return text(`ZXTL trace stopped: ${zxtlBuffer.length} lines stored in memory.\nUse trace_read to retrieve chunks by line range.`);
      }
      const traceText = spec.stopTrace();
      const lines = traceText.split('\n');
      if (lines.length <= 200) return text(traceText);
      const outPath = path.join(import.meta.dirname!, `trace-${Date.now()}.txt`);
      fs.writeFileSync(outPath, traceText);
      return text(`Trace: ${lines.length} lines written to ${outPath}`);
    },
  );

  server.tool(
    'trace_read',
    'Read lines from the stored ZXTL trace buffer. Returns total line count plus the requested range.',
    {
      from: z.number().int().min(0).default(0).describe('Start line (0-based, inclusive)'),
      to: z.number().int().min(0).optional().describe('End line (exclusive, default: from+100)'),
    },
    async ({ from, to }) => {
      if (zxtlBuffer.length === 0) return text('No ZXTL trace in memory. Run a trace with mode "zxtl", then stop_trace.');
      const end = Math.min(to ?? from + 100, zxtlBuffer.length);
      const start = Math.min(from, zxtlBuffer.length);
      const chunk = zxtlBuffer.slice(start, end);
      return text(`ZXTL trace: ${zxtlBuffer.length} total lines. Showing ${start}..${end - 1}:\n\n${chunk.join('\n')}`);
    },
  );

  server.tool(
    'frame_trace',
    'Run one frame, logging per-instruction: T-state, beam line/col, contention delays, border changes, and VRAM writes. Writes to file.',
    {},
    async () => {
      const spec = state.spec;
      const timing = spec.contention.timing;
      const tpl = timing.tStatesPerLine;
      const contentionStart = timing.contentionStart;

      const lines: string[] = [];
      let instrCount = 0;
      const maxInstrs = 200_000;

      // Save original hooks
      const origRead8 = spec.cpu.read8.bind(spec.cpu);
      const origWrite8 = spec.cpu.write8.bind(spec.cpu);
      const origContend = spec.cpu.contend.bind(spec.cpu);
      const origPortIn = spec.cpu.portIn.bind(spec.cpu);
      const origPortOut = spec.cpu.portOut.bind(spec.cpu);

      // Per-instruction accumulator
      let instrContentionTotal = 0;
      let instrVramWrites: string[] = [];
      let instrPortOps: string[] = [];

      // Wrap contend to track delays
      const realContend = spec.cpu.contend;
      spec.cpu.contend = (addr: number) => {
        const before = spec.cpu.tStates;
        realContend(addr);
        const delay = spec.cpu.tStates - before;
        if (delay > 0) instrContentionTotal += delay;
      };

      // Wrap read8 to track contention on reads
      const realRead8 = spec.cpu.read8;
      spec.cpu.read8 = (addr: number) => {
        const before = spec.cpu.tStates;
        const val = realRead8(addr);
        const delay = spec.cpu.tStates - before;
        if (delay > 0) instrContentionTotal += delay;
        return val;
      };

      // Wrap write8 to track contention + VRAM writes
      const realWrite8 = spec.cpu.write8;
      spec.cpu.write8 = (addr: number, val: number) => {
        const before = spec.cpu.tStates;
        realWrite8(addr, val);
        const delay = spec.cpu.tStates - before;
        if (delay > 0) instrContentionTotal += delay;
        if (addr >= 0x4000 && addr < 0x5B00) {
          instrVramWrites.push(`${h16(addr)}=${h8(val)}`);
        }
      };

      // Wrap portIn/portOut
      const realPortIn = spec.cpu.portIn;
      spec.cpu.portIn = (port: number) => {
        const before = spec.cpu.tStates;
        const val = realPortIn(port);
        const delay = spec.cpu.tStates - before;
        if (delay > 0) instrContentionTotal += delay;
        instrPortOps.push(`IN(${h16(port)})=${h8(val)}`);
        return val;
      };

      const realPortOut = spec.cpu.portOut;
      spec.cpu.portOut = (port: number, val: number) => {
        const before = spec.cpu.tStates;
        realPortOut(port, val);
        const delay = spec.cpu.tStates - before;
        if (delay > 0) instrContentionTotal += delay;
        instrPortOps.push(`OUT(${h16(port)},${h8(val)})`);
      };

      // Hook into step to capture per-instruction data
      const origPostStep = spec.cpu.postStepHook;
      spec.cpu.postStepHook = null; // we'll call it ourselves

      // Header
      lines.push('fT      line col  PC   instr                    Ts  cont  notes');
      lines.push('------  ---- ---  ----  ----------------------  --  ----  -----');

      // Run one frame
      // Sync frame boundary to current CPU time
      const tpf = timing.tStatesPerFrame;
      spec.contention.frameStartTStates = spec.cpu.tStates;
      const fStart = spec.contention.frameStartTStates;
      const frameEnd = fStart + tpf;

      spec.cpu.interrupt();

      while (spec.cpu.tStates < frameEnd && instrCount < maxInstrs) {
        const pc = spec.cpu.pc;
        const tBefore = spec.cpu.tStates;
        const fT = tBefore - fStart;
        const offset = fT - contentionStart;
        let beamLine = -1, beamCol = -1;
        if (offset >= 0) {
          beamLine = (offset / tpl) | 0;
          beamCol = offset - beamLine * tpl;
        }

        // Disassemble current instruction
        const buf = new Uint8Array(8);
        for (let i = 0; i < 8; i++) buf[i] = spec.memory.readByte((pc + i) & 0xFFFF);
        const { text: mnem } = disasmOne(buf, 0);

        // Reset accumulators
        instrContentionTotal = 0;
        instrVramWrites = [];
        instrPortOps = [];

        // Execute
        if (spec.cpu.halted) {
          spec.cpu.read8(spec.cpu.pc);
          spec.cpu.tStates += 3;
          spec.cpu.contend(spec.cpu.ir);
          spec.cpu.tStates += 1;
          spec.cpu.r = (spec.cpu.r & 0x80) | ((spec.cpu.r + 1) & 0x7F);
        } else {
          spec.cpu.step();
        }

        const elapsed = spec.cpu.tStates - tBefore;

        // Format line
        const notes: string[] = [];
        if (instrVramWrites.length > 0) notes.push('VRAM:' + instrVramWrites.join(','));
        if (instrPortOps.length > 0) notes.push(instrPortOps.join(' '));

        const fTStr = String(fT).padStart(6);
        const lineStr = beamLine >= 0 ? String(beamLine).padStart(4) : '   -';
        const colStr = beamCol >= 0 ? String(beamCol).padStart(3) : '  -';
        const pcStr = h16(pc);
        const mnStr = stripMarkers(mnem).padEnd(24);
        const tsStr = String(elapsed).padStart(2);
        const contStr = instrContentionTotal > 0 ? String(instrContentionTotal).padStart(4) : '   -';
        const noteStr = notes.length > 0 ? notes.join(' ') : '';

        lines.push(`${fTStr}  ${lineStr} ${colStr}  ${pcStr}  ${mnStr}${tsStr}  ${contStr}  ${noteStr}`);
        instrCount++;
      }

      // Restore hooks
      spec.cpu.read8 = origRead8;
      spec.cpu.write8 = origWrite8;
      spec.cpu.contend = origContend;
      spec.cpu.portIn = origPortIn;
      spec.cpu.portOut = origPortOut;
      spec.cpu.postStepHook = origPostStep;

      lines.push(`\n--- ${instrCount} instructions, frame ${fStart}-${frameEnd} ---`);

      const outPath = path.join(import.meta.dirname!, `frame-trace-${Date.now()}.txt`);
      fs.writeFileSync(outPath, lines.join('\n'));
      return text(`Frame trace: ${instrCount} instructions written to ${outPath}`);
    },
  );
}
