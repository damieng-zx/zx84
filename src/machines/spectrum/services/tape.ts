/**
 * Spectrum TapeService — cassette transport over the shared pulse-level
 * `TapeDeck`.
 *
 * The transport itself is the shared `DeckTapeService`; what is the Spectrum's
 * own is the loader-detector interplay: a user-initiated stop or pause must
 * block the LoaderDetector from auto-restarting playback on the post-load
 * keyboard polling.
 */

import { DeckTapeService } from '@/machines/shared/deck-tape-service.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { spectrumSaveToTzx } from '@/machines/spectrum/tape-save.ts';

export function spectrumTapeService(s: Spectrum): DeckTapeService {
  return new DeckTapeService({
    deck: s.tape,
    parseTap: (data) => s.tape.parseTAP(data),
    save: spectrumSaveToTzx,
    recordedPulses: () => s.micRecorder.pulses(s.cpu.tStates),
    loaderOverride: {
      get userOverride() { return s.loaderDetector.userOverride; },
      set userOverride(v: boolean) { s.loaderDetector.userOverride = v; },
      resetAdvance: () => s.resetTapeAdvance(),
    },
  });
}
