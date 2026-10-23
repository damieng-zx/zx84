import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { selectChips } from '../../src/debug/chip-state.ts';
import { state } from '../state.ts';
import { text } from '../format.ts';

export function register(server: McpServer): void {
  server.registerTool(
    'chip_state',
    { description: 'Dump the state of the machine\'s custom chips — registers (address, name, value) and decoded fields — read from the chips themselves, never through the CPU bus, so it clears no interrupt flag and trips no watchpoint. With no chip, every chip the machine has; chip is a name or comma list (e.g. "gtia" or "antic,gtia"), case-insensitive; chip "list" gives the names. Write-only registers show the chip\'s own value, not the OS shadow. The Atari has antic (with the decoded display list), gtia, pokey and pia.', inputSchema: {
      chip: z.string().optional().describe('Chip name(s), comma-separated; "list" for the names; omit for all'),
    } },
    async ({ chip }) => {
      const chips = state.spec.services.debug.chips?.() ?? [];
      if (chips.length === 0) {
        return text(`chip_state is not supported on this machine yet (${state.model.toUpperCase()}).`);
      }
      const names = chips.map(c => c.name).join(', ');
      if (chip?.trim().toLowerCase() === 'list') {
        return text(chips.map(c => `${c.name.padEnd(8)} ${c.description}`).join('\n'));
      }
      const { chosen, unknown } = chip === undefined || chip.trim() === ''
        ? { chosen: [...chips], unknown: [] as string[] }
        : selectChips(chips, chip);
      if (unknown.length > 0) {
        return text(`Unknown chip${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. This machine has: ${names}.`);
      }
      return text(chosen.map(c => `== ${c.name}: ${c.description} ==\n${c.dump()}`).join('\n\n'));
    },
  );
}
