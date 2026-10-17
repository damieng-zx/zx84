export type ElectronModel = 'electron';

export function isElectronModel(model: string): model is ElectronModel {
  return model === 'electron';
}

/** Size of one paged ROM window and of the OS ROM. */
export const ELECTRON_ROM_SIZE = 0x4000;
/** The ULA pages sixteen 16K ROM windows into 0x8000-0xBFFF. */
export const ELECTRON_ROM_PAGES = 16;
/** Pages 8 and 9 read the keyboard; 10 and 11 both select BASIC. */
export const ELECTRON_KEYBOARD_PAGE = 8;
export const ELECTRON_BASIC_PAGE = 10;
