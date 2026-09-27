import type { MediaService, MediaTypeDescriptor, MediaTargetId, MountResult } from '@/machines/machine.ts';
import type { Zx8xMachine } from '../zx8x-machine.ts';
import { programNameFromFilename, zx81NameToAscii } from '../tape-shelf.ts';

/** Remove the variable-length filename prefix used by P81 images. */
function p81Payload(data: Uint8Array): Uint8Array {
  const limit = Math.min(128, data.length);
  for (let i = 0; i < limit; i++) {
    if (data[i] & 0x80) return data.subarray(i + 1);
  }
  return data;
}

/** The tape name a P81 image carries ahead of its payload, if any. */
function p81Name(data: Uint8Array): string | null {
  const limit = Math.min(128, data.length);
  for (let i = 0; i < limit; i++) {
    if (data[i] & 0x80) return zx81NameToAscii(data.subarray(0, i + 1)).trim();
  }
  return null;
}

export class Zx8xMediaService implements MediaService {
  constructor(private readonly machine: Zx8xMachine) {}

  accepts(): MediaTypeDescriptor[] {
    return this.machine.model === 'zx80'
      ? [{ ext: '.o', target: 'program' }, { ext: '.80', target: 'program' }]
      : [{ ext: '.p', target: 'program' }, { ext: '.81', target: 'program' }, { ext: '.p81', target: 'program' }];
  }

  async mount(data: Uint8Array, filename: string, _target?: MediaTargetId): Promise<MountResult> {
    const isZx80 = /\.(o|80)$/i.test(filename);
    const isZx81 = /\.(p|81|p81)$/i.test(filename);
    if ((this.machine.model === 'zx80' && !isZx80) || (this.machine.model === 'zx81' && !isZx81)) {
      return { ok: false, message: this.machine.model === 'zx80' ? 'ZX80 accepts .o and .80 program images' : 'ZX81 accepts .p, .81 and .p81 program images' };
    }
    const payload = /\.p81$/i.test(filename) ? p81Payload(data) : data;
    const address = this.machine.model === 'zx80' ? 0x4000 : 0x4009;
    if (payload.length > this.machine.memory.ramSize - (address - 0x4000)) {
      return { ok: false, message: `${filename} needs 16KB RAM` };
    }
    const isP81 = /\.p81$/i.test(filename);
    const name = (isP81 ? p81Name(data) : null) ?? programNameFromFilename(filename);
    // A LOAD already waiting for the tape reads this program in, whatever
    // name it asked for: the user is pressing PLAY on it.
    if (this.machine.awaitingTapeLoad) {
      this.machine.tapeShelf.cue(name, payload.slice());
      return { ok: true, target: 'program', message: `Tape playing: ${filename}` };
    }
    this.machine.tapeShelf.insert(name, payload.slice(), true);
    this.machine.loadProgram(payload, address);
    return { ok: true, target: 'program', message: `Program loaded: ${filename}` };
  }
}
