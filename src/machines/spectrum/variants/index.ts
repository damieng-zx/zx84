/**
 * Variant factory — creates the appropriate MachineVariant for a given model.
 */

import type { SpectrumModel } from '@/models.ts';
import type { MachineVariant } from './machine-variant.ts';
import { spectrum48K } from './spectrum-48k.ts';
import { spectrum16K } from './spectrum-16k.ts';
import { createFerranti128K } from './spectrum-ferranti.ts';
import { createAmstrad } from './spectrum-amstrad.ts';
import { createPentagon } from './spectrum-pentagon.ts';
import { spectrumScorpion } from './spectrum-scorpion.ts';

export type { MachineVariant } from './machine-variant.ts';

export function createVariant(model: SpectrumModel): MachineVariant {
  switch (model) {
    case 'zx16k':  return spectrum16K;
    case 'zx48k':  return spectrum48K;
    case 'zx128k': return createFerranti128K('zx128k');
    case 'zx128kplus2':   return createFerranti128K('zx128kplus2');
    case 'zx128kplus2a':  return createAmstrad('zx128kplus2a');
    case 'zx128kplus3':   return createAmstrad('zx128kplus3');
    case 'pentagon128': return createPentagon('pentagon128');
    case 'pentagon512': return createPentagon('pentagon512');
    case 'pentagon1024': return createPentagon('pentagon1024');
    case 'scorpion256': return spectrumScorpion;
  }
}
