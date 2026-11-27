import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
import type { OricMachine } from '../oric-machine.ts';

/** The Oric has one 16 KB system-ROM socket (BASIC + OS), replaceable from the
 *  ROM pane. The Microdisc's EPROM is a separate socket that lands with the
 *  disk service. */
export class OricRomService extends SingleRomService<OricMachine> {}
