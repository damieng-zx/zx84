/**
 * Einstein RomService — the single 8KB MOS boot-monitor socket. No cartridge.
 */

import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';

export class EinsteinRomService extends SingleRomService<EinsteinMachine> {}
