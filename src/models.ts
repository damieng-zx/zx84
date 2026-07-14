/**
 * Spectrum model type and classification helpers.
 *
 * Extracted from spectrum.ts to break circular imports — variant files
 * need SpectrumModel but spectrum.ts needs variants.
 */

export type SpectrumModel = '16k' | '48k' | '128k' | '+2' | '+2A' | '+3';

// The classification helpers accept the open `MachineModel` so callers can pass
// `currentModel()` directly; every helper returns false for non-Spectrum models.

/** Returns true for any 128K-class Spectrum (128K, +2, +2A, +3). */
export function is128kClass(m: MachineModel): boolean {
  return m === '128k' || m === '+2' || m === '+2A' || m === '+3';
}

/** Returns true for the issue 1/2 16K Spectrum (no upper 32KB of RAM). */
export function is16K(m: MachineModel): boolean { return m === '16k'; }

/** Returns true for +2A/+3 class (Amstrad gate array with 0x1FFD port, 4 ROM pages). */
export function isPlus2AClass(m: MachineModel): boolean { return m === '+2A' || m === '+3'; }

/** Returns true for +3 (has uPD765A FDC). */
export function isPlus3(m: MachineModel): boolean { return m === '+3'; }

/**
 * Returns true for models the MGT +D interface can attach to: the plain
 * 48K/128K/+2. Excluded: the 16K (too little RAM for G+DOS) and the +2A/+3
 * (Amstrad special paging conflicts, and they already have a built-in FDC).
 */
export function isPlusDCapable(m: MachineModel): boolean {
  return m === '48k' || m === '128k' || m === '+2';
}

/**
 * Returns true for models the ZX Interface 1 can attach to: the Ferranti-ULA
 * 48K/128K/+2. Excluded: the 16K and the Amstrad +2A/+3, whose redesigned edge
 * connector the IF1 is not electrically compatible with.
 */
export function isInterface1Capable(m: MachineModel): boolean {
  return m === '48k' || m === '128k' || m === '+2';
}

/**
 * Returns true for models the Beta Disk interface (TR-DOS) can attach to: the
 * Ferranti-ULA 48K/128K/+2. Excluded: the 16K and the Amstrad +2A/+3 (which
 * already have a built-in FDC and use special paging). The classic setup is a
 * Beta Disk on a 48K.
 */
export function isBetaDiskCapable(m: MachineModel): boolean {
  return m === '48k' || m === '128k' || m === '+2';
}

// ── Amstrad CPC family ──────────────────────────────────────────────────
//
// The CPC is a different machine, not a Spectrum variant — it gets its own
// model union so the Spectrum helpers above stay closed over SpectrumModel and
// never have to consider a CPC value. `MachineModel` is the open union used by
// model-agnostic plumbing (rom-manager, emulator state, the model dropdown).

/** Amstrad CPC models. Only 'cpc6128' ships today; the others are the
 *  extension point for the 464/664 (different RAM/ROM/CRTC). */
export type CpcModel = 'cpc6128' | 'cpc464' | 'cpc664';

/** Any machine ZX84 can emulate. */
export type MachineModel = SpectrumModel | CpcModel;

/** Type guard: true for any Amstrad CPC model. */
export function isCpcModel(m: MachineModel): m is CpcModel {
  return m === 'cpc6128' || m === 'cpc464' || m === 'cpc664';
}

/** True for a CPC model with a built-in disk drive (664/6128 have a uPD765A;
 *  the 464 is cassette only). Used to gate disk UI / hardware. */
export function cpcHasDisk(m: MachineModel): boolean {
  return m === 'cpc6128' || m === 'cpc664';
}
