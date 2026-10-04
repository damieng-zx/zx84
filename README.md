# ZX84

**A browser emulator for the Sinclair ZX80, ZX81 and ZX Spectrum, Amstrad CPC (including the Plus range) and PCW, Tatung Einstein, MSX, Memotech MTX, Camputers Lynx, Jupiter Ace, and Acorn BBC Micro, with an MCP server for automated testing.**

https://zx84.envytech.workers.dev

ZX84 is an old-computer emulator with machine-specific hardware models, browser-based media management, inspection tools, and a configurable CRT presentation layer.

## Supported Machines

| Family | Models | Core Hardware |
| --- | --- | --- |
| Sinclair ZX Spectrum | 16K, 48K, 128K, +2, +2A, +3 | ULA or Amstrad gate array, beeper, AY on 128K-class models, uPD765A on +3 |
| Sinclair ZX80 / ZX81 | ZX80, ZX81, optional 16KB RAM pack | Software-generated monochrome display, keyboard matrix, `.o` / `.p` program images |
| Amstrad CPC | CPC 464, CPC 664, CPC 6128, 6128 Plus, GX4000 | Gate array or Plus ASIC, 6845 CRTC, AY-3-891x, 8255 PPI, uPD765A on 664/6128, cartridge on Plus models |
| Tatung Einstein | TC-01, 256 | TMS9929A (TC-01) or V9938 (256) VDP, AY-3-8910, Z80 CTC, WD1770 |
| MSX | Toshiba HX-10 | TMS9929A VDP, AY-3-8910, 8255 PPI, cartridge slot |
| Memotech MTX | MTX500, MTX512, RS128 | TMS9929A VDP, Z80 CTC, SN76489A, twin matrix-wired joysticks, ROM extension card, FDX/SDX WD179x disk interface, optional 6845 80-column display |
| Camputers Lynx | 48K, 96K, 128K | 6845 CRTC video, DAC sound, cassette, FD1793 floppy on 96K/128K |
| Jupiter Ace | Jupiter Ace | Jupiter Cantab ULA (32×24 monochrome text display), piezo buzzer, cassette port, optional 16K or 48K RAM pack, FORTH in ROM |
| Acorn BBC Micro | Model B | MOS 6502, 6522 VIAs, 6845 CRTC with video ULA and SAA5050 teletext (Mode 7), SN76489 sound, Acorn 8271 or WD1770 DFS disc interface |
| Amstrad PCW | 8256, 8512, 9512, 9256 | Gate array (roller-RAM bitmap video, 300Hz timer, FDC interrupt routing), beeper, uPD765A, memory-mapped keyboard, no ROM — boots from disc |

## Features

### Hardware And Peripherals

- Spectrum ULA timing, floating bus, contention, 128K paging, AY sound, and +3 floppy support.
- Spectrum peripherals: Multiface 1/128/3, Interface 2 cartridges, VTX-5000 Viewdata modem, ZX Interface 1 with up to eight Microdrives, MGT +D, and Beta Disk/TR-DOS.
- CPC cassette support, disk-capable 664/6128 models, Multiface Two, optional ParaDOS ROM, and the Plus ASIC (sprites, soft scroll, split-screen, DMA sound) on the 6128 Plus and GX4000.
- Einstein disk mounting, optional Xtal DOS boot-disk behavior, and the Einstein 256's V9938 VDP with 512×212 display modes.
- HX-10 cartridge loading and BIOS-level `.cas` cassette loading.
- MTX CP/M 2.2 boot through the real FDX hardware using a hosted Type 07 system disk.
- MTX logical cassette loading, banked ROM packs, FDX/SDX Type 03 and Type 07 floppy mounting, optional 512 KiB RAM expansion, and optional 80×24 colour display.
- The bundled MTX CP/M profile installs the native SIDISC module and exposes fitted expansion RAM as an empty type-43 SiDisc drive F:.
- Camputers Lynx 6845 CRTC display, DAC sound, cassette loading, and the FD1793 floppy interface on the 96K and 128K.
- Jupiter Ace ULA text display, buzzer sound, ROM-verified cassette loading and saving, and optional 16K or 48K RAM packs.
- Acorn BBC Micro Model B booting the real MOS and BASIC ROMs: Mode 7 teletext and bitmap modes 0-6, SN76489 stereo sound, keyboard option links, and DFS discs on either the Acorn 8271 or the WD1770 interface.
- Amstrad PCW gate array with roller-RAM bitmap video, 300 Hz timer, FDC interrupt routing, memory-mapped keyboard, beeper, and uPD765A discs; the PCW has no ROM and boots CP/M+ or LocoScript from the disc in drive A.

Spectrum ROM-overlay peripherals are model-dependent. Interface 1, MGT +D, and Beta Disk are mutually exclusive; Beta Disk takes precedence when enabled.

### Media

Load by picker or drag-and-drop. ZIP archives are unpacked and routed to compatible machines where supported.

