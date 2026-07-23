/**
 * CPC model classification helpers.
 *
 * The Plus range (6128Plus + GX4000) and the non-Plus 464/664/6128 share the
 * Z80/AY/CRTC cores but differ in: ASIC vs gate array, cartridge port presence,
 * cassette presence (GX4000 drops it), and disk presence (GX4000 drops it).
 * Each helper's expected value is derived from the published hardware spec —
 * not from the implementation — so a regression in the helpers will fail loudly.
 */

import { describe, it, expect } from 'vitest';
import {
  isCpcModel,
  cpcHasDisk,
  cpcHasTape,
  cpcIsPlusClass,
} from '@/machines/cpc/models.ts';
import type { MachineModel } from '@/models.ts';

const CPC: ReadonlyArray<MachineModel> = ['cpc464', 'cpc664', 'cpc6128', 'cpc6128plus', 'gx4000'];
const NON_CPC: ReadonlyArray<MachineModel> = ['48k', '128k', '+2', '+2A', '+3', '16k', 'einstein-tc01', 'hx-10'];

describe('isCpcModel', () => {
  it('returns true for every CPC family model', () => {
    for (const m of CPC) expect(isCpcModel(m)).toBe(true);
  });
  it('returns false for non-CPC models', () => {
    for (const m of NON_CPC) expect(isCpcModel(m)).toBe(false);
  });
});

describe('cpcHasDisk', () => {
  // Spec: uPD765A + 3" drive on the 664, 6128 and 6128Plus. The 464 is
  // cassette-only. The GX4000 console has no floppy subsystem.
  it.each([
    ['cpc464', false],
    ['cpc664', true],
    ['cpc6128', true],
    ['cpc6128plus', true],
    ['gx4000', false],
  ] as const)('%s -> %s', (model, expected) => {
    expect(cpcHasDisk(model)).toBe(expected);
  });
});

describe('cpcHasTape', () => {
  // Spec: the 464/664/6128 all expose a cassette port; the 6128Plus keeps it;
  // the GX4000 console drops tape entirely (cartridge-only boot).
  it.each([
    ['cpc464', true],
    ['cpc664', true],
    ['cpc6128', true],
    ['cpc6128plus', true],
    ['gx4000', false],
  ] as const)('%s -> %s', (model, expected) => {
    expect(cpcHasTape(model)).toBe(expected);
  });
});

describe('cpcIsPlusClass', () => {
  // Spec: the Plus ASIC (Amstrad 40489) ships in the 6128Plus and the GX4000.
  // The 464/664/6128 use the discrete 40010 gate array (or its Amstrad ASIC
  // cost-down 40226, which has none of the Plus features).
  it.each([
    ['cpc464', false],
    ['cpc664', false],
    ['cpc6128', false],
    ['cpc6128plus', true],
    ['gx4000', true],
  ] as const)('%s -> %s', (model, expected) => {
    expect(cpcIsPlusClass(model)).toBe(expected);
  });
});
