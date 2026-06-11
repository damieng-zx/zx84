import { createSignal, Show } from 'solid-js';

const CHANGELOG: { version: string; items: string[] }[] = [
  {
    version: '0.6.0',
    items: [
      'Built-in software library',
      'Optimized turbo mode',
      'Improved fast loaders',
      'Removed edge loading (was so broken)',
    ]
  }, {
    version: '0.5.1',
    items: [
      'Fast ROM loading for Amstrad CPC firmware tapes (CAS READ trap)',
      'Pixel-perfect scaling on high-DPI displays',
      'UI polish: an app menu to show/hide developer panes and reset settings or layout, and tidier default panes and border',
      'Fixed 128K timing issues',
    ]
  }, {
    version: '0.5.0',
    items: [
      'Experimental Amstrad CPC support — CPC 6128, 664 and 464',
      'Experimental MGT +D disc support — G+DOS with .mgt/.img discs on drives C: and D:',
      'Improved ZX accelerated ROM tape loading',
    ]
  }, {
    version: '0.4.1',
    items: [
      'Fix 765FDC to report abnormal termination on data CRC errors',
      'Fix 765FDC to keep bad-CRC deleted-data sectors stable instead of randomising them',
      'Fix 765FDC to fail reads of unreadable bad-CRC weak protection sectors (Ocean disc protection)',
      'Fix 765FDC read_track command to just read data',
      'Fix mounted disks and tapes not surviving a page reload',
    ]
  }, {
    version: '0.4.0',
    items: [
      'Drag-and-drop files onto the emulator window to load snapshots, tapes and disks',
      'Edge-loader: faster tape loading with surgical acceleration, fixed auto-stop, split UI toggles',
      'Turbo mode: adaptive frame budget, skips audio and throttles UI for maximum speed',
      'Turbo mode contention skipped and memory hot-path inlined — big Firefox speedup',
      'AY DC blocking filter and stereo mode options added to Sound pane',
      'Audio fixes: NaN/pre-init volume, crashes after destroy, ring-buffer unification',
      'Write-through now correct for aliased RAM bank slots',
      'Port watchpoints now fire for all IN/OUT paths',
      'Tape no longer rewinds or pauses on machine reset',
      'Disable font ligatures',
    ]
  }, {
    version: '0.3.0',
    items: [
      'Tape pauses instantly when a loader gives up (was ~500ms)',
      'Tape pane shows which loader is running',
      'Debugger step-over now runs block-repeat instructions (LDIR etc.) to completion',
      'Gamepad fixes: stuck buttons on window switch, config leak on cancel, P2 wrongly using P1\'s pad',
      'Beeper audio glitch fixed on snapshot restore and frame-step',
      'Various snapshot format fixes (.z80, SNA, SZX) and TAP/TZX loading fixes',
      'Canvas fallback when WebGL is unavailable',
    ]
  }, {
    version: '0.2.11',
    items: [
      'File open dialogs remember their last-used folder independently per file type (snapshot, tape, disk, ROM, font)',
    ]
  }, {
    version: '0.2.10',
    items: [
      'OCR text mode now reads the bank the ULA actually displays — fixes garbled output under +3 all-RAM paging modes (CP/M Plus, custom loaders)',
      'OCR auto-detects the character grid by tile-repetition: 32×24 standard, 51×24 CP/M Plus, 64×24 Tasword 64',
      'Active font is located by heuristic RAM scan when not the ROM font, so non-Spectrum-BASIC screens transcribe too',
      'In-canvas text overlay rescales to whatever grid was detected',
      'MCP `ocr` tool takes an optional `mode` parameter (auto | 32x24 | 51x24 | 64x24) and prefixes the result with the chosen grid',
    ]
  }, {
    version: '0.2.9',
    items: [
      'Memory pane no longer drops your selection on its periodic refresh, and skips updates entirely while paused for debugging',
    ]
  }, {
    version: '0.2.8',
    items: [
      'Held keys no longer get stuck (OS auto-repeat was incrementing reference counts the single keyup could not undo)',
      'Alt-tabbing while a key is held now releases it (window blur resets keyboard and joystick state)',
    ]
  }, {
    version: '0.2.7',
    items: [
      'Flat memory mode for simplified debugging',
      'MCP tooling improvements',
      'FDC bugs fixed: wrong R after EOT, missing ND flag, stale exN on advance',
      'Snapshot bugs fixed: SNA overflow, memory corruption, SP offset, IM mask',
      'MCP disassembler now reads correct memory bank',
      'Disk writing fixes',
    ]
  }, {
    version: '0.2.6',
    items: [
      'Right Shift now maps to Symbol Shift for direct symbol access',
      'Combo keys (DEL, arrows, etc.) stagger modifier by one frame for reliable detection',
    ]
  }, {
    version: '0.2.5',
    items: [
      'VTX5000 modem emulation',
      'Pane drag reordering',
      'ZXTL tracing format',
      'BASIC viewer fix token spaces',
    ]
  }, {
    version: '0.2.4',
    items: [
      '+3 copy protection detection improved',
      '+3 Paul Owens protection bypassed',
      '+3 Hexagon protection bypassed',
      'Drive pane simplification'
    ]
  }, {
    version: '0.2.3',
    items: [
      'ROMs loaded from own domain',
      '+3 v4.1 option added',
      'Turn off minification',
      'CORS improvements for Cloudflare'
    ]
  },
];

const [changelogOpen, setChangelogOpen] = createSignal(false);
export { changelogOpen };

export function toggleChangelog() {
  setChangelogOpen(v => !v);
}

export function ChangelogOverlay() {
  return (
    <Show when={changelogOpen()}>
      <div class="changelog-backdrop" onClick={() => setChangelogOpen(false)} />
      <div class="changelog-overlay">
        {CHANGELOG.map((release) => (
          <div class="changelog-release">
            <div class="changelog-version">v{release.version}</div>
            <ul class="changelog-list">
              {release.items.map((item) => <li>{item}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </Show>
  );
}
