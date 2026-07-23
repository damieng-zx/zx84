# ZX84

**A browser emulator for the Sinclair ZX80, ZX81 and ZX Spectrum, Amstrad CPC, Tatung Einstein, MSX, and Memotech MTX, with an MCP server for automated testing.**

https://zx84.envytech.workers.dev

ZX84 is an old-computer emulator with machine-specific hardware models, browser-based media management, inspection tools, and a configurable CRT presentation layer.

## Supported Machines

| Family | Models | Core Hardware |
| --- | --- | --- |
| Sinclair ZX Spectrum | 16K, 48K, 128K, +2, +2A, +3 | Z80, ULA or Amstrad gate array, beeper, AY on 128K-class models, uPD765A on +3 |
| Sinclair ZX80 / ZX81 | ZX80, ZX81, optional 16KB RAM pack | Z80, software-generated monochrome display, keyboard matrix, `.o` / `.p` program images |
| Amstrad CPC | CPC 464, CPC 664, CPC 6128 | Z80, gate array, 6845 CRTC, AY-3-891x, 8255 PPI, uPD765A on 664/6128 |
| Tatung Einstein | TC-01 | Z80, TMS9929A VDP, AY-3-8910, Z80 CTC, WD1770 |
| MSX | Toshiba HX-10 | Z80, TMS9929A VDP, AY-3-8910, 8255 PPI, cartridge slot |
| Memotech MTX | MTX500, MTX512 | Z80, TMS9929A VDP, Z80 CTC, SN76489A, FDX/SDX WD179x disk interface, optional 6845 80-column display |

## Features

### Hardware And Peripherals

- Spectrum ULA timing, floating bus, contention, 128K paging, AY sound, and +3 floppy support.
- Spectrum peripherals: Multiface 1/128/3, Interface 2 cartridges, VTX-5000 Viewdata modem, ZX Interface 1 with up to eight Microdrives, MGT +D, and Beta Disk/TR-DOS.
- CPC cassette support, disk-capable 664/6128 models, Multiface Two, and optional ParaDOS ROM.
- Einstein disk mounting and optional Xtal DOS boot-disk behavior.
- HX-10 cartridge loading and BIOS-level `.cas` cassette loading.
- MTX logical cassette loading, FDX/SDX Type 07 floppy mounting, and optional 80×24 colour display.

Spectrum ROM-overlay peripherals are model-dependent. Interface 1, MGT +D, and Beta Disk are mutually exclusive; Beta Disk takes precedence when enabled.

### Media

Load by picker or drag-and-drop. ZIP archives are unpacked and routed to compatible machines where supported.

| Machine Or Device | Supported Media |
| --- | --- |
| Spectrum | Snapshots: `.sna`, `.z80`, `.szx`, `.sp`; tapes: `.tap`, `.tzx`, `.cdt`, `.csw`; +3 disks: `.dsk`, `.hfe`, `.scp` |
| Spectrum peripherals | Interface 2: `.rom`; Interface 1: `.mdr`, `.mdv`; MGT +D: `.mgt`, `.img`, `.hfe`, `.scp`; Beta Disk: `.trd`, `.scl`, `.hfe`, `.scp` |
| CPC | Snapshots: `.sna`; tapes: `.cdt`, `.tzx`, `.tap`; disks: `.dsk`, `.hfe`, `.scp` on disk-capable models |
| Einstein | Disks: `.dsk`, `.hfe`, `.scp` |
| MSX | Cartridges: `.rom`; cassettes: `.cas` |
| Memotech MTX | Logical cassettes: `.mtx`; FDX/SDX Type 07 disks: `.mfloppy`, `.mfloppy-07` |

The tape deck provides block navigation, transport controls, fast ROM loading, turbo loading, loading sound where applicable, and original-media download. The disk UI supports drive selection, write protection, disk sounds, changed-image saving, blank image creation, and flippy disks.

Media can also be mounted at startup from HTTP(S) URLs. URL-encode each value;
disk units are zero-based:

```text
?snap=https%3A%2F%2Fexample.com%2Fstate.sna
&disk0=https%3A%2F%2Fexample.com%2Fsystem.dsk
&disk1=https%3A%2F%2Fexample.com%2Fdata.dsk
&tape=https%3A%2F%2Fexample.com%2Fgame.tap
```

Snapshots are applied first, then disks in unit order, then tape. Relative URLs
are supported. Cross-origin hosts must permit browser CORS access, and the URL
path or `Content-Disposition` response header must supply a recognised filename
extension.

### Display And Audio

- WebGL CRT renderer with a Canvas fallback.
- Integer scaling plus HQx and xBR upscalers.
- Scanline accuracy controls, Spectrum rainbow rendering, selectable palettes, border cropping, and CPC pixel-aspect correction.
- CRT controls for brightness, contrast, saturation, gamma, scanlines, softness, noise, dot pitch, curvature, masks, and monitor presets.
- Shadow-mask, aperture-grille, slot-mask, LCD-grid, and attribute-mask options.
- Web Audio output with AudioWorklet and SharedArrayBuffer paths where available, plus a ScriptProcessor fallback.
- Master volume, beeper-to-AY mix, AY stereo placement, DC blocking, and ultrasonic-tone filtering.

### Input And Development Tools

- Keyboard mapping, configurable two-player joystick mappings, physical gamepads, and touch/mouse D-pads.
- Spectrum joystick interfaces: Kempston, Cursor, Sinclair 1, and Sinclair 2.
- Kempston and AMX mouse modes on supported machines.
- Pause, frame stepping, step into/over/out, breakpoints, run-to-cursor, disassembly, registers, memory views, and clipboard export.
- Spectrum and Einstein tracing: full execution, port I/O, and ZXTrace. Spectrum traces coalesce repeated loops.
- Spectrum-specific BASIC, BASIC variables, system variables, font, memory-bank, screen-text, and OCR tools.
- Customizable pane ordering, placement, visibility, collapse state, and persistent per-pane settings.

### Saving, Library, And Persistence

- Export Spectrum `.szx` and `.z80` snapshots, CPC snapshots, screenshots, and supported screen/RAM exports.
- Persist settings, pane layout, custom ROMs and fonts, and supported media in browser storage.
- Spectrum and ZX80/ZX81 software libraries with ZXDB-derived search, screenshots, automatic model selection, and cached catalog data.

## MCP Server

The included stdio MCP server drives **Spectrum models** (48K, 128K, +2, +2A, and +3) for automated testing and reverse engineering. It supports execution control, memory and register inspection, disassembly, breakpoints and watchpoints, traps, keyboard input, port I/O, OCR, snapshots, tape/disk mounting, tracing, disk inspection, and Multiface/VTX-5000 control.

See [`mcp/README.md`](mcp/README.md) for setup, the complete tool reference, and workflows.

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5174`, choose a machine in the Hardware pane, then load compatible ROMs and media. The hosted version supplies the standard machine ROM sets; local builds can load replacement ROM images from the ROM pane.

Useful commands:

```bash
npm test              # full Vitest suite
npx tsc --noEmit      # type-check without output
npm run depcheck      # enforce architecture boundaries
npm run build         # production build
npm run mcp           # start the Spectrum MCP server
```

## Current Scope

Hardware and media support varies by machine and model. In particular, the HX-10 has no floppy controller, and some Einstein subsystems remain incomplete. See [`docs/todo.md`](docs/todo.md) for planned formats, devices, and machine work.

## License

[MIT](LICENSE)

## Acknowledgments

Built with inspiration from the ZX Spectrum, CPC, Einstein, and MSX communities and their hardware documentation.
