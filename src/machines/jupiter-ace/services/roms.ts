/**
 * Ace RomService — the single 8KB FORTH-ROM socket. No cartridge slot (the
 * Ace has no cartridge hardware).
 */

import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
import type { JupiterAceMachine } from '../ace-machine.ts';

export class AceRomService extends SingleRomService<JupiterAceMachine> {}
