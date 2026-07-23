export type Zx81HiResMode = 'software' | 'udg' | 'udg128' | 'wrx' | 'memotech' | 'quicksilva';

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
  udg128Ram: boolean;
  wrxHires: boolean;
  memotechHrg: boolean;
  quickSilvaHrg: boolean;
}

/** Runtime fallbacks for the currently published catalog, which predates its
 * ZXDB `ZX81 Enhanced Graphics` fields. Future catalogs carry those tags
 * directly; these stable IDs make existing cached catalogs work immediately. */
export const ZX8X_HARDWARE_OVERRIDES: Readonly<Record<number, Zx8xHardwareMetadata>> = {
  31906: { ramKb: 1, hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: WRX (Original 1K RAM)'] },
  32023: { ramKb: 16, hiRes: 'udg', enhancedGraphics: ['ZX81 Hi-res: UDG Card (Mapped at 3000h)'] },
  33460: { ramKb: 32, hiRes: 'udg', enhancedGraphics: ['ZX81 Hi-res: UDG Card (Mapped at 3000h)'] },
  35749: { ramKb: 1, hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: WRX (Original 1K RAM)'] },
  31951: { hiRes: 'memotech', enhancedGraphics: ['ZX81 Hi-res: Memotech HRG'] },
  31957: { hiRes: 'memotech', enhancedGraphics: ['ZX81 Hi-res: Memotech HRG'] },
  45174: { hiRes: 'memotech', enhancedGraphics: ['ZX81 Hi-res: Memotech HRG'] },
  45175: { hiRes: 'memotech', enhancedGraphics: ['ZX81 Hi-res: Memotech HRG'] },
  28651: { hiRes: 'quicksilva', enhancedGraphics: ['ZX81 Hi-res: QuickSilva HRG'] },
  28671: { hiRes: 'quicksilva', enhancedGraphics: ['ZX81 Hi-res: QuickSilva HRG'] },
  31770: { hiRes: 'quicksilva', enhancedGraphics: ['ZX81 Hi-res: QuickSilva HRG'] },
  31932: { hiRes: 'quicksilva', enhancedGraphics: ['ZX81 Hi-res: QuickSilva HRG'] },
  31938: { hiRes: 'quicksilva', enhancedGraphics: ['ZX81 Hi-res: QuickSilva HRG'] },
  31941: { hiRes: 'quicksilva', enhancedGraphics: ['ZX81 Hi-res: QuickSilva HRG'] },
  31943: { hiRes: 'quicksilva', enhancedGraphics: ['ZX81 Hi-res: QuickSilva HRG'] },
  42216: { hiRes: 'quicksilva', enhancedGraphics: ['ZX81 Hi-res: QuickSilva HRG'] },
  43088: { hiRes: 'quicksilva', enhancedGraphics: ['ZX81 Hi-res: QuickSilva HRG'] },
  43110: { hiRes: 'quicksilva', enhancedGraphics: ['ZX81 Hi-res: QuickSilva HRG'] },
  32011: { hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: HRG-ms'] },
  32029: { hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: HRG-ms'] },
  32043: { hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: HRG-ms'] },
  32055: { hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: HRG-ms'] },
  32064: { hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: HRG-ms'] },
  32065: { hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: HRG-ms'] },
  42259: { hiRes: 'wrx', enhancedGraphics: ['ZX81 Hi-res: HRG-ms'] },
  32046: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
  32049: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
  32047: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
  32048: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
  33441: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
  35923: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
  35930: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
  44315: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
  44316: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
  44510: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
  44512: { hiRes: 'udg128', enhancedGraphics: ['ZX81 Hi-res: UDG Card with CHR$ 128 scheme (Mapped at 3000h)'] },
};

export function zx8xHardwareOverride(id: number): Zx8xHardwareMetadata | undefined {
  return ZX8X_HARDWARE_OVERRIDES[id];
}

/** Translate the ZXDB graphics methods currently implemented by the emulator.
 * Unsupported tags remain catalog metadata so the browser can filter and
 * identify them without selecting incompatible hardware. */
export function zx81HiResModeForTags(tagIds: readonly number[]): Zx81HiResMode | null {
  if (tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.memotechHrg)) return 'memotech';
  if (tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.quickSilvaHrg)) return 'quicksilva';
  if (tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.udg128)) return 'udg128';
  if (tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.udg3000)) return 'udg';
  if (tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.wrx1k)
      || tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.wrxModified)
      || tagIds.includes(ZX81_ENHANCED_GRAPHICS_TAG.hrgMs)) return 'wrx';
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
  const off = { ram16k, udgRam: false, udg128Ram: false, wrxHires: false, memotechHrg: false, quickSilvaHrg: false };
  if (metadata.hiRes === 'udg') return { ...off, udgRam: true };
  if (metadata.hiRes === 'udg128') return { ...off, udg128Ram: true };
  if (metadata.hiRes === 'wrx') return { ...off, wrxHires: true };
  if (metadata.hiRes === 'memotech') return { ...off, memotechHrg: true };
  if (metadata.hiRes === 'quicksilva') return { ...off, quickSilvaHrg: true };
  if (metadata.hiRes === 'software') return off;
  return { ...current, ram16k };
}
