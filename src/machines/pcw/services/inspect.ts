/**
 * PCW on-demand inspection: the memory-layout snapshot. Reads and writes can
 * address different physical blocks (ports &F0-&F3 bit 7 clear), so both are
 * shown.
 */

import type { MachineInspection, MemoryMapSlot, MemoryMapSnapshot } from '@/machines/machine.ts';
import { hex8 } from '@/utils/hex.ts';
import type { PcwMachine } from '../pcw-machine.ts';
import { PCW_KEYBOARD_BLOCK } from '../constants.ts';

export class PcwInspection implements MachineInspection {
  constructor(private readonly machine: PcwMachine) {}

  memoryMap(): MemoryMapSnapshot {
    const m = this.machine;
    const p = m.memory.pagingState();
    const ranges = ['C000-FFFF', '8000-BFFF', '4000-7FFF', '0000-3FFF'];
    const rollerBlock = m.asic.rollerAddress >>> 14;

    const slots: MemoryMapSlot[] = ranges.map((range, row) => {
      const index = 3 - row;
      const src = p.blocks[index];
      const read = `Block ${src.read}`;
      const write = `Block ${src.write}`;
      const flags: ('screen' | 'active')[] = [];
      // The display fetch reads physical blocks directly and ignores CPU paging,
      // so a block is flagged only when the roller RAM actually points into it.
      if (src.read === rollerBlock) flags.push('screen');
      if (src.read === PCW_KEYBOARD_BLOCK) flags.push('active');
      return { range, read, write, flags: flags.length ? flags : undefined };
    });

    return {
      columns: ['CPU read', 'CPU write'],
      slots,
      registers: [
        { name: 'F0', value: hex8(p.banks[0]) },
        { name: 'F1', value: hex8(p.banks[1]) },
        { name: 'F2', value: hex8(p.banks[2]) },
        { name: 'F3', value: hex8(p.banks[3]) },
        { name: 'F4', value: hex8(p.memctl) },
        { name: 'Roller', value: hex8(m.asic.rollerBase) },
        { name: 'Booted', value: m.booted ? 'Y' : 'N' },
      ],
    };
  }
}
