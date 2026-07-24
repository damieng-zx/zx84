export type MtxModel = 'mtx500' | 'mtx512' | 'rs128';

export function isMtxModel(model: string): model is MtxModel {
  return model === 'mtx500' || model === 'mtx512' || model === 'rs128';
}

/**
 * The MTX's switchable firmware ROMs are 8K each, not the Spectrum's 16K banks.
 * The ROM/Carts pane reuses the Spectrum multi-slot mechanism at this stride.
 */
export const MTX_ROM_SLOT_SIZE = 0x2000;

/**
 * The five firmware ROMs, in the concatenation order MtxMemory.loadRom expects
 * (OS, BASIC, ASSEM, CP/M bootstrap, FDX Disk BASIC) — matching the CDN source
 * order in the MTX machine entry's romSources(). Each is one ROM/Carts pane
 * slot; the label names the default (non-overridden) image for that slot.
 */
export const MTX_ROM_SLOT_LABELS = [
  'MTX OS', 'MTX BASIC', 'MTX ASSEM', 'CP/M Bootstrap', 'FDX Disk BASIC',
] as const;
