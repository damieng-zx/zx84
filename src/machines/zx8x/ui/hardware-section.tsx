import { createSignal, For, onCleanup, Show } from 'solid-js';
import { currentModel } from '@/state/machine-state.ts';
import { switchModel } from '@/shell/lifecycle.ts';
import { setStatus } from '@/shell/context.ts';
import { applyDisplaySettings } from '@/shell/settings.ts';
import * as settings from '@/store/settings.ts';
import { activeZx8x } from './active.ts';
import { PRINTER_DOTS } from '../zx-printer.ts';

type HrgMode = 'udg' | 'udg128' | 'wrx' | 'memotech' | 'quicksilva';

const HRG_OPTIONS: readonly { mode: HrgMode; label: string; title: string }[] = [
  { mode: 'udg', label: 'UDG RAM ($3000)', title: '64-character user-defined graphics RAM mapped at $3000' },
  { mode: 'udg128', label: 'UDG-128 ($3000)', title: '128-character UDG board using the CHR$ 128 scheme at $3000' },
  { mode: 'wrx', label: 'WRX hi-res', title: 'WRX and HRG-ms refresh-readable bitmap RAM at $2000-$3FFF' },
  { mode: 'memotech', label: 'Memotech HRG', title: 'Memotech 248x192 high-resolution graphics board' },
  { mode: 'quicksilva', label: 'QuickSilva HRG', title: 'QuickSilva 256x192 high-resolution graphics board' },
];

const enabled = (mode: HrgMode): boolean => ({
  udg: settings.zx81UdgRam,
  udg128: settings.zx81Udg128Ram,
  wrx: settings.zx81WrxHires,
  memotech: settings.zx81MemotechHrg,
  quicksilva: settings.zx81QuickSilvaHrg,
})[mode]();

function setHrg(mode: HrgMode, value: boolean): void {
  const options = {
    udg: [settings.setZx81UdgRam, 'zx81-udg-ram'],
    udg128: [settings.setZx81Udg128Ram, 'zx81-udg128-ram'],
    wrx: [settings.setZx81WrxHires, 'zx81-wrx-hires'],
    memotech: [settings.setZx81MemotechHrg, 'zx81-memotech-hrg'],
    quicksilva: [settings.setZx81QuickSilvaHrg, 'zx81-quicksilva-hrg'],
  } as const;
  for (const candidate of HRG_OPTIONS) {
    const [set, key] = options[candidate.mode];
    const selected = value && candidate.mode === mode;
    set(selected);
    settings.persistSetting(key, selected ? 'on' : 'off');
  }
  void switchModel(currentModel());
}

/** An add-on that changes the machine's hardware: fitting it rebuilds. */
interface AddOn {
  key: string;
  label: string;
  title: string;
  get: () => boolean;
  set: (v: boolean) => void;
  zx81Only: boolean;
  /** Only the mixer changes: no rebuild, just re-read the settings. */
  soundOnly?: boolean;
}

const ADD_ONS: readonly AddOn[] = [
  { key: 'zx8x-zonx', label: 'ZON X-81 sound', title: 'Bi-Pak ZON X-81: an AY-3-8912 on ports $CF (register) and $0F (data)', get: settings.zx8xZonx, set: settings.setZx8xZonx, zx81Only: false },
  { key: 'zx8x-vsync-sound', label: 'VSYNC sound', title: 'Mix the vertical sync / MIC line into the sound: the buzz a TV picks up, and what SAVE sounds like', get: settings.zx8xVsyncSound, set: settings.setZx8xVsyncSound, zx81Only: false, soundOnly: true },
  { key: 'zx81-zx-printer', label: 'ZX Printer', title: 'Sinclair ZX Printer on port $FB: LPRINT, LLIST and COPY', get: settings.zx81ZxPrinter, set: settings.setZx81ZxPrinter, zx81Only: true },
  { key: 'zx81-chroma81', label: 'Chroma 81 colour', title: 'Chroma 81: colour control on port $7FEF, 16K of colour RAM at $C000-$FFFF', get: settings.zx81Chroma81, set: settings.setZx81Chroma81, zx81Only: true },
];

function setAddOn(addOn: AddOn, value: boolean): void {
  addOn.set(value);
  settings.persistSetting(addOn.key, value ? 'on' : 'off');
  if (addOn.soundOnly) applyDisplaySettings();
  else void switchModel(currentModel());
}

