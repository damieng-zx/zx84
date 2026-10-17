/**
 * Electron-owned UI access to the currently running Acorn Electron motherboard.
 */

import { machine } from '@/shell/context.ts';
import type { ElectronMachine } from '@/machines/electron/electron-machine.ts';

export function activeElectron(): ElectronMachine | null {
  return machine && machine.kind === 'electron'
    ? (machine as unknown as ElectronMachine)
    : null;
}
