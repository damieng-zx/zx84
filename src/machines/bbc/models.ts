export type BbcModel = 'bbc-b';

export function isBbcModel(model: string): model is BbcModel {
  return model === 'bbc-b';
}

/** Size of one sideways-ROM socket, and of the OS ROM window. */
export const BBC_ROM_SIZE = 0x4000;
