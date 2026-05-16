/**
 * Spectrum model type and classification helpers.
 *
 * Extracted from spectrum.ts to break circular imports — variant files
 * need SpectrumModel but spectrum.ts needs variants.
 */

export type SpectrumModel = '16k' | '48k' | '128k' | '+2' | '+2A' | '+3';

/** Returns true for any 128K-class model (128K, +2, +2A, +3). */
export function is128kClass(m: SpectrumModel): boolean { return m !== '48k' && m !== '16k'; }

/** Returns true for the issue 1/2 16K Spectrum (no upper 32KB of RAM). */
export function is16K(m: SpectrumModel): boolean { return m === '16k'; }

/** Returns true for +2A/+3 class (Amstrad gate array with 0x1FFD port, 4 ROM pages). */
export function isPlus2AClass(m: SpectrumModel): boolean { return m === '+2A' || m === '+3'; }

/** Returns true for +3 (has uPD765A FDC). */
export function isPlus3(m: SpectrumModel): boolean { return m === '+3'; }
