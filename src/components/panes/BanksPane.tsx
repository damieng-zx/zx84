import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { banksHtml } from '@/emulator.ts';
import { machineCaps } from '@/state/machine-caps.ts';

export function BanksPane() {
  // Shown for machines with paged memory (128K-class Spectrum, CPC paged
  // ROM-over-RAM); the flat 16K/48K models and the VDP machines have none.
  return (
    <Pane id="banks-panel" label="Memory Layout" mono visible={machineCaps().memoryLayout}>
      <RawHtml id="banks-output" html={banksHtml} />
    </Pane>
  );
}
