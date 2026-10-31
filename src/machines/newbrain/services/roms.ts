/**
 * NewBrain RomService — one combined system image: the three 8K Z80 ROMs, the
 * COP420 firmware and the character generator, joined in that order. No
 * cartridge slot.
 */

import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
import type { NewBrainMachine } from '../newbrain-machine.ts';

export class NewBrainRomService extends SingleRomService<NewBrainMachine> {}
