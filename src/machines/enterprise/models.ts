/**
 * Enterprise model classification.
 *
 * The 64 and the 128 are one board with 64K or 128K of RAM. The 64 shipped
 * with EXOS 2.0 and its RAM is all Nick's video RAM; the 128 has EXOS 2.1 and
 * a further 64K that Nick cannot see, which the CPU reaches without video
 * wait states. Both take BASIC as a cartridge.
 */

import type { MachineModel } from '@/models.ts';

export type EnterpriseModel = 'ep64' | 'ep128';

export function isEnterpriseModel(model: MachineModel): model is EnterpriseModel {
  return model === 'ep64' || model === 'ep128';
}

/** RAM segments fitted: they occupy the top of the 256-segment space. */
export function enterpriseRamSegments(model: EnterpriseModel): number {
  return model === 'ep64' ? 4 : 8;
}

// ── System-ROM slot geometry ───────────────────────────────────────────────
//
// Two sockets: the internal EXOS ROM and the BASIC cartridge. Each takes an
// image up to 64K; a short one leaves the segments above it empty.

export const ENTERPRISE_ROM_SLOT_LABELS = ['EXOS', 'BASIC cartridge'] as const;
