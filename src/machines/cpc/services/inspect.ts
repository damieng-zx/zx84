/**
 * CPC on-demand inspection: the memory-layout pane (ROM over RAM with write
 * fall-through) and Locomotive BASIC.
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import { parseLocomotiveBasic, parseLocomotiveVariables } from '@/basic/cpc-basic-parser.ts';
import { hex16 } from '@/utils/hex.ts';
import type { CpcMachine } from '../cpc-machine.ts';

/**
 * Build the CPC memory-layout snapshot. Unlike the Spectrum (a flat 64KB view),
 * the CPC overlays ROM on RAM with write fall-through, so each Z80 slot is shown
 * as a CPU-*read* source (ROM or RAM) and the RAM bank the CPU *writes* beneath
 * it. The footer decodes the RAM configuration, the selected/enabled ROMs, the
 * video DMA the CRTC sees, and the Gate-Array screen mode.
 */
function cpcMemoryMap(cpc: CpcMachine): MemoryMapSnapshot | null {
  const mem = cpc.memory;
  const p = mem.pagingState();

  // Name the upper ROM at &C000: 0 = BASIC, 7 = AMSDOS, others = expansion ROM.
  const upperName = (idx: number): string => {
    if (idx === 0) return 'BASIC';
    if (idx === 7) return 'AMSDOS';
    return `ROM ${idx}`;
  };

  // Which RAM bank the CRTC fetches from: the screen's CPU base is derived from
  // the 14-bit MA (R12/R13); its top two bits select one of the base-64K banks.
  const dispStart = cpc.crtc.displayStart;
  const screenBase = (dispStart & 0x3000) << 2;     // CPU address (0/4/8/C × 0x4000)
  const screenSlot = (screenBase >>> 14) & 3;
  const screenBank = screenSlot;                    // video DMA = base 64K, banks 0–3

  // One row per 16KB slot, high to low.
  const ranges = ['C000-FFFF', '8000-BFFF', '4000-7FFF', '0000-3FFF'];
  const slots = [];
  for (let row = 0; row < 4; row++) {
    const slot = 3 - row;
    let read: string;
    if (slot === 0 && p.lowerRomEnabled) {
      read = 'OS Rom';
    } else if (slot === 3 && p.upperRomEnabled) {
      const absent = mem.getUpperRom(p.selectedUpperRom) === undefined;
      read = absent ? `${upperName(p.selectedUpperRom)}!` : upperName(p.selectedUpperRom);
    } else {
      read = `RAM ${p.slotBanks[slot]}`;
    }
    const flags = slot === screenSlot ? ['screen' as const] : undefined;
    slots.push({ range: ranges[row], read, write: `RAM ${p.slotBanks[slot]}`, flags });
  }

  const registers = [
    { name: 'RAM config', value: `${p.ramConfig} → [${p.slotBanks.join(' ')}]  64K blk ${p.ram64kBlock}` },
    { name: 'Upper ROM', value: `${p.selectedUpperRom} ${upperName(p.selectedUpperRom)}  Low ${p.lowerRomEnabled ? 'on' : 'off'}  High ${p.upperRomEnabled ? 'on' : 'off'}` },
    { name: 'Video DMA', value: `bank ${screenBank}  base &${hex16(screenBase)}` },
    { name: 'Gate Array', value: `mode ${cpc.gateArray.mode}` },
  ];

  return { columns: ['CPU read', 'CPU write'], slots, registers };
}

export class CpcInspection implements MachineInspection {
  constructor(private readonly cpc: CpcMachine) {}

  memoryMap() { return cpcMemoryMap(this.cpc); }

  // The Locomotive BASIC program lives at &0170 under the OS ROM overlay.
  basicListing() { return parseLocomotiveBasic(this.cpc.memory.ramSnapshot()); }

  basicVars() { return parseLocomotiveVariables(this.cpc.memory.ramSnapshot()); }
}
