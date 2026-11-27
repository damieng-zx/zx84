/**
 * zx84's native Atari snapshot (`.a8state`).
 *
 * The shared native container (`machines/shared/native-state.ts`, magic
 * 'ZXA8') around the machine's own sections, written by
 * `AtariMachine.saveState` and read back by `loadState`, so a restore is
 * exact: the same CPU cycle, the same ANTIC walk, the same POKEY counters.
 * It is not a format other emulators read; Altirra's save states carry its
 * cycle-exact internals (scheduler offsets, the DMA pipeline, mid-instruction
 * CPU phase) that have no counterpart here.
 *
 * The HEAD is the shared one — model, media flag, ROM CRCs — plus the TV
 * standard between the model and the media flag. That is exactly the layout
 * this machine wrote before it moved onto the shared container, so `.a8state`
 * files from older builds still load byte for byte.
 *
 * The OS and BASIC ROMs are not in the file, only their CRCs (in that order),
 * so a restore can say when the state was saved under different firmware (RAM
 * then holds pointers into a ROM that is no longer there).
 */

import type { NativeStateInfo, NativeStateMachine, NativeStateSpec } from '@/machines/shared/native-state.ts';
import type { AtariMachine } from '../atari-machine.ts';
import { atariModelName, isAtariModel, type AtariModel, type AtariRegion } from '../models.ts';

/** The machine-specific HEAD fields, between the model and the media flag. */
interface AtariHead {
  readonly region: AtariRegion;
}

/** The machine behind a shared-container call (it is always an Atari here). */
function atari(m: NativeStateMachine): AtariMachine {
  return m as AtariMachine;
}

function headOf(info: NativeStateInfo): AtariHead {
  return info.head as AtariHead;
}

export const ATARI_STATE: NativeStateSpec = {
  ext: '.a8state',
  magic: 'ZXA8',
  version: 1,
  machineName: 'Atari',
  /** A 128K machine with four 360K disks, generously. */
  maxBody: 8 << 20,
  modelName: model => (isAtariModel(model as never) ? `Atari ${atariModelName(model as AtariModel)}` : null),
  writeHead: (w, m) => { w.str(atari(m).region); },
  readHead: r => {
    const region = r.str();
    if (region !== 'ntsc' && region !== 'pal') {
      throw new Error('Atari snapshot names a machine this build does not have');
    }
    return { region } satisfies AtariHead;
  },
  // `.a8state` v1 wrote the two CRCs straight after the media flag, with no
  // count byte (the shared default). Keep it that way so old files load.
  writeRomCrcs: (w, crcs) => { w.u32(crcs[0]); w.u32(crcs[1]); },
  readRomCrcs: r => [r.u32(), r.u32()],
  refuse: (m, info, filename) => {
    const region = headOf(info).region;
    const live = atari(m).region;
    return region === live
      ? ''
      : `${filename} was saved on a ${region.toUpperCase()} machine; this one is ${live.toUpperCase()}. Change the region and load it again`;
  },
  romMismatch: (m, info) => {
    const machine = atari(m);
    const live = machine.stateRomCrcs();
    const osDiffers = live[0] !== info.romCrcs[0];
    // A machine with no BASIC ROM fitted has no BASIC to point into, so its
    // absence is not a mismatch worth warning about.
    const basicDiffers = machine.memory.basicRom !== null && live[1] !== info.romCrcs[1];
    if (!osDiffers && !basicDiffers) return '';
    return ` — saved under a different ${osDiffers ? 'OS' : 'BASIC'} ROM, so it may not run`;
  },
};
