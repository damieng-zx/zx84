/**
 * Ace MediaService — the machine's own file routing: TAP/TZX/CDT/CSW cassettes
 * played back through the pulse deck. ZIP unwrapping stays a shell concern.
 *
 * The service mutates the machine only. Signals, persistence and machine
 * restart stay shell reflection, keyed off MountResult.target.
 */

import type { MediaService, MediaTypeDescriptor, MediaTargetId, MountResult } from '@/machines/machine.ts';
import type { JupiterAceMachine } from '../ace-machine.ts';
import type { DataBlock, TapeBlock } from '@/media/tape/tap.ts';
import { parseTZX } from '@/media/tape/tzx.ts';
import { parseCSW } from '@/media/tape/csw.ts';
import { parseAceTap } from '../ace-tape.ts';
import type { AceTapeService } from './tape.ts';

function fail(message: string): MountResult { return { ok: false, message }; }

export class AceMediaService implements MediaService {
  constructor(
    private readonly m: JupiterAceMachine,
    private readonly tape: AceTapeService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return [
      { ext: '.tap', target: 'tape' },
      { ext: '.tzx', target: 'tape' },
      { ext: '.cdt', target: 'tape' },
      { ext: '.csw', target: 'tape' },
    ];
  }

  async mount(data: Uint8Array, filename: string, _target?: MediaTargetId): Promise<MountResult> {
    const ext = filename.toLowerCase().split('.').pop();
    if (ext === 'tap' || ext === 'tzx' || ext === 'cdt' || ext === 'csw') {
      // Stop the machine first to prevent the frame loop from interfering.
      this.m.stop();
      let blocks: TapeBlock[];
      try {
        if (ext === 'tzx' || ext === 'cdt') blocks = parseTZX(data);
        else if (ext === 'csw') blocks = await parseCSW(data);
        else blocks = parseAceTap(data);   // Ace chunks are flag-less — NOT parseTAP
      } catch (e) {
        this.m.start();
        return fail(`Error: ${(e as Error).message}`);
      }
      this.tape.mountBlocks(blocks, filename);
      this.m.start();
      // Unlike a Spectrum's LOAD "", the Ace's LOAD takes the name unquoted
      // and compares it literally — wrong case and it prints "Dict:" then
      // hunts forever. mountBlocks has just tagged the pairs, so name the
      // first file exactly as stored rather than making the user guess.
      const lead = blocks.find(b => b.kind === 'data' && (b as DataBlock).file?.header) as DataBlock | undefined;
      const file = lead?.file;
      // Loading is two steps on the Ace and neither takes quotes: LOAD <name>
      // pulls the dictionary in, then typing the word itself runs it (tut-tut
      // loads as TUTTUT and runs as tuttut). A bytes file only loads — there
      // is no word to run afterwards.
      const runStep = file?.command === 'LOAD' ? ` ${file.name} ↵` : '';
      const hint = file ? ` — type: ${file.command} ${file.name} ↵${runStep}` : '';
      return { ok: true, target: 'tape', message: `Tape loaded: ${filename}${hint}` };
    }

    return fail('The Jupiter Ace accepts .tap, .tzx, .cdt and .csw cassettes (or a .zip of one)');
  }
}
