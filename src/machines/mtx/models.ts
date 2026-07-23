export type MtxModel = 'mtx500' | 'mtx512' | 'rs128';

export function isMtxModel(model: string): model is MtxModel {
  return model === 'mtx500' || model === 'mtx512' || model === 'rs128';
}