| Machine Or Device | Supported Media |
| --- | --- |
| Spectrum | Snapshots: `.sna`, `.z80`, `.szx`, `.sp`; tapes: `.tap`, `.tzx`, `.cdt`, `.csw`; +3 disks: `.dsk`, `.hfe`, `.scp` |
| Spectrum peripherals | Interface 2: `.rom`; Interface 1: `.mdr`, `.mdv`; MGT +D: `.mgt`, `.img`, `.hfe`, `.scp`; Beta Disk: `.trd`, `.scl`, `.hfe`, `.scp` |
| CPC | Snapshots: `.sna`; tapes: `.cdt`, `.tzx`, `.tap`; disks: `.dsk`, `.hfe`, `.scp` on disk-capable models; Plus cartridges: `.cpr` |
| Einstein | Disks: `.dsk`, `.hfe`, `.scp` |
| MSX | Cartridges: `.rom`; cassettes: `.cas` |
| Memotech MTX | ROM packs: `.rom`; logical cassettes: `.mtx`; FDX/SDX Type 03/07 disks: `.mfloppy`, `.mfloppy-03`, `.mfloppy-07` |
| Camputers Lynx | Cassettes: `.tap`; disks: `.ldf` on the 96K/128K |
| Jupiter Ace | Cassettes: `.tap`, `.tzx`, `.csw` |
| Acorn BBC Micro | Disks: `.ssd`, `.dsd`, `.img` |
| Amstrad PCW | Disks: `.dsk`, `.td0`, `.hfe`, `.scp` |

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

The starting machine can be chosen with `?model=` (alias `?machine=`), e.g.
`?model=cpc6128&disk0=...`. It takes precedence over the last-used machine,
becomes the new saved choice, and is removed from the address bar once applied.
Values are case-insensitive; write `+` models as `plus2a`/`plus3` or `%2B3`.
Known models: `16k` `48k` `128k` `+2` `+2A` `+3` `zx80` `zx81` `jupiter-ace`
`cpc464` `cpc664` `cpc6128` `cpc6128plus` `gx4000` `pcw8256` `pcw8512`
`pcw9256` `pcw9512` `einstein-tc01` `einstein-256` `hx-10` `mtx500` `mtx512`
`rs128` `lynx48` `lynx96` `lynx128` `bbc-b`.

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
- Screen transcription (the TEXT overlay and the MCP `ocr` tool) on every machine with an OCR engine. The Lynx and the PCW have no character memory, so their text is recovered by matching the picture against the character set; the Jupiter Ace, the ZX80/ZX81 and BBC Mode 7 read theirs straight out of the screen file.
- Customizable pane ordering, placement, visibility, collapse state, and persistent per-pane settings.

### Saving, Library, And Persistence

- Export Spectrum `.szx` and `.z80` snapshots, CPC snapshots, screenshots, and supported screen/RAM exports.
- Persist settings, pane layout, custom ROMs and fonts, and supported media in browser storage.
- Spectrum and ZX80/ZX81 software libraries with ZXDB-derived search, screenshots, automatic model selection, and cached catalog data.

## MCP Server

The included stdio MCP server drives **every registered machine** — Spectrum, ZX80/ZX81, CPC (including the Plus range), Einstein, MSX, MTX, Camputers Lynx, Jupiter Ace, Amstrad PCW, and BBC Micro — for automated testing and reverse engineering. Generic tools work through the `Machine` SPI; hardware-specific tools cover Spectrum peripherals and tracing, MTX expansions, CPC/uPD765A disk inspection, ZX81 hi-res hardware, and per-machine media mounting.

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
npm run mcp           # start the MCP server
```

## Current Scope

Hardware and media support varies by machine and model. In particular, the HX-10 has no floppy controller, the Lynx 48K and the Jupiter Ace have no disk interface, the PCW ships no ROM and needs a user-supplied CP/M+ or LocoScript boot disc, and some Einstein and CPC subsystems remain incomplete.

## License

[MIT](LICENSE)

## Acknowledgments

zx84 stands on decades of work by people who documented, emulated and preserved these machines, and who have shared that work freely. Particular thanks to:

- **Simon Owen**, for SimCoupe and for his many years of work on SAM Coupé emulation, documentation and tools.
- **Philip Kendall** and the **Fuse and libspectrum contributors**, for Fuse, one of the most accurate and best-documented Spectrum emulators, and for the libspectrum file-format library.
- **John Elliott**, for JOYCE, LibDsk and his many emulators, tools and documents on the Amstrad PCW, CPC and disk formats.
- **Andy Key**, for MEMU and the Memotech MTX community resources, including his transcription of the FDX 80-column character font used in zx84.
- **Ben Harris**, for the Bedstead font, which carries the SAA5050 teletext glyphs.
- **Einar Saukas** and the contributors to [ZXDB](https://github.com/zxdb/ZXDB), the open database that powers the software library. The catalogs zx84 builds from it are derived from ZXDB and are meant to stay open.
- **Hyllian**, for the xBR scaling shaders.
- **The MAME team**, **the openMSX team** and the authors of Arnold, Caprice32, BeebEm, beebjit, HxC and the other open-source emulators and tools whose published behaviour and documentation taught us how the hardware works.
- **Sean Young**, **Cliff Lawson**, **Jacob Nevins**, the **Grimware** and **CPCWiki** contributors, and the many people who wrote hardware references, ROM disassemblies and technical notes.
- The ZX Spectrum, CPC, PCW, Einstein, MSX, MTX, Camputers Lynx, Jupiter Ace, SAM Coupé and BBC Micro communities, whose documentation, emulators and tools keep these machines alive.

Third-party code and data used in zx84, with their licences, are listed in [THIRD_PARTY.md](./THIRD_PARTY.md).
