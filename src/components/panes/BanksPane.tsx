import { Pane } from '@/components/Pane.tsx';
import { RawHtml } from '@/components/RawHtml.tsx';
import { banksHtml, currentModel } from '@/emulator.ts';
import { is128kClass } from '@/machines/spectrum/spectrum.ts';
import { isCpcModel } from '@/models.ts';

export function BanksPane() {
  // 48K Spectrum has no banking; 128K-class and the CPC (paged ROM-over-RAM) do.
  const visible = () => is128kClass(currentModel()) || isCpcModel(currentModel());
  return (
    <Pane id="banks-panel" label="Memory Layout" mono visible={visible()}>
      <RawHtml id="banks-output" html={banksHtml} />
    </Pane>
  );
}
