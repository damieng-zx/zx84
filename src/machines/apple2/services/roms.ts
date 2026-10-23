import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
import type { Apple2Machine } from '../apple2-machine.ts';

/** The Apple II has a single system ROM (Applesoft + Monitor); the Disk II
 *  card ROM is a peripheral image loaded at build time, not a user slot. */
export class Apple2RomService extends SingleRomService<Apple2Machine> {
  protected override readonly showSlot = false;
}
