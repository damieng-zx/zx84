import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
import type { AtomMachine } from '../atom-machine.ts';

/** The Atom has one system-ROM image (the three 4 KB chips concatenated:
 *  BASIC, floating point and kernel), replaceable from the ROM pane. */
export class AtomRomService extends SingleRomService<AtomMachine> {}
