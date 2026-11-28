/**
 * CPC TapeService — cassette transport over the shared pulse-level `TapeDeck`.
 *
 * The transport is the shared `DeckTapeService`. Unlike the Spectrum there is no
 * loader-detector interplay: the CPC gates tape advance on the firmware's Port-B
 * read cadence (see CpcMachine.advanceTapeTo), so a user stop/pause is a plain
 * deck operation.
 */

import { DeckTapeService } from '@/machines/shared/deck-tape-service.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { cpcSaveToCdt } from '@/machines/cpc/cpc-tape-save.ts';

export function cpcTapeService(c: CpcMachine): DeckTapeService {
  return new DeckTapeService({
    deck: c.tape,
    parseTap: (data) => c.tape.parseTAP(data),
    save: cpcSaveToCdt,
    recordedPulses: () => c.tapeRecorder.pulses(c.cpu.tStates),
  });
}
