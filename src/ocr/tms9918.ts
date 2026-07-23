/**
 * Machine-neutral name-table OCR for the TMS9918A/TMS9929A family.
 *
 * The existing MSX engine is hardware-based: in Text and Graphics I modes the
 * VDP name table contains the character codes directly. Export it through this
 * neutral facade so other TMS9918-family machines can reuse the same decoder
 * without presenting it as MSX-specific hardware.
 */
export {
  MsxScreenText as Tms9918ScreenText,
  msxTextGrid as tms9918TextGrid,
} from '@/ocr/msx.ts';
