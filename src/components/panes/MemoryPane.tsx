/**
 * Memory inspector pane.
 *
 * Shows the contents of any region of the active machine's memory: the live
 * 64KB mapped address space, individual ROM images, or individual RAM banks.
 * Works for both the Spectrum and the Amstrad CPC (their memory exposes the
 * shared IMachineMemory surface; only the ROM regions and ASCII glyph table
 * differ per machine).
 *
 * Three display modes: Hex, Hex+ASCII, and ASCII.  ASCII mode maps the
 * machine's character set to Unicode — the Spectrum's (£, ©, ↑, ←, block
 * graphics, UDGs) or the CPC's (plain ASCII for its printable range).
 *
 * Uses virtual scrolling so that even the full 64KB view (4096 × 15px rows)
 * remains fast to render and update.
 */

import { createSignal, createEffect, For, Show, onMount, onCleanup } from 'solid-js';
import { Pane } from '@/components/Pane.tsx';
import { machine, currentModel, emulationPaused } from '@/emulator.ts';
import { machineCaps } from '@/state/machine-caps.ts';
import { isCollapsed } from '@/ui/panes.ts';

// ── Virtual-scroll geometry ──────────────────────────────────────────────

/** Must match CSS .mem-scroll pre { line-height } exactly. */
const ROW_H = 15;

/** Rows rendered above and below the visible window (virtual scroll buffer). */
const BUFFER_ROWS = 48;

// ── Bytes per row per mode ──────────────────────────────────────────────
//
// 8 bytes/row for hex modes fits within the 272px sidebar without horizontal
// scrolling (40 chars × ~6.2px/char ≈ 248px < 256px usable content width).
// 32 bytes/row for ASCII-only fits too (38 chars).

const BYTES_HEX   = 8;
const BYTES_ASCII = 32;

// ── ZX Spectrum → Unicode character table ───────────────────────────────
//
// The ZX Spectrum character set differs from ASCII in several places.
// Byte values 0x80–0x8F are block-graphics characters that map nicely to
// Unicode box-drawing code points.  UDG (0x90–0xA4) and BASIC keyword
// tokens (0xA5–0xFF) cannot be mapped and are shown as placeholder glyphs.

const SPECTRUM_CHARS: string[] = (() => {
  const t = new Array<string>(256);

  // Control codes (0x00–0x1F): non-printable
  for (let i = 0x00; i <= 0x1F; i++) t[i] = '·';

  // Standard printable range — mostly identical to ASCII
  for (let i = 0x20; i <= 0x5D; i++) t[i] = String.fromCharCode(i);

  // Spectrum overrides above 0x5D
  t[0x5E] = '↑';   // ZX: up-arrow     (ASCII: ^)
  t[0x5F] = '←';   // ZX: left-arrow   (ASCII: _)
  t[0x60] = '£';   // ZX: pound sign   (ASCII: `)

  // a–z and {|}~ are the same as ASCII
  for (let i = 0x61; i <= 0x7E; i++) t[i] = String.fromCharCode(i);

  t[0x7F] = '©';   // ZX: copyright    (ASCII: DEL)

  // Block graphics (0x80–0x8F): 4-quadrant pixel combinations
  const blocks = ' ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█';
  for (let i = 0; i < 16; i++) t[0x80 + i] = blocks[i];

  // UDG A–U (0x90–0xA4): user-defined, content unknown → placeholder
  for (let i = 0x90; i <= 0xA4; i++) t[i] = '▫';

  // BASIC keyword tokens (0xA5–0xFF): not displayable
  for (let i = 0xA5; i <= 0xFF; i++) t[i] = '·';

  return t;
})();

// ── Amstrad CPC → Unicode character table ────────────────────────────────
//
// The CPC's printable range (0x20–0x7E) is plain ASCII. Control codes and the
// high range (0x80–0xFF, the CPC's own graphic/special glyphs) aren't mapped
// and show as a placeholder — enough for inspecting strings in a hex dump.

const CPC_CHARS: string[] = (() => {
  const t = new Array<string>(256).fill('·');
  for (let i = 0x20; i <= 0x7E; i++) t[i] = String.fromCharCode(i);
  return t;
})();

// ── Hex formatting helpers ───────────────────────────────────────────────

const HEX = '0123456789ABCDEF';
const h2 = (n: number): string => HEX[(n >> 4) & 0xF] + HEX[n & 0xF];
const h4 = (n: number): string => h2((n >> 8) & 0xFF) + h2(n & 0xFF);

// ── Settings persistence ─────────────────────────────────────────────────

const REGION_KEY = 'zx84-mem-region';
const MODE_KEY   = 'zx84-mem-mode';

type DisplayMode = 'hex' | 'hex+ascii' | 'ascii';

