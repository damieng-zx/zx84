/**
 * Ace TapeService — cassette transport over the shared pulse-level `TapeDeck`.
 *
 * The transport is the shared `DeckTapeService`; the Ace's own parts are its
 * flag-less `.tap` chunk format, the LOAD/BLOAD "name" tagging the pane lists,
 * its save codec, and the loader-detector interplay: a user-initiated stop or
 * pause must block the LoaderDetector from auto-restarting playback on the
 * post-load keyboard polling (the same contract as the Spectrum's).
 */

import { DeckTapeService } from '@/machines/shared/deck-tape-service.ts';
import type { DataBlock } from '@/media/tape/tap.ts';
import { parseAceTap, parseAceTapeHeader, tagAceTapeFiles } from '../ace-tape.ts';
import { decodeAceSaveToTap } from '../ace-tape-save.ts';
import type { JupiterAceMachine } from '../ace-machine.ts';

/** The Ace's SAVE output, named after the first file on it as the Ace would. */
function aceSave(edges: ArrayLike<number>): { data: Uint8Array; filename: string } | null {
  const data = decodeAceSaveToTap(Array.from(edges));
  if (!data) return null;
  const blocks = parseAceTap(data);
  const header = blocks.find(b => b.kind === 'data' && (b as DataBlock).flag === 0x00) as DataBlock | undefined;
  const name = header ? parseAceTapeHeader(header.data)?.name ?? '' : '';
  return { data, filename: `${name || 'jupiter-ace'}.tap` };
}

export function aceTapeService(m: JupiterAceMachine): DeckTapeService {
  return new DeckTapeService({
    deck: m.tape,
    // Ace .tap chunks are flag-less (the block type is the chunk length), so
    // they go through the Ace parser, not the Spectrum's parseTAP.
    parseTap: parseAceTap,
    tagBlocks: tagAceTapeFiles,
    save: aceSave,
    recordedPulses: () => m.tapeRecorder.edges,
    loaderOverride: {
      get userOverride() { return m.loaderDetector.userOverride; },
      set userOverride(v: boolean) { m.loaderDetector.userOverride = v; },
      // The Ace's loader detector has no advance rebasing to do.
      resetAdvance: () => {},
    },
  });
}
