import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
import type { AcornSystemMachine } from '../machine.ts';

/** One system-ROM socket: the COS (2K) or a DOS/kernel (4K) at the top of the map. */
export class AcornSystemRomService extends SingleRomService<AcornSystemMachine> {}
