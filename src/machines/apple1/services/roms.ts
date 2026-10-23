import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
import type { Apple1Machine } from '../apple1-machine.ts';

/** The Apple I has a single ROM: the 256-byte Woz Monitor. */
export class Apple1RomService extends SingleRomService<Apple1Machine> {
  protected override readonly showSlot = false;
}
