/** Upscaler (scaling mode) numbers shared by the renderer, the Display pane and
 *  the shell. 0-5 are the original nearest/bilinear, HQx and xBR modes. */

/** Mullard SAA5050 character rounding as a general upscaler: each source line
 *  becomes two, and where two lit pixels meet diagonally the half-dot between
 *  them is filled. See `shaders/saa5050.ts`. */
export const SCALING_MODE_SAA5050 = 6;
