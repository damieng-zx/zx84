export type Apple2Model = 'apple2-plus';

export function isApple2Model(model: string): model is Apple2Model {
  return model === 'apple2-plus';
}

/** Size of the system ROM image mapped at $D000-$FFFF (Applesoft + Monitor). */
export const APPLE2_ROM_SIZE = 0x3000;
/** Size of the Disk II controller card ROM in slot 6 ($C600-$C6FF). */
export const DISK2_ROM_SIZE = 0x0100;
/** Size of the video character-generator ROM (256 glyphs × 8 rows). */
export const APPLE2_CHARGEN_SIZE = 0x0800;
