import { createSignal } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { HiOutlineArrowDownTray, HiOutlineXMark } from 'solid-icons/hi';
import { fontName, setFontName, persistSetting, resetSettingsGroup } from '@/store/settings.ts';
import { machine, setStatus } from '@/shell/context.ts';
import { loadFontStore, saveFontStore, type FontEntry } from '@/shell/lifecycle.ts';
import { openFile } from '@/ui/file-picker.ts';
import { machineUi } from '@/ui/machine-ui.ts';

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToB64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary);
}

function renderFontToCanvas(cvs: HTMLCanvasElement, fontData: Uint8Array): void {
  const cols = 32, rows = 3;
  const w = cols * 8; const h = rows * 8;
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let c = 0; c < 96; c++) {
    const col = c % cols; const row = (c / cols) | 0;
    const off = c * 8;
    for (let py = 0; py < 8; py++) {
      const byte = fontData[off + py];
      for (let px = 0; px < 8; px++) {
        if (byte & (0x80 >> px)) {
          const idx = ((row * 8 + py) * w + col * 8 + px) * 4;
          d[idx] = 0; d[idx + 1] = 0; d[idx + 2] = 0; d[idx + 3] = 0xFF;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

function saveCh8(entry: FontEntry): void {
  const data = b64ToBytes(entry.data);
  const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = `${entry.label.replace(/[^a-zA-Z0-9_-]/g, '_')}.ch8`;
  a.click(); URL.revokeObjectURL(url);
}

export function FontPane() {
  const [rev, setRev] = createSignal(0);

  const entries = () => { void rev(); return loadFontStore(); };

  function bump() { setRev(v => v + 1); }

  async function handleLoadFont() {
    const results = await openFile({
      id: 'zx84-font',
      extensions: ['.ch8', '.bin'],
    });
    if (!results) return;
    const { name, data } = results[0];
    if (data.length !== 768) {
      setStatus(`Font must be 768 bytes (got ${data.length})`);
      return;
    }
    const label = name.replace(/\.[^.]+$/, '');
    const id = `file:${label}:${Date.now()}`;
    const store = loadFontStore();
    store.push({ id, label, address: null, technique: 'file', data: bytesToB64(data) });
    saveFontStore(store);
    setFontName(id); persistSetting('font', id);
    setStatus(`Font "${label}" loaded`);
    bump();
  }

  function removeEntry(id: string) {
    const store = loadFontStore();
    saveFontStore(store.filter(e => e.id !== id));
    if (fontName() === id) { setFontName(''); persistSetting('font', ''); }
    bump();
  }

  async function handleHunt() {
    if (!machine) { setStatus('No emulator running'); return; }
    // Font hunting needs machine-specific memory-layout knowledge (screen
    // bitmap, system variables), so it's a per-machine ui/ contribution —
    // machines that don't provide one simply can't hunt.
    const hunt = machineUi(machine.kind).HuntFonts;
    if (!hunt) { setStatus('Font hunting not available on this machine'); return; }
    hunt();
    bump();
  }

  return (
    <Pane id="font-panel" label="Fonts" onResetSettings={() => { resetSettingsGroup('font'); bump(); }}>
      <div id="font-row">
        <button class="btn btn-md" id="font-add-btn" title="Load font (.ch8, 768 bytes)" onClick={handleLoadFont}>Load</button>
        <button class="btn btn-md" id="font-search-btn" title="Hunt fonts in RAM" onClick={handleHunt}>Hunt</button>
        <button class="btn btn-md" id="font-clear-btn" title="Clear all fonts" onClick={() => {
          saveFontStore([]); setFontName(''); persistSetting('font', ''); bump();
          setStatus('Font list cleared');
        }}>Clear</button>
      </div>
      <div id="font-list">
        {entries().map(entry => (
          <div
            class={`font-entry${fontName() === entry.id ? ' active' : ''}`}
            onClick={() => { setFontName(entry.id); persistSetting('font', entry.id); }}
          >
            <div class="font-entry-header">
              <span class="font-entry-label">{entry.label}</span>
              <span class="font-entry-addr">{entry.address != null ? entry.address : ''}</span>
              <span class="font-entry-actions">
                <button title="Save .ch8" onClick={(e) => { e.stopPropagation(); saveCh8(entry); }}><HiOutlineArrowDownTray /></button>
                <button title="Remove" onClick={(e) => { e.stopPropagation(); removeEntry(entry.id); }}><HiOutlineXMark /></button>
              </span>
            </div>
            <canvas
              class="font-entry-preview"
              ref={(cvs) => { if (cvs) renderFontToCanvas(cvs, b64ToBytes(entry.data)); }}
            />
          </div>
        ))}
      </div>
    </Pane>
  );
}
