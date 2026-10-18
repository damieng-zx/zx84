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
 *
 * While paused, Hex and Hex+ASCII bytes can be overtyped: click a byte, type hex
 * digits (or characters, in the ASCII column), Tab to swap columns. Writes go
 * through the selected region — Mapped writes use the CPU's own write path, a RAM
 * bank is written directly, and ROM regions stay read-only unless the ROM
 * checkbox is ticked.
 */

import { createSignal, createEffect, For, Show, onMount, onCleanup } from 'solid-js';
import { Pane } from '@/ui/components/Pane.tsx';
import { machine } from '@/shell/context.ts';
import { refreshDebugViews } from '@/shell/lifecycle.ts';
import { currentModel, emulationPaused } from '@/state/machine-state.ts';
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
// scrolling: plain hex comes to 31 columns, and hex+ASCII to 32 with its pairs
// packed. Spacing those pairs takes it to 40, which overruns the sidebar and
// clipped the end of the ASCII column. 32 bytes/row for ASCII-only fits too
// (38 chars).

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

// ── BBC Micro → Unicode character table ──────────────────────────────────
//
// The BBC's printable range is ASCII; only the backtick slot differs (the MOS
// defines CHR$(96) as the pound sign).

const BBC_CHARS: string[] = (() => {
  const t = new Array<string>(256).fill('·');
  for (let i = 0x20; i <= 0x7E; i++) t[i] = String.fromCharCode(i);
  t[0x60] = '£';
  return t;
})();

// ── Apple II → Unicode character table ───────────────────────────────────
//
// The Apple II character order runs '@A-Z[\]^_' for codes $00-$1F and ASCII
// space…'?' for $20-$3F; bits 6 and 7 are the flash and inverse-video flags,
// so every byte displays the glyph its low six bits name.

