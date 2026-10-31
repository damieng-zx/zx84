/**
 * Grundy NewBrain model classification.
 *
 * The NewBrain A and AD are the same board — the AD adds the internal 16-digit
 * vacuum-fluorescent display, which this machine always models. Expansion
 * modules (RAM paging, disks, CP/M) are not modelled.
 */

import type { MachineModel } from '@/models.ts';

export type NewBrainModel = 'newbrain';

export function isNewBrainModel(m: MachineModel): m is NewBrainModel {
  return m === 'newbrain';
}
