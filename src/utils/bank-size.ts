/**
 * The size of one 16KB memory bank / ROM page, in bytes.
 *
 * Lives in the neutral `utils` layer (not inside a machine folder) because
 * machine-agnostic plumbing — the ROM manager and the shell's ROM/cartridge
 * handling — needs this constant without importing a concrete machine's memory.
 * `SpectrumMemory` re-exports it for the Spectrum's own internal use.
 */
export const BANK_SIZE = 16_384;
