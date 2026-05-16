/**
 * Classification helpers for SpectrumModel.
 *
 * These tiny predicates underpin every "is this model 128K-class?" /
 * "does it have FDC?" decision in the codebase. Pin the full truth table
 * here so any future model addition forces the table to be re-asserted.
 */

import { describe, it, expect } from 'vitest';
import {
  type SpectrumModel,
  is128kClass,
  is16K,
  isPlus2AClass,
  isPlus3,
} from '@/models.ts';

const ALL_MODELS: SpectrumModel[] = ['16k', '48k', '128k', '+2', '+2A', '+3'];

describe('models — classification helpers', () => {
  it('is16K matches only 16K', () => {
    const truth: Record<SpectrumModel, boolean> = {
      '16k': true, '48k': false, '128k': false, '+2': false, '+2A': false, '+3': false,
    };
    for (const m of ALL_MODELS) expect(is16K(m)).toBe(truth[m]);
  });

  it('is128kClass matches 128K/+2/+2A/+3 (everything except 16K/48K)', () => {
    const truth: Record<SpectrumModel, boolean> = {
      '16k': false, '48k': false, '128k': true, '+2': true, '+2A': true, '+3': true,
    };
    for (const m of ALL_MODELS) expect(is128kClass(m)).toBe(truth[m]);
  });

  it('isPlus2AClass matches only +2A and +3 (Amstrad gate array)', () => {
    const truth: Record<SpectrumModel, boolean> = {
      '16k': false, '48k': false, '128k': false, '+2': false, '+2A': true, '+3': true,
    };
    for (const m of ALL_MODELS) expect(isPlus2AClass(m)).toBe(truth[m]);
  });

  it('isPlus3 matches only +3 (has FDC)', () => {
    const truth: Record<SpectrumModel, boolean> = {
      '16k': false, '48k': false, '128k': false, '+2': false, '+2A': false, '+3': true,
    };
    for (const m of ALL_MODELS) expect(isPlus3(m)).toBe(truth[m]);
  });

  it('class predicates partition the model space sensibly', () => {
    for (const m of ALL_MODELS) {
      // +2A class is a strict subset of 128K class
      if (isPlus2AClass(m)) expect(is128kClass(m)).toBe(true);
      // +3 is a strict subset of +2A class
      if (isPlus3(m)) expect(isPlus2AClass(m)).toBe(true);
      // 16K is exclusive of everything else
      if (is16K(m)) {
        expect(is128kClass(m)).toBe(false);
        expect(isPlus2AClass(m)).toBe(false);
        expect(isPlus3(m)).toBe(false);
      }
    }
  });
});
