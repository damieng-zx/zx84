import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
// The generic trace tools go through `services.debug`; `frame_trace` below is
// deliberately Spectrum-specific (it wraps the CPU's own read8/write8/contend
// hooks to attribute contention T-states per instruction), so it reaches the
// Z80 disassembler directly behind the `activeSpectrum()` narrowing.
import { disasmOne, stripMarkers } from '../../src/debug/z80/disasm.ts';
import { hex8 as h8, hex16 as h16 } from '../../src/utils/hex.ts';
import { state } from '../state.ts';
import { activeSpectrum } from '../concrete.ts';
import { text } from '../format.ts';
import { clearZxtlBuffer, setZxtlBuffer, zxtlBufferSize, readZxtlChunk } from '../zxtl-store.ts';
import { CACHE_DIR } from '../rom-fetch.ts';

/** Timestamped trace dumps go to the gitignored MCP cache dir, never into
 *  the source tree. */
function writeTraceFile(prefix: string, contents: string): string {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const outPath = path.join(CACHE_DIR, `${prefix}-${Date.now()}.txt`);
  fs.writeFileSync(outPath, contents);
  return outPath;
}

export function register(server: McpServer): void {
  server.registerTool(
    'trace',
    { description: 'Start a trace. Modes: "full" (all instructions), "portio" (port I/O), "zxtl" (ZXTL V0001 standardised format with full register dumps, stored in-memory — use stop_trace then trace_read to retrieve chunks).', inputSchema: { mode: z.enum(['full', 'portio', 'zxtl']).default('full') } },
    async ({ mode }) => {
      // Only the Spectrum implements startTrace today; the other machines'
      // is a no-op stub, so starting there would silently trace nothing.
      if (!activeSpectrum()) {
        return text(`Execution tracing is Spectrum-only (active model: ${state.model.toUpperCase()}).`);
      }
      if (mode === 'zxtl') clearZxtlBuffer();
      state.spec.services.debug.startTrace(mode);
      return text(`Trace started (${mode} mode)`);
    },
  );

  server.registerTool(
    'stop_trace',
    { description: 'Stop the current trace and return the results. Full/portio: large traces written to file. ZXTL: stored in-memory — returns line count, use trace_read to fetch chunks.' },
    async () => {
      const spec = activeSpectrum();
      if (!spec) return text(`Execution tracing is Spectrum-only (active model: ${state.model.toUpperCase()}).`);
      if (!spec.tracing) return text('Not tracing');
      const mode = spec.traceMode;
      if (mode === 'zxtl') {
        // Snapshot the buffer before stopTrace clears internal state
        setZxtlBuffer(spec.traceBuffer);
        spec.stopTrace();
        return text(`ZXTL trace stopped: ${zxtlBufferSize()} lines stored in memory.\nUse trace_read to retrieve chunks by line range.`);
      }
      const traceText = spec.stopTrace();
      const lines = traceText.split('\n');
      if (lines.length <= 200) return text(traceText);
      const outPath = writeTraceFile('trace', traceText);
      return text(`Trace: ${lines.length} lines written to ${outPath}`);
    },
  );

  server.registerTool(
    'trace_read',
    { description: 'Read lines from the stored ZXTL trace buffer. Returns total line count plus the requested range.', inputSchema: {
      from: z.number().int().min(0).default(0).describe('Start line (0-based, inclusive)'),
      to: z.number().int().min(0).optional().describe('End line (exclusive, default: from+100)'),
    } },
    async ({ from, to }) => {
      const chunk = readZxtlChunk(from, to);
      if (chunk.total === 0) return text('No ZXTL trace in memory. Run a trace with mode "zxtl", then stop_trace.');
      return text(`ZXTL trace: ${chunk.total} total lines. Showing ${chunk.start}..${chunk.end - 1}:\n\n${chunk.lines.join('\n')}`);
    },
  );

  server.registerTool(
    'frame_trace',
    { description: 'Run one frame, logging per-instruction: T-state, beam line/col, contention delays, border changes, and VRAM writes. Writes to file.' },
    async () => {
      const spec = activeSpectrum();
      if (!spec) return text(`Frame trace is Spectrum-only (active model: ${state.model.toUpperCase()}).`);
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

      lines.push(`\n--- ${instrCount} instructions, frame ${fStart}-${frameEnd} ---`);

      const outPath = writeTraceFile('frame-trace', lines.join('\n'));
      return text(`Frame trace: ${instrCount} instructions written to ${outPath}`);
    },
  );
}
