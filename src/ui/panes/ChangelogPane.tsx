import { createSignal, Show } from 'solid-js';

const CHANGELOG: { version: string; items: string[] }[] = [
  {
    version: '0.12.0',
    items: [
      'Add the Commodore VIC-20: PAL and NTSC, expansion RAM, cartridges, the Datasette with .tap files timed in its own cycles, 1541/1571/1581 drives, paddles, TEXT overlay and an on-screen keyboard',
      'Add the Commodore 128: C128 and C64 modes, BASIC 7.0 listing and variables panes, the 80-column VDC display with 80-column OCR, 2 MHz mode, burst-mode fast serial on the 1571 and 1581, banked cartridges and function ROMs, Z80 debugging and tracing, and CP/M 3',
      'Add the Commodore Plus/4 and Commodore 16: a beam-level TED picture, the 1 MHz mode, BASIC 3.5 listing, banked cartridges, Hannes and CSORY 256K RAM expansions, .tap loading timed in Plus/4 cycles, and hires and multicolour screens read as text',
      'Add the Oric-1 and Oric Atmos, each with its own keyboard deck, plate legends and printed font',
      'Add the Acorn Atom and the Acorn System 2, 3 (8271 disc controller), 4 and 5 (6502A), sharing the Acorn ASCII keyboard deck',
      'Add the Timex Sinclair 1000 and 1500, the Timex Computer 2048 and the Timex 2068 (NTSC), with hi-res screens, on-screen keyboards and library titles',
      'Atari: XEGS, Williams, Bounty Bob, SpartaDOS X, Diamond, Express and other banked cartridges',
      'Apple II: 13-sector boot ROM, half tracks and weak bits, and booting the original ][ through the Monitor',
      'The Datasette EAR line plays as loading sound while tapes run on the Commodores',
      'C64: the ATN acknowledge completes and sprite collisions stay out of the border',
      'CPC: typing types each key\'s own UK legend, not the PC keyboard position',
      'BBC Micro: the 6522 counters run from power-up, teletext control codes decode, and the 1770 resets the controller, not the drive heads, on /MR',
      'Einstein: reset strobe, interrupt chain, snapshot and typing fixes',
      'ZX80/ZX81: multi-file zips mount as one tape so loaders find their parts',
      'MCP: basic_listing and basic_vars read the machine\'s own BASIC program and variables, printable symbols type on each machine\'s keyboard, the Electron expansions can be fitted headlessly, and the Spectrum bench loader follows the app snapshot rules',
      'The model menu lists makers alphabetically, drops the maker from second-level entries (Acorn > Atom), and files the Orics under British Obscure',
      'Fixed: four Hardware toggles that never reached their machine (the Plus/4 drive and 256K expansion, the Lynx floppy, the MTX floppy), a latched Shift stuck after the keyboard pane closed, colour markers in the copied Z80 CPU state, the 6821 C2 bits, a RAM dump taken while the machine still ran, and the Oric status lights',
    ]
  }, {
    version: '0.11.0',
    items: [
      'Add Atari 8-bit support: 400, 800, XL and XE, NTSC and PAL',
      'Add Apple I and the Apple II family: ][, ][+, //e, Enhanced //e and //c',
      'Add Acorn Electron with Plus 1 and Plus 3, and UEF cassette support',
      'Add Enterprise 64 and 128',
      'Add Sony HB-55 and HB-55P MSX models, and an optional floppy interface for the Toshiba HX-10',
      'Add Pentagon 128, 512 and 1024 and Scorpion ZS-256, with Beta disk boot from the library',
      'Add Currah µSpeech speech synthesiser and Cheetah SpecDrum',
      'Edit registers and memory in the browser debugger',
      'Monochrome phosphor option for the Monitor pane',
      'Choose how many built-in drives are fitted',
      'High, Mid and Low video accuracy on the BBC Micro and Apple II, so mid-frame mode and palette changes show',
      'A volume slider for each sound device replaces the Beep/PSG balance, and DC blocking is per device',
      'TD0 and raw .dsk disks on the Beta Disk and +D, TD0 on the +3, CPC and Einstein, CSW tapes on the CPC, and WAV tapes on every machine that loads from pulses',
      'Breakpoints and traps stop on every machine, and resuming carries the frame on without disturbing its timing',
      'MCP beam debugging on every machine: beam and interrupt logs, running to a raster position, and Atari chip state',
      'Add Commodore 64 (PAL and NTSC) with the Datasette, 1541, 1571 and 1581 drives, and cartridges',
      'Execution tracing on every machine, not only the Spectrum',
      'Exact save states on every machine, and every machine now resumes where it left off after a browser refresh',
      'Record cassette SAVEs on the Spectrum, CPC, Apple I and II, Lynx, MTX and ZX80/ZX81, and download them as tapes the machine loads back',
      'Analogue joysticks and paddles on the BBC Micro, Electron, Apple II, Einstein, CPC Plus and PCW, and the real add-on joystick interfaces on the PCW',
      'Bit-level Apple II Disk ][ with .woz, .nib, .2mg and 13-sector images, HFE v3 on every machine, HFE and SCP discs on the BBC Micro and Electron, and more Enterprise disk formats',
      'ZX80/ZX81: pulse-level cassette with .tzx and .wav, ZX Printer, Chroma 81 colour and ZON X-81 sound',
      'CPC: selectable CRTC type, 256K and 512K RAM expansions, the DDI-1 on the 464, PPI links and mid-frame .sna resume',
      'PCW: real frame timing, a 60 Hz mode, the full keyboard, single-sided drive limits and printer output',
      'BBC Micro: 1 MHz bus stretching, sideways RAM, printer and RS423 ports, and the Model A',
      'Electron: High, Mid and Low video accuracy, the Plus 1 printer port and UEF security cycles',
      'Apple II: floating bus, double lo-res, 65C02 variants and the mouse as paddles',
      'MSX: Konami SCC sound, pulse-level cassette and more cartridge mappers',
      'Spectrum: Issue 2 and Issue 3 board option and uPD765A SCAN commands; Scorpion even-M1 wait, Turbo+ and Magic button; Pentagon 1024 multicolour',
      'Lynx: sound uses the full 6-bit DAC and BREAK interrupts the CPU',
      'WD1793 READ ADDRESS fixes on the floppy controllers',
      'The niche British machines are grouped under British Obscure in the machine menu',
      'Fixed BBC flashing colours',
      'Spectrum model ids now use a zx prefix (old ids still work)',
      'Peripheral fixes: +D printer port, Beta FDC reset, Multiface 128 hiding, Interface 1 idle ports, Kempston and Cursor joysticks, AMX PIO interrupts',
      'Fixed MCP screenshots to capture the frame as drawn',
      'Fixed frame timing after the debugger stops',
      'Sound chip named in the status bar and mixer; Blip the robot mascot; zx84 on GitHub link in the menu',
    ]
  }, {
    version: '0.9.1',
    items: [
      'Removed SAM Coupe support',
      'Credits & acknowledgements overhaul',
    ]
  }, {
    version: '0.9.0',
    items: [
      'Add BBC Micro Model B support',
      'Choose the startup machine with a ?model= URL parameter',
      'LOAD and SAVE on the ZX80 and ZX81, and cassette save on the MSX',
      'ASCII8, ASCII16 and Konami MSX mega-ROM mappers',
      'Read zip64 archives; encrypted and unknown zip entries are skipped',
      'TZX generalized data and z-rle CSW blocks; unknown TZX blocks skipped',
      'HFE disks on Memotech drives',
      'uPD765A, WD179x and HFE/SCP fixes: formatting, ID matching, seek and write handling',
      'Tape timing fixes: pause edges, block boundaries, 128K clock scaling',
      'Z80 fixes: RETI daisy-chain notification, IM 2 vector, interrupt flags after LD A,I',
      'CPC timing, VSYNC and CRTC fixes; CPC+ state loaded from v3 .SNA',
      'MSX, Einstein, PCW, Lynx and Jupiter Ace hardware fixes',
      'Resume .z80 and .szx snapshots at their saved frame position',
      'SN76489 audio fixes',
    ]
  }, {
    version: '0.8.2',
    items: [
      'Add Camputers Lynx 48K, 96K and 128K support',
      'Add Jupiter Ace support',
      'Add Amstrad PCW 8256/8512/9512/9256 support',
      'Drive sounds for the MTX, CPC and Einstein',
      'Formatting a disk now updates its geometry on the MTX and Einstein',
      'Each machine keeps its own persisted disks',
      'Custom ROM pages restored when the app starts',
      'Fixed machine switches racing asynchronous ROM loads',
      'Audio resumes on a user gesture and buffers enough for the fallback path',
      'Mounting a tape or disk no longer restarts or unpauses the machine',
      'Screen text and the TEXT overlay on the Camputers Lynx and Jupiter Ace',
    ]
  }, {
    version: '0.8.1',
    items: [
      'Added all missing keyboards',
      'Refined existing keyboards',
      'Keyboards can be undocked to float, move and resize freely',
      'Unmapped F-keys to prevent clash with OS/browser',
      'Fixed Mac/Retina keyboard font sizing',
      'Fixed the Einstein 256 display being drawn twice as wide',
    ]
  }, {
    version: '0.8.0',
    items: [
      'Z80 fixes: EI chains, NMI, reset interrupt mode, Q register',
      'AY-3-8912 register read-back and envelope fixes',
      'Anti-aliasing modes for the MTX SN76489',
      'Smoother audio when the buffer runs low',
      'WD179x fixes: READ ADDRESS, multi-sector reads, weak sectors',
      'uPD765A End-of-Cylinder and sector-size fixes',
      'CPC fixes: Mode 3, ASIC unlock, DMA, sprites, .SNA',
      'MSX slot layout and 48KB cartridge mapping fixes',
      'V9938/TMS9918A sprite, palette and interrupt timing fixes',
      'Einstein CTC timer prescaler fix',
      'Spectrum fixes: SAVE audio, paging lock, 48K snapshots',
      'TZX/CSW field layout and fast loader return fixes',
      'Malformed tapes, disks and cartridges rejected instead of hanging',
      'MTX fixes for absent FDX hardware and saved models',
      'Disk loads keep the pause state and resume after a failed save',
      'Mounted disks restored after a page reload',
      'Sound and Mouse panes list only what the machine has',
      'Fixed a WebGL renderer resource leak',
      'MCP file access confined to the cache and workspace',
    ]
  }, {
    version: '0.7.4',
    items: [
      'Add Memotech MTX family support',
      'Add Tatung Einstein 256',
      'Virtual on-screen keyboards for ZX80/ZX81, CPC 464/664/6128 and Toshiba HX-10',
      'Spanish and French ROM variants with flag-based locale selection',
      'Machine status-bar indicators',
      'Generic memory layout pane and unified ROM catalog',
      'Panes menu organized into groups',
      'Hide accuracy options on machines that do not use them',
    ]
  }, {
    version: '0.7.3',
    items: [
      'Add ZX80 and ZX81 emulation with library',
      'Add CPC 6128 Plus and GX4000 (Amstrad\'s ASIC-based "Plus" range): sprites, soft scroll, split-screen, DMA sound, .CPR cartridge loading (boots from a built-in cartridge out of the box), and .SNA snapshots',
      'Xtal and MSX BASIC pane support',
      'Stepped speed control on the toolbar',
      'Grouped machine picker into submenus',
    ]
  }, {
    version: '0.7.2',
    items: [
      'Add experimental MSX support',
      'Add custom ROMs and cartridge for Spectrum & MSX',
      'Show BASIC variables on Amstrad CPC',
      'Correct the save menu for each platform',
      'Split monitor & display pane and added saturation and gamma',
      'Spectrum software library new filters, Microdrives & ROM carts',
      'Fixed screenshots and added links to Spectrum Computing',
      'Microdrives pane lists files stored on each cartridge',
      'Major internal refactoring',
      'Lots of UI tweaking'
    ]
  }, {
    version: '0.7.1',
    items: [
      'Add experimental Tatung Einstein TC-01 support',
      'Add CSW digital tape support',
    ]
  }, {
    version: '0.7.0',
    items: [
      'Add Beta Disk/TR-DOS support (.TRD, .SCL)',
      'Add HFE and SCP image support for CPC/+3',
    ]
  }, {
    version: '0.6.9',
    items: [
      'Save button lights red when a disk has unsaved writes',
      'Debugger steps into the interrupt handler when the CPU is halted',
      'Reliable resume after a page refresh (correct +3 ROM and snapshot save)',
    ]
  }, {
    version: '0.6.8',
    items: [
      'Fixed several Multiface crashes and hangs (repeated NMI press, mid-session page-out, Return key crash)',
      'Fixed tape playback corrupting the trailing checksum byte',
      'Fixed .z80 snapshots dropping AY state and ignoring +3 port 0x1FFD',
      'Fixed four uPD765A FDC spec deviations',
      'Fixed AMX mouse firing PIO interrupts with interrupts never enabled',
      'Fixed +2A/+3 wrongly exposing the Ferranti floating bus',
      'Fixed redundant DD/FD prefix chains costing extra T-states and being uninterruptible',
      'Fixed AY noise generator running at twice the correct hardware rate',
      'MCP: parseAddr now rejects invalid addresses instead of returning NaN',
    ]
  }, {
    version: '0.6.7',
    items: [
      'Pause emulation when the tab or window loses focus (on by default)',
      'Rework keyboard rendering for double-height keys',
    ]
  }, {
    version: '0.6.6',
    items: [
      'On-screen keyboards scale with the display size (1×/2×/3×)',
    ]
  }, {
    version: '0.6.5',
    items: [
      'Interactive 48K/128K/+2/+3 keyboards',
      'Fix tearing on flash attr',
    ]
  }, {
    version: '0.6.4',
    items: [
      'Interface 1/Microdrive support',
      'Per-pane show/hide via the "Panes" menu',
    ]
  }, {
    version: '0.6.3',
    items: [
      'Flipping dual-sided 180K disks support',
      '765A multi-track and CRC behavior tweaks',
      'Z80 power-on tweaks',
    ]
  }, {
    version: '0.6.2',
    items: [
      'Fixed some TZX loading crashes',
      'MCP trap tool',
      'Download tape feature',
    ]
  }, {
    version: '0.6.1',
    items: [
      'MCP screenshot tool',
      'MCP load catalog tool',
    ]
  }, {
    version: '0.6.0',
    items: [
      'Add filter option for AY-3-8912',
      'Built-in software library',
      'Optimized turbo mode',
      'Improved fast loaders',
      'Removed edge loading (was so broken)',
      'Rewrote disk copy protection detection',
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
