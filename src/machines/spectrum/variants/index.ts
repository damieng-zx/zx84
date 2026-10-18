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
    case '16k':  return spectrum16K;
    case '48k':  return spectrum48K;
    case '128k': return createFerranti128K('128k');
    case '+2':   return createFerranti128K('+2');
    case '+2A':  return createAmstrad('+2A');
    case '+3':   return createAmstrad('+3');
    case 'pentagon128': return createPentagon('pentagon128');
    case 'pentagon512': return createPentagon('pentagon512');
    case 'pentagon1024': return createPentagon('pentagon1024');
    case 'scorpion256': return spectrumScorpion;
  }
}
