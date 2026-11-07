/** The Model B (32 KB) and the Model A (16 KB, the early home machine without
 *  the User VIA, analogue port or disc interface fitted as standard). */
export type BbcModel = 'bbc-a' | 'bbc-b';

export function isBbcModel(model: string): model is BbcModel {
  return model === 'bbc-a' || model === 'bbc-b';
}

/** RAM fitted below the sideways window: 16 KB on the Model A, 32 KB on the B. */
export function bbcRamSize(model: BbcModel): number {
  return model === 'bbc-a' ? 0x4000 : 0x8000;
}

/** Which disc interface (if any) is fitted: the original Intel 8271 Acorn DFS,
 *  the later WD1770 upgrade, or no drives at all. */
export type BbcDiskSystem = 'none' | 'acorn' | '1770';

/** Size of one sideways-ROM socket, and of the OS ROM window. */
export const BBC_ROM_SIZE = 0x4000;

/** Sideways sockets whose RAM can be fitted from the Hardware pane: the three
 *  groups of four below the BASIC/DFS sockets (12-15), the way RAM boards in
 *  the ROM sockets are usually arranged. The setting is a bit mask of banks. */
export const BBC_SWR_GROUPS: readonly { label: string; mask: number }[] = [
  { label: '0–3', mask: 0x000F },
  { label: '4–7', mask: 0x00F0 },
  { label: '8–11', mask: 0x0F00 },
];
