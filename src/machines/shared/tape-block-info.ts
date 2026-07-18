/**
 * Shared TapeBlock → TapeBlockInfo mapping for the pulse-level TapeDeck machines
 * (CPC / Einstein). The Spectrum keeps its own copy in its services folder; this
 * is the identical logic factored out for the machines that came later, so the
 * tape pane sees the same one-line labels regardless of which deck backs them.
 */

import type { TapeBlockInfo } from '@/machines/machine.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';

/** One-line pane label for a tape block (data blocks show flag + length). */
export function tapeBlockInfo(b: TapeBlock, index: number): TapeBlockInfo {
  let label: string;
  switch (b.kind) {
    case 'data':
      label = `${b.flag === 0x00 ? 'Header' : 'Data'} (${b.data.length} bytes)`;
      break;
    case 'group-start': label = b.name; break;
    case 'text': label = b.text; break;
    case 'pause': label = `Pause ${b.duration}ms`; break;
    default: label = b.kind; break;
  }
  return { index, label, kind: b.kind === 'data' ? b.source : b.kind };
}
