import { Pane } from '@/ui/components/Pane.tsx';
import { SliderRow } from '@/ui/components/Slider.tsx';
import '@/fonts/monospace-fonts.css';
import {
  ocrFont, setOcrFont,
  ocrLineHeight, setOcrLineHeight, ocrTracking, setOcrTracking,
  ocrOffsetX, setOcrOffsetX, ocrOffsetY, setOcrOffsetY,
  ocrScaleX, setOcrScaleX, ocrScaleY, setOcrScaleY,
  persistSetting, resetSettingsGroup,
} from '@/store/settings.ts';

const MONO_FONTS = [
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'IBM Plex Mono',
  'Roboto Mono',
  'Ubuntu Mono',
  'Inconsolata',
  'Space Mono',
  'Courier Prime',
  'Overpass Mono',
  'Anonymous Pro',
  'DM Mono',
  'Noto Sans Mono',
  'Cascadia Code',
  'Victor Mono',
];

export function TextPane() {
  return (
    <Pane id="text-panel" label="Text" onResetSettings={() => resetSettingsGroup('text')}>
      <div class="slider-row">
        <span class="slider-label">Font</span>
        <select
          value={ocrFont()}
          onChange={(e) => {
            setOcrFont(e.currentTarget.value);
            persistSetting('ocr-font', e.currentTarget.value);
          }}
        >
          {MONO_FONTS.map(f => <option value={f}>{f}</option>)}
        </select>
      </div>

      <SliderRow label="Line height" id="ocr-lh" min={80} max={160}
        value={ocrLineHeight} onInput={v => { setOcrLineHeight(v); persistSetting('ocr-line-height', v); }}
        format={v => (v / 100).toFixed(2)}
      />

      <SliderRow label="Tracking" id="ocr-track" min={-20} max={20}
        value={ocrTracking} onInput={v => { setOcrTracking(v); persistSetting('ocr-tracking', v); }}
        format={v => `${(v / 10).toFixed(1)}px`}
      />

      <SliderRow label="Offset X" id="ocr-ox" min={-10} max={20}
        value={ocrOffsetX} onInput={v => { setOcrOffsetX(v); persistSetting('ocr-offset-x', v); }}
        format={v => `${v}px`}
      />

      <SliderRow label="Offset Y" id="ocr-oy" min={-10} max={20}
        value={ocrOffsetY} onInput={v => { setOcrOffsetY(v); persistSetting('ocr-offset-y', v); }}
        format={v => `${v}px`}
      />

      <SliderRow label="Scale X" id="ocr-sx" min={90} max={110} step={0.1}
        value={ocrScaleX} onInput={v => { setOcrScaleX(v); persistSetting('ocr-scale-x', v); }}
        format={v => `${v.toFixed(1)}%`}
      />

      <SliderRow label="Scale Y" id="ocr-sy" min={90} max={110} step={0.1}
        value={ocrScaleY} onInput={v => { setOcrScaleY(v); persistSetting('ocr-scale-y', v); }}
        format={v => `${v.toFixed(1)}%`}
      />
    </Pane>
  );
}
