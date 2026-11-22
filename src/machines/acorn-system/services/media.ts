import type {
  MediaService, MediaTargetId, MediaTypeDescriptor, MountResult,
} from '@/machines/machine.ts';
import { ACORN_TAPE_EXTENSIONS, type AcornTapeService } from '@/machines/shared/acorn-tape-service.ts';
import type { AcornSystemMachine } from '../machine.ts';

/**
 * Acorn System 2 media routing.
 *
 * Only the cassette takes files: the machine has no disc controller (that is
 * the System 3). UEF, CSW and WAVE images play through the CUTS interface on
 * the CPU card's 8154, which the COS's own LOAD/FLOAD routines read; ROM images
 * go through the ROM pane's picker.
 */
export class AcornSystemMediaService implements MediaService {
  constructor(
    private readonly machine: AcornSystemMachine,
    private readonly tape: AcornTapeService,
  ) {}

  accepts(): MediaTypeDescriptor[] {
    return ACORN_TAPE_EXTENSIONS.map(ext => ({ ext, target: 'tape' }));
  }

  async mount(
    data: Uint8Array,
    filename: string,
    _target?: MediaTargetId,
  ): Promise<MountResult> {
    if (!/\.(uef|csw|wav)$/i.test(filename)) {
      return {
        ok: false,
        message: `${filename}: the ${this.machine.descriptor.model} loads .uef/.csw/.wav cassettes`,
      };
    }
    if (!await this.tape.mountBytes(data, filename)) {
      return { ok: false, message: `Tape error: ${filename} is not a readable UEF, CSW or WAVE image` };
    }
    return { ok: true, target: 'tape', message: `Tape loaded: ${filename}` };
  }
}
