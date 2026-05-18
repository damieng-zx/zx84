/**
 * MCP Server for ZX84 emulator.
 *
 * Wraps the Spectrum emulator as a persistent MCP tool server so Claude Code
 * can interact with it without spinning up/tearing down the harness each time.
 *
 * Usage:
 *   npx tsx mcp/server.ts [--model 48k|128k|+2|+2A|+3]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { SpectrumModel } from '../src/spectrum.ts';
import { initMachine } from './state.ts';

import { register as registerMachine } from './tools/machine.ts';
import { register as registerMemory } from './tools/memory.ts';
import { register as registerBreakpoints } from './tools/breakpoints.ts';
import { register as registerTraps } from './tools/traps.ts';
import { register as registerIo } from './tools/io.ts';
import { register as registerMedia } from './tools/media.ts';
import { register as registerTrace } from './tools/trace.ts';
import { register as registerPeripherals } from './tools/peripherals.ts';
import { register as registerSymbols } from './tools/symbols.ts';

const server = new McpServer({
  name: 'zx84',
  version: '1.0.0',
});

registerMachine(server);
registerMemory(server);
registerBreakpoints(server);
registerTraps(server);
registerIo(server);
registerMedia(server);
registerTrace(server);
registerPeripherals(server);
registerSymbols(server);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let startModel: SpectrumModel = '48k';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && i + 1 < args.length) {
      const m = args[++i];
      if (['16k', '48k', '128k', '+2', '+2A', '+3'].includes(m)) {
        startModel = m as SpectrumModel;
      }
    }
  }

  await initMachine(startModel);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`MCP server error: ${e}\n`);
  process.exit(1);
});