/** Aluminised paper and burnt dots, as RGBA. */
const PAPER = [0xd8, 0xd8, 0xd4, 0xff];
const INK = [0x20, 0x20, 0x28, 0xff];
const PREVIEW_ROWS = 96;

/** Draw `rows` printer rows (32 bytes each) starting at row `first`. */
function drawPaper(canvas: HTMLCanvasElement, paper: Uint8Array, first: number, rows: number): void {
  const height = Math.max(1, rows);
  canvas.width = PRINTER_DOTS;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(PRINTER_DOTS, height);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < PRINTER_DOTS; x++) {
      const burnt = (paper[(first + y) * 32 + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
      image.data.set(burnt ? INK : PAPER, (y * PRINTER_DOTS + x) * 4);
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** The ZX Printer's output: a live preview of the end of the roll, which can
 *  be saved as a PNG or torn off. */
function Printout() {
  const [rows, setRows] = createSignal(0);
  let preview!: HTMLCanvasElement;
  let seen = -1;
  const refresh = (): void => {
    const printer = activeZx8x()?.printer;
    if (!printer || printer.version === seen) return;
    seen = printer.version;
    const count = printer.rowCount;
    setRows(count);
    const shown = Math.min(count, PREVIEW_ROWS);
    if (preview) drawPaper(preview, printer.paperRows(), count - shown, shown);
  };
  const timer = setInterval(refresh, 250);
  onCleanup(() => clearInterval(timer));

  const save = (): void => {
    const printer = activeZx8x()?.printer;
    if (!printer || printer.rowCount === 0) { setStatus('Nothing has been printed yet'); return; }
    const canvas = document.createElement('canvas');
    drawPaper(canvas, printer.paperRows(), 0, printer.rowCount);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'zx-printer.png';
      a.click();
      URL.revokeObjectURL(url);
      setStatus('Saved zx-printer.png');
    });
  };

  return (
    <div class="zx-printout">
      <canvas
        ref={preview}
        width={PRINTER_DOTS}
        height={1}
        style={{ width: '100%', 'image-rendering': 'pixelated', display: rows() ? 'block' : 'none' }}
      />
      <div class="multiface-row">
        <span style={{ 'font-size': '0.75rem', flex: '1 1 auto' }}>{rows() ? `${rows()} pixel rows printed` : 'No printout yet'}</span>
        <button class="btn btn-sm" style={{ width: 'auto' }} disabled={!rows()} onClick={save}>Save PNG</button>
        <button class="btn btn-sm" style={{ width: 'auto' }} disabled={!rows()} onClick={() => { activeZx8x()?.printer.clearPaper(); refresh(); }}>Tear off</button>
      </div>
    </div>
  );
}

export function Zx8xHardwareSection() {
  return (
    <>
      <div class="multiface-row">
        <label class="mf-check" title="Use 16KB RAM">
          <input
            type="checkbox"
            checked={settings.zx8x16kRam()}
            onChange={(event) => {
              const value = (event.target as HTMLInputElement).checked;
              settings.setZx8x16kRam(value);
              settings.persistSetting('zx8x-16k-ram', value ? 'on' : 'off');
              void switchModel(currentModel());
            }}
          />
          16KB RAM
        </label>
      </div>
      <Show when={currentModel() === 'zx81'}>
        <For each={HRG_OPTIONS}>{option => (
          <div class="multiface-row">
            <label class="mf-check" title={option.title}>
              <input
                type="checkbox"
                checked={enabled(option.mode)}
                onChange={event => setHrg(option.mode, event.currentTarget.checked)}
              />
              {option.label}
            </label>
          </div>
        )}</For>
      </Show>
      <For each={ADD_ONS}>{addOn => (
        <Show when={!addOn.zx81Only || currentModel() === 'zx81'}>
          <div class="multiface-row">
            <label class="mf-check" title={addOn.title}>
              <input
                type="checkbox"
                checked={addOn.get()}
                onChange={event => setAddOn(addOn, event.currentTarget.checked)}
              />
              {addOn.label}
            </label>
          </div>
        </Show>
      )}</For>
      <Show when={currentModel() === 'zx81' && settings.zx81ZxPrinter()}>
        <Printout />
      </Show>
    </>
  );
}
