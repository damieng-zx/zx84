export type Zx81HiResMode = 'software' | 'udg' | 'wrx';

export const ZX81_ENHANCED_GRAPHICS_TAG = {
  software: 13001,
  memotechHrg: 13002,
  quickSilvaHrg: 13003,
  wrx1k: 13004,
  wrxModified: 13005,
  hrgMs: 13006,
  udg3000: 13007,
  udg128: 13008,
  chroma: 13010,
  unknown: 13015,
} as const;

export interface Zx8xHardwareMetadata {
  ramKb?: number | null;
  hiRes?: Zx81HiResMode | null;
  enhancedGraphics?: readonly string[];
}

export interface Zx8xLaunchHardware {
  ram16k: boolean;
  udgRam: boolean;
  wrxHires: boolean;
}

/** Runtime fallbacks for the currently published catalog, which predates its
 * ZXDB `ZX81 Enhanced Graphics` fields. Future catalogs carry those tags
 * directly; these stable IDs make existing cached catalogs work immediately. */
export const ZX8X_HARDWARE_OVERRIDES: Readonly<Record<number, Zx8xHardwareMetadata>> = {
  31906: { ramKb: 1, hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: WRX (Original 1K RAM)'] },
  32023: { ramKb: 16, hiRes: 'udg', enhancedGraphics: ['ZX81 Hi-res: UDG Card (Mapped at 3000h)'] },
  33460: { ramKb: 32, hiRes: 'udg', enhancedGraphics: ['ZX81 Hi-res: UDG Card (Mapped at 3000h)'] },
  35749: { ramKb: 1, hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: WRX (Original 1K RAM)'] },
};

export function zx8xHardwareOverride(id: number): Zx8xHardwareMetadata | undefined {
  return ZX8X_HARDWARE_OVERRIDES[id];
}

/** Translate the ZXDB graphics methods currently implemented by the emulator.
 * Unsupported tags remain catalog metadata so the browser can filter and
 * identify them without selecting incompatible hardware. */
export function zx81HiResModeForTags(tagIds: readonly number[]): Zx81HiResMode | null {
  if (tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.udg3000)) return 'udg';
  if (tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.wrx1k)
      || tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.wrxModified)) return 'wrx';
  if (tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.software)) return 'software';
  return null;
}

/** Resolve catalog requirements without disabling a user's selected hi-res
 * board for titles whose hardware is not yet annotated. Unknown RAM retains
 * the library's established 16KB default. */
export function zx8xLaunchHardware(
  metadata: Zx8xHardwareMetadata,
  current: Zx8xLaunchHardware,
): Zx8xLaunchHardware {
  const ram16k = metadata.ramKb === 1 ? false : true;
  if (metadata.hiRes === 'udg') return { ram16k, udgRam: true, wrxHires: false };
  if (metadata.hiRes === 'wrx') return { ram16k, udgRam: false, wrxHires: true };
  if (metadata.hiRes === 'software') return { ram16k, udgRam: false, wrxHires: false };
  return { ram16k, udgRam: current.udgRam, wrxHires: current.wrxHires };
}