function loadSetting(key: string, def: string): string {
  try { return localStorage.getItem(key) ?? def; } catch { return def; }
}
function saveSetting(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch { /* */ }
}

// ── Row renderer ─────────────────────────────────────────────────────────

/**
 * Render a contiguous block of rows as a plain-text string.
 *
 * For hex modes the format is (8 bytes/row, gap after byte 3):
 *   0000: 00 01 02 03  04 05 06 07  ········
 *
 * For ascii mode the format is (32 bytes/row):
 *   0000: ................................
 */
function renderRows(
  data: Uint8Array,
  baseAddr: number,
  firstRow: number,
  rowCount: number,
  mode: DisplayMode,
  bpr: number,
  chars: string[],
): string {
  const mid = bpr <= 16 ? (bpr >> 1) : -1; // gap after half-way byte, if any
  const parts: string[] = [];

  for (let r = 0; r < rowCount; r++) {
    const off = (firstRow + r) * bpr;
    if (off >= data.length) break;

    let line = h4(baseAddr + off) + ': ';

    if (mode === 'ascii') {
      for (let b = 0; b < bpr; b++) {
        const o = off + b;
        line += o < data.length ? chars[data[o]] : ' ';
      }
    } else {
      // Hex columns
      for (let b = 0; b < bpr; b++) {
        const o = off + b;
        line += o < data.length ? h2(data[o]) : '  ';
        line += (mid > 0 && b === mid - 1) ? '  ' : ' '; // double space at mid
      }
      // Optional ASCII column
      if (mode === 'hex+ascii') {
        line += ' ';
        for (let b = 0; b < bpr; b++) {
          const o = off + b;
          line += o < data.length ? chars[data[o]] : ' ';
        }
      }
    }

    parts.push(line);
  }
  return parts.join('\n');
}

// ── Component ────────────────────────────────────────────────────────────

