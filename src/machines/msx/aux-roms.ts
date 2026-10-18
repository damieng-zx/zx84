/**
 * MSX peripheral-ROM requests: the Disk BASIC ROM of the optional floppy disk
 * interface. The machine says which ROM it wants and how to wire it in; the
 * shell (or the MCP server) does the fetching and caching.
 */

import type { AuxRomRequest } from '@/machines/machine.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';

/** Hosted under the ROM base (`roms/msx/…`). A plain MSX1 Disk BASIC ROM of
 *  16KB, as shipped on the Philips / Sony / National-style disk cartridges. */
export const MSX_DISK_ROM = 'msx/msx1_disk-basic.rom';

export function msxDiskAuxRom(m: MsxMachine): AuxRomRequest {
  return {
    cacheKey: 'msx-disk-rom', source: MSX_DISK_ROM,
    fetchingMsg: 'Fetching MSX Disk BASIC ROM…',
    loadedMsg: (n) => `MSX Disk BASIC ROM loaded (${n} bytes)`,
    failMsg: 'Failed to load MSX Disk BASIC ROM', failId: 'msxdisk',
    apply: (d) => m.loadDiskRom(d), awaitLoad: true,
  };
}
