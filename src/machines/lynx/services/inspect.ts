/**
 * Camputers Lynx on-demand inspection: the 8 KB slot layout the Memory pane
 * shows, plus the write-target, green-plane and cassette-motor state.
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import { hex8 } from '@/utils/hex.ts';
import type { LynxMachine } from '../lynx-machine.ts';

export class LynxInspection implements MachineInspection {
  constructor(private readonly machine: LynxMachine) {}

  memoryMap(): MemoryMapSnapshot {
    const m = this.machine;
    const labels = m.memory.slotLabels;
    const slots = [];
    for (let slot = 7; slot >= 0; slot--) {
      const base = slot * 0x2000;
      slots.push({
        range: `${hex8(base >> 8)}00-${hex8(((base + 0x1fff) >> 8) & 0xff)}FF`,
        read: labels[slot],
      });
    }

    // A store goes to every bank enabled for writing, so the pane lists them as
    // one set rather than per slot.
    const banks = m.memory.writeTargets;

    return {
      slots,
      registers: [
        { name: 'Writes to', value: banks.length > 0 ? banks.join(' + ') : 'nothing' },
        { name: 'Green plane', value: m.video.altGreen ? 'alternate' : 'main' },
        { name: 'Cassette', value: m.tapeMotorOn ? 'motor on' : 'motor off' },
      ],
    };
  }
}