const APPLE2_CHARS: string[] = (() => {
  const t = new Array<string>(256).fill('·');
  for (let b = 0; b <= 0xFF; b++) {
    const g = b & 0x3F;
    t[b] = g < 0x20 ? String.fromCharCode(g + 0x40) : String.fromCharCode(g);
  }
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
 * Plain hex spaces the pairs out, with a wider gap at the half-way byte:
 *   0000: 00 01 02 03  04 05 06 07
 *
 * Hex+ASCII packs them instead. Spaced pairs plus eight ASCII characters come
 * to 40 columns, four more than the sidebar shows, so the last bytes of the
 * ASCII column fell off the end; packed, the row is 32 and the whole of it
 * fits:
 *   0000: 0001020304050607  ········
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
      // Hex columns, packed tight when an ASCII column has to fit beside them.
      const packed = mode === 'hex+ascii';
      for (let b = 0; b < bpr; b++) {
        const o = off + b;
        line += o < data.length ? h2(data[o]) : '  ';
        if (!packed) line += (mid > 0 && b === mid - 1) ? '  ' : ' '; // gap at mid
      }
      if (packed) {
        line += '  ';
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

// ── Edit-cursor geometry ─────────────────────────────────────────────────
//
// Mirrors renderRows(): where, in characters from the start of a row, a byte's
// hex pair or ASCII glyph sits. The cursor overlay and click hit-testing both
// work from these, so they must change together with renderRows.

/** Characters taken by the "AAAA: " address prefix. */
const ADDR_COLS = 6;

type EditColumn = 'hex' | 'ascii';

/** Character column of byte `b`'s hex pair within a row. */
function hexCol(mode: DisplayMode, b: number, bpr: number): number {
  if (mode === 'hex+ascii') return ADDR_COLS + b * 2;
  const mid = bpr <= 16 ? (bpr >> 1) : -1;
  return ADDR_COLS + b * 3 + (mid > 0 && b >= mid ? 1 : 0);
}

/** Character column of byte `b`'s ASCII glyph within a Hex+ASCII row. */
function asciiCol(b: number, bpr: number): number {
  return ADDR_COLS + bpr * 2 + 2 + b;
}

/** Which byte and column a character column of a row falls on, if any. */
function hitTest(mode: DisplayMode, col: number, bpr: number): { b: number; column: EditColumn } | null {
  for (let b = 0; b < bpr; b++) {
    const h = hexCol(mode, b, bpr);
    if (col >= h && col < h + 2) return { b, column: 'hex' };
    if (mode === 'hex+ascii' && col === asciiCol(b, bpr)) return { b, column: 'ascii' };
  }
  return null;
}

interface EditPos {
  /** Index into the region's data (not an address). */
  off: number;
  column: EditColumn;
  /** Which hex digit the next keystroke replaces: 0 = high, 1 = low. */
  nibble: 0 | 1;
}

// ── Component ────────────────────────────────────────────────────────────

export function MemoryPane() {
  const [region,   setRegion]   = createSignal(loadSetting(REGION_KEY, 'mapped'));
  const [mode,     setMode]     = createSignal<DisplayMode>(
    loadSetting(MODE_KEY, 'hex+ascii') as DisplayMode,
  );
  const [addrText, setAddrText] = createSignal('0000');
  const [goOpen,   setGoOpen]   = createSignal(false);
  const [allowRom, setAllowRom] = createSignal(false);
  const [editPos,  setEditPos]  = createSignal<EditPos | null>(null);

  let scrollEl!: HTMLDivElement;
  let innerEl!:  HTMLDivElement;
  let preEl!:    HTMLPreElement;
  let cursorEl!: HTMLDivElement;
  let goInputEl!: HTMLInputElement;

  /** ASCII glyph table for the active machine. */
  const chars = (): string[] => {
    const charset = machineCaps().charset;
    if (charset === 'cpc') return CPC_CHARS;
    if (charset === 'bbc') return BBC_CHARS;
    if (charset === 'apple2') return APPLE2_CHARS;
    return SPECTRUM_CHARS;
  };

  function bpr(): number { return mode() === 'ascii' ? BYTES_ASCII : BYTES_HEX; }

  const isBank = (r: string): boolean => r.startsWith('bank');
  const isRomRegion = (): boolean => region() !== 'mapped' && !isBank(region());

  /** The RAM bank number the region names, or null when it is not a bank this
   *  machine has (the picker always lists 8; getRamBank coerces the rest). */
  function ramBank(): number | null {
    const r = region();
    if (!isBank(r) || !machine) return null;
    const n = parseInt(r.slice(4), 10);
    return n < machine.memory.ramBankCount ? n : null;
  }

  /** Whether bytes can be overtyped right now: paused (a write would race the
   *  frame loop), a hex mode, and a region that accepts writes. */
  const editable = (): boolean => {
    if (!emulationPaused() || mode() === 'ascii') return false;
    const r = region();
    if (r === 'mapped') return true;
    if (isBank(r)) return ramBank() !== null;
    return allowRom();
  };

  /** Mapped writes can land on a device register on memory-mapped machines. */
  const mappedHasSideEffects = (): boolean =>
    region() === 'mapped' && machineCaps().memoryMappedIo === true;

  /**
   * Write one byte of the selected region and redraw what depends on it.
   * Mapped goes through the CPU's mapping (ROM there ignores it, as for the CPU);
   * a bank or ROM region is written in place, like MCP's `write_memory`.
   */
  function poke(off: number, val: number): boolean {
    const m = machine;
    if (!m || !editable()) return false;
    const r = region();
    if (r === 'mapped') {
      m.memory.writeByte(off & 0xFFFF, val);
    } else if (isBank(r)) {
      const n = ramBank();
      if (n === null) return false;
      m.memory.getRamBank(n)[off] = val;
    } else {
      const s = source();
      if (!s || off >= s.data.length) return false;
      s.data[off] = val;
    }
    refreshDebugViews();
    updateView(true);
    return true;
  }

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

    // ── ROM regions (machine-specific, resolved by the debug provider) ──
    return m.services.debug.resolveMemoryRegion(r);
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

  // ── Edit cursor ──────────────────────────────────────────────────────

  /** Width in px of one monospace character of the dump. */
  let charW = 0;
  function charWidth(): number {
    if (charW > 0) return charW;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    probe.textContent = '0'.repeat(64);
    preEl.appendChild(probe);
    charW = probe.getBoundingClientRect().width / 64;
    probe.remove();
    return charW;
  }

  /** Position the overlay on the byte being edited (or hide it). */
  function placeCursor(): void {
    if (!cursorEl) return;
    const pos = editPos();
    if (!pos || !editable()) { cursorEl.style.display = 'none'; return; }
    const perRow = bpr();
    const row = Math.floor(pos.off / perRow);
    const b = pos.off % perRow;
    const w = charWidth();
    const col = pos.column === 'hex' ? hexCol(mode(), b, perRow) : asciiCol(b, perRow);
    const cols = pos.column === 'hex' ? 2 : 1;
    cursorEl.style.display = 'block';
    cursorEl.style.top = `${row * ROW_H}px`;
    cursorEl.style.left = `${2 + col * w}px`;
    cursorEl.style.width = `${cols * w}px`;
  }

  /** Scroll just far enough that the cursor row is on screen. */
  function revealCursor(): void {
    const pos = editPos();
    if (!pos) return;
    const top = Math.floor(pos.off / bpr()) * ROW_H;
    if (top < scrollEl.scrollTop) scrollEl.scrollTop = top;
    else if (top + ROW_H > scrollEl.scrollTop + scrollEl.clientHeight) {
      scrollEl.scrollTop = top + ROW_H - scrollEl.clientHeight;
    }
  }

  function onPaneClick(e: MouseEvent): void {
    if (!editable()) return;
    // A drag-select to copy bytes ends in a click too; leave that selection alone.
    if (hasActiveSelection()) return;
    const s = source();
    if (!s) return;
    const perRow = bpr();
    const top = innerEl.getBoundingClientRect().top;
    const left = preEl.getBoundingClientRect().left + 2;
    const row = Math.floor((e.clientY - top) / ROW_H);
    const col = Math.floor((e.clientX - left) / charWidth());
    const hit = hitTest(mode(), col, perRow);
    if (!hit || row < 0) return;
    const off = row * perRow + hit.b;
    if (off >= s.data.length) return;
    setEditPos({ off, column: hit.column, nibble: 0 });
    scrollEl.focus({ preventScroll: true });
  }

  /** Move the cursor `delta` bytes, staying inside the region. */
  function moveCursor(delta: number): void {
    const pos = editPos();
    const s = source();
    if (!pos || !s) return;
    const off = Math.max(0, Math.min(s.data.length - 1, pos.off + delta));
    setEditPos({ ...pos, off, nibble: 0 });
    revealCursor();
  }

  function onEditKey(e: KeyboardEvent): void {
    const pos = editPos();
    if (!pos || !editable()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const perRow = bpr();
    const s = source();
    if (!s) return;

    switch (e.key) {
      case 'Escape':     setEditPos(null); break;
      case 'ArrowLeft':  moveCursor(-1); break;
      case 'ArrowRight': moveCursor(1); break;
      case 'ArrowUp':    moveCursor(-perRow); break;
      case 'ArrowDown':  moveCursor(perRow); break;
      case 'Backspace':  moveCursor(-1); break;
      case 'Tab':
        if (mode() !== 'hex+ascii') return; // nothing to swap to: let focus move on
        setEditPos({ ...pos, column: pos.column === 'hex' ? 'ascii' : 'hex', nibble: 0 });
        break;
      default: {
        if (e.key.length !== 1) return;
        const old = s.data[pos.off];
        if (pos.column === 'hex') {
          if (!/^[0-9a-f]$/i.test(e.key)) return;
          const d = parseInt(e.key, 16);
          if (pos.nibble === 0) {
            if (poke(pos.off, (d << 4) | (old & 0x0F))) setEditPos({ ...pos, nibble: 1 });
          } else if (poke(pos.off, (old & 0xF0) | d)) {
            moveCursor(1);
          }
        } else {
          // '·' stands for every unprintable byte, so it names none of them.
          const code = e.key === '\u00b7' ? -1 : chars().indexOf(e.key);
          if (code < 0) return;
          if (poke(pos.off, code)) moveCursor(1);
        }
      }
    }
    e.preventDefault();
    e.stopPropagation(); // keep emulator key capture and page shortcuts out of it
  }

  function onScroll(): void {
    const firstRow = Math.floor(scrollEl.scrollTop / ROW_H);
    const s = source();
    if (s) setAddrText(h4(Math.min(firstRow * bpr() + s.baseAddr, 0xFFFF)));
    updateView(true);
  }

  function changeRegion(r: string): void {
    setEditPos(null);
    setRegion(r);
    saveSetting(REGION_KEY, r);
    if (scrollEl) scrollEl.scrollTop = 0;
    setAddrText('0000');
    updateView(true);
  }

  function changeMode(m: DisplayMode): void {
    setEditPos(null);
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

  // Keep the overlay on its byte, and drop it when editing stops being possible
  // (resume, or a region that is no longer writable).
  createEffect(() => {
    if (!editable()) setEditPos(null);
    placeCursor();
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
        <Show when={isRomRegion()}>
          <label class="mem-rom-write" title="Allow edits to this ROM image">
            <input
              type="checkbox"
              checked={allowRom()}
              onChange={e => setAllowRom(e.currentTarget.checked)}
            /> ROM
          </label>
        </Show>
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
      <Show when={mappedHasSideEffects() && emulationPaused()}>
        <div class="mem-note">Mapped writes reach memory-mapped hardware and can have side effects.</div>
      </Show>
      <div
        class="mem-scroll"
        classList={{ 'mem-editable': editable() }}
        ref={scrollEl}
        tabindex={editable() ? 0 : -1}
        onScroll={onScroll}
        onClick={onPaneClick}
        onKeyDown={onEditKey}
      >
        <div ref={innerEl} style="position:relative;width:100%">
          <pre ref={preEl} style="position:absolute;left:0;top:0;margin:0;padding:0 2px" />
          <div ref={cursorEl} class="mem-cursor" />
        </div>
      </div>
    </Pane>
  );
}
