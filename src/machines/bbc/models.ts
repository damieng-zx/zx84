export type BbcModel = 'bbc-b';

export function isBbcModel(model: string): model is BbcModel {
  return model === 'bbc-b';
}

/** Which disc interface (if any) is fitted: the original Intel 8271 Acorn DFS,
 *  the later WD1770 upgrade, or no drives at all. */
export type BbcDiskSystem = 'none' | 'acorn' | '1770';

/** Size of one sideways-ROM socket, and of the OS ROM window. */
export const BBC_ROM_SIZE = 0x4000;
