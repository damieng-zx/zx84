/**
 * NewBrain MediaService — cassettes as WAV or CSW recordings played through
 * the pulse deck. ZIP unwrapping stays a shell concern.
 */

import type { MediaService, MediaTypeDescriptor, MediaTargetId, MountResult } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import { wavToPulseBlocks } from '@/media/tape/wav.ts';
import type { NewBrainTapeService } from './tape.ts';

export class NewBrainMediaService implements MediaService {
  constructor(private readonly tape: NewBrainTapeService) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.wav', target: 'tape' },
      { ext: '.csw', target: 'tape' },
    ];
  }

  async mount(data: Uint8Array, filename: string, _target?: MediaTargetId): Promise<MountResult> {
    const ext = filename.toLowerCase().split('.').pop();
    if (ext !== 'wav' && ext !== 'csw') {
      return { ok: false, message: 'The NewBrain accepts .wav and .csw cassette recordings (or a .zip of one)' };
    }
    let blocks: TapeBlock[];
    try {
      blocks = ext === 'csw' ? await parseCSW(data) : wavToPulseBlocks(data);
    } catch (e) {
      return { ok: false, message: `Error: ${(e as Error).message}` };
    }
    this.tape.mountBlocks(blocks, filename);
    return { ok: true, target: 'tape', message: `Tape loaded: ${filename} — type: LOAD, then press PLAY` };
  }
}
