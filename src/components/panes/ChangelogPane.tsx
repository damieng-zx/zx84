import { createSignal, Show } from 'solid-js';

const CHANGELOG: { version: string; items: string[] }[] = [
  {
    version: '0.3.0',
    items: [
      'Tape auto-stops almost instantly when a loader gives up — was ~500ms, now a few hundred microseconds',
      'Tape pane shows which loader is actively reading (e.g. "ROM loader")',
      'TAP/TZX pilot-tone selection fixed so flag-byte loaders now load correctly',
      'TZX nested-loop blocks now expand properly',
      'Step-over correctly runs LDIR/LDDR/CPIR/CPDR and all block-repeat instructions to completion (was single-stepping one iteration)',
      'Step-over and step-out no longer hang when the stack pointer wraps around 0xFFFF',
      'Disassembly view always shows the current PC instruction',
      'Gamepad buttons no longer stick when switching windows while a direction is held',
      'Cancelling gamepad configuration no longer corrupts bindings for the next session',
      'Configuring P2\'s gamepad with one controller connected no longer accidentally remaps P1',
      'Caps Shift no longer leaks into keyboard state when using cursor-joystick mode',
      'Beeper audio glitch fixed — snapshot restore and frame-step no longer produce wrong-duty bursts',
      '+3 floppy drive sounds no longer overlap or cut off early',
      'Simon Owen v5 multi-copy weak-sector disk images now load correctly',
      'SNA saves now correctly record the active 128K RAM bank',
      '.z80 snapshot encoding fixed to match the World of Spectrum spec',
      'SZX 128K detection fixed for Timex and NTSC machine IDs',
      'Falls back to Canvas renderer when WebGL is unavailable',
      'VTX-5000 Prestel modem correctly preserves upper ROM half when its overlay is active',
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
  }, {
    version: '0.2.2',
    items: [
      '128K/+3 memory bank paging fixed',
      'Memory viewer pane added',
      'Drive pane UX improvements including LED',
      'CPC disk format detection fix',
      '+3 B: force-presence when empty option',
      '+3 FORMAT command support',
      'Keyboard shift/ctrl keys stuck/failing fixed',
      '48K timings fixed for Shock, Bifrost and Nirvana+'
    ],
  },
  {
    version: '0.2.1',
    items: [
      'Fractional scaling prevention',
      'Scanline accuracy option',
      'HQx and XBR upscalers added',
      'Keyboard mapping improvements',
      'Hardware Pane reworked',
      'Noise display pattern for that retro vibe',
      'Reset per pane option'
    ]
  },
  {
    version: '0.2.0',
    items: [
      'Multiface 1 / 128 / 3 support',
      'Border effects improved',
      'ULA contention accuracy improvements',
      'SZX saving implemented/fixed',
      'Frame stepping in debugger added',
      'Text overlay with native fonts rewritten',
      'Tape auto-start/pause improvements',
      'Per-drive menus with New disk, save',
      '3.5" drive sounds & write-protect',
    ],
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