export function MemoryPane() {
  const [region,   setRegion]   = createSignal(loadSetting(REGION_KEY, 'mapped'));
  const [mode,     setMode]     = createSignal<DisplayMode>(
    loadSetting(MODE_KEY, 'hex+ascii') as DisplayMode,
  );
  const [addrText, setAddrText] = createSignal('0000');
  const [goOpen,   setGoOpen]   = createSignal(false);

  let scrollEl!: HTMLDivElement;
  let innerEl!:  HTMLDivElement;
  let preEl!:    HTMLPreElement;
  let goInputEl!: HTMLInputElement;

  /** ASCII glyph table for the active machine. */
  const chars = (): string[] => machineCaps().charset === 'cpc' ? CPC_CHARS : SPECTRUM_CHARS;

  function bpr(): number { return mode() === 'ascii' ? BYTES_ASCII : BYTES_HEX; }

  /** Whether a saved region key is valid for the active machine. */
  function regionValid(r: string): boolean {
    if (r === 'mapped' || r.startsWith('bank')) return true;
    return machineCaps().memoryRegions.some(x => x.value === r);
  }

  /** Resolve the currently selected region to a data buffer and base address. */
  function source(): { data: Uint8Array; baseAddr: number } | null {
    const m = machine;
    if (!m) return null;
    const mem = m.memory;
    const r   = region();

    if (r === 'mapped') return { data: mem.readBlock(0, 0x10000), baseAddr: 0 };

    if (r.startsWith('bank')) {
      const bank = parseInt(r.slice(4), 10);
      return { data: mem.getRamBank(bank), baseAddr: 0 };
    }

    // ── ROM regions (machine-specific, resolved by the active machine) ──
    return m.resolveMemoryRegion?.(r) ?? null;
  }

  /** True if the user has an active text selection inside the hex dump. */
  function hasActiveSelection(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    return preEl.contains(sel.anchorNode) || preEl.contains(sel.focusNode);
  }

  /** Rebuild the visible portion of the hex dump. */
  function updateView(force = false): void {
    if (!scrollEl || !innerEl || !preEl) return;

    // Periodic refresh while paused for debugging is pure busywork — the
    // memory cannot have changed, so skip before doing any further work.
    if (!force && emulationPaused()) return;

    // Don't blow away an active selection on the periodic refresh — rewriting
    // textContent collapses any range inside the <pre>. Scroll/region/mode
    // changes pass force=true so they still take effect.
    if (!force && hasActiveSelection()) return;

    const s = source();
    if (!s) {
      innerEl.style.height = '0px';
      preEl.style.top      = '0px';
      if (preEl.textContent !== '(unavailable)') preEl.textContent = '(unavailable)';
      return;
    }

    const { data, baseAddr } = s;
    const bytesPerRow  = bpr();
    const totalRows    = Math.ceil(data.length / bytesPerRow);
    const heightPx     = `${totalRows * ROW_H}px`;
    if (innerEl.style.height !== heightPx) innerEl.style.height = heightPx;

    const scrollTop    = scrollEl.scrollTop;
    const clientH      = Math.max(scrollEl.clientHeight, 240);
    const firstVisible = Math.floor(scrollTop / ROW_H);
    const visibleCount = Math.ceil(clientH / ROW_H);
    const startRow     = Math.max(0, firstVisible - BUFFER_ROWS);
    const endRow       = Math.min(totalRows, firstVisible + visibleCount + BUFFER_ROWS);

    const topPx = `${startRow * ROW_H}px`;
    if (preEl.style.top !== topPx) preEl.style.top = topPx;
    const next = renderRows(data, baseAddr, startRow, endRow - startRow, mode(), bytesPerRow, chars());
    if (preEl.textContent !== next) preEl.textContent = next;
  }

  function scrollToAddr(hexStr: string): void {
    const addr = parseInt(hexStr.trim(), 16);
    if (isNaN(addr)) return;
    const s = source();
    const maxAddr = s ? s.data.length - 1 : 0xFFFF;
    const clamped = Math.max(0, Math.min(addr, maxAddr));
    scrollEl.scrollTop = Math.floor(clamped / bpr()) * ROW_H;
    setAddrText(h4(clamped));
    setGoOpen(false);
    updateView(true);
  }

  function onScroll(): void {
    const firstRow = Math.floor(scrollEl.scrollTop / ROW_H);
    const s = source();
    if (s) setAddrText(h4(Math.min(firstRow * bpr() + s.baseAddr, 0xFFFF)));
    updateView(true);
  }

  function changeRegion(r: string): void {
    setRegion(r);
    saveSetting(REGION_KEY, r);
    if (scrollEl) scrollEl.scrollTop = 0;
    setAddrText('0000');
    updateView(true);
  }

  function changeMode(m: DisplayMode): void {
    setMode(m);
    saveSetting(MODE_KEY, m);
    updateView(true);
  }

  function toggleGo(): void {
    const opening = !goOpen();
    setGoOpen(opening);
    if (opening) {
      // Pre-fill with current address and focus, deferring until the DOM node exists.
      setTimeout(() => {
        if (goInputEl) { goInputEl.select(); goInputEl.focus(); }
      }, 0);
    }
  }

  // If the machine changes (e.g. Spectrum ⇄ CPC) and the persisted region no
  // longer exists on the new machine, fall back to the always-valid mapped view.
  createEffect(() => {
    currentModel();
    if (!regionValid(region())) changeRegion('mapped');
  });

  onMount(() => {
    updateView();
    const id = setInterval(() => {
      if (!isCollapsed('memory-panel')) updateView();
    }, 500) as unknown as number;
    onCleanup(() => clearInterval(id));
  });

  const banks = [0, 1, 2, 3, 4, 5, 6, 7];

  return (
    <Pane id="memory-panel" label="Memory" mono>
      <div class="mem-controls">
        <select onChange={e => changeRegion(e.currentTarget.value)}>
          <option value="mapped"   selected={region() === 'mapped'}>Mapped (64K)</option>
          <For each={machineCaps().memoryRegions}>
            {(reg) => <option value={reg.value} selected={region() === reg.value}>{reg.label}</option>}
          </For>
          <For each={banks}>
            {(i) => <option value={`bank${i}`} selected={region() === `bank${i}`}>Bank {i}</option>}
          </For>
        </select>
        <select onChange={e => changeMode(e.currentTarget.value as DisplayMode)}>
          <option value="hex"       selected={mode() === 'hex'}      >Hex</option>
          <option value="hex+ascii" selected={mode() === 'hex+ascii'}>Hex+ASCII</option>
          <option value="ascii"     selected={mode() === 'ascii'}    >ASCII</option>
        </select>
        <button
          class="btn btn-sm"
          classList={{ active: goOpen() }}
          title="Go to address"
          onClick={toggleGo}
        >→</button>
      </div>
      <Show when={goOpen()}>
        <div class="mem-go-drop">
          <input
            ref={goInputEl}
            type="text"
            class="mem-go-input"
            value={addrText()}
            maxLength={4}
            autocomplete="off"
            spellcheck={false}
            onInput={e => setAddrText(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter')  scrollToAddr(addrText());
              if (e.key === 'Escape') setGoOpen(false);
            }}
          />
          <button class="btn btn-sm mem-go-confirm" onClick={() => scrollToAddr(addrText())}>Go</button>
        </div>
      </Show>
      <div class="mem-scroll" ref={scrollEl} onScroll={onScroll}>
        <div ref={innerEl} style="position:relative;width:100%">
          <pre ref={preEl} style="position:absolute;left:0;top:0;margin:0;padding:0 2px" />
        </div>
      </div>
    </Pane>
  );
}
