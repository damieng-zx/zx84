/**
 * MSX peripheral-ROM requests: the Disk BASIC ROM of the optional floppy disk
 * interface and a model's optional on-board firmware ROM (HB-55 Data Bank). The machine says which ROM it wants and how to wire it in; the
 * shell (or the MCP server) does the fetching and caching.
 */

import type { AuxRomRequest } from '@/machines/machine.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';

/** Hosted under the ROM base (`roms/msx/…`). A plain MSX1 Disk BASIC ROM of
 *  16KB, as shipped on the Philips / Sony / National-style disk cartridges. */
export const MSX_DISK_ROM = 'msx/msx1_disk-basic.rom';

/** The model's on-board firmware ROM (only requested when its config has one). */
export function msxFirmwareAuxRom(m: MsxMachine): AuxRomRequest {
  const fw = m.config.firmware!;
  return {
    cacheKey: fw.cacheKey, source: fw.source,
    fetchingMsg: `Fetching ${fw.label} ROM…`,
    loadedMsg: (n) => `${fw.label} ROM loaded (${n} bytes)`,
    failMsg: `${fw.label} ROM unavailable — continuing without it`, failId: 'msxfirmware',
    apply: (d) => m.loadFirmware(d), awaitLoad: true,
  };
}

export function msxDiskAuxRom(m: MsxMachine): AuxRomRequest {
  return {
    cacheKey: 'msx-disk-rom', source: MSX_DISK_ROM,
    fetchingMsg: 'Fetching MSX Disk BASIC ROM…',
    loadedMsg: (n) => `MSX Disk BASIC ROM loaded (${n} bytes)`,
    failMsg: 'Failed to load MSX Disk BASIC ROM', failId: 'msxdisk',
    apply: (d) => m.loadDiskRom(d), awaitLoad: true,
  };
}
