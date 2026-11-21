# Timex Computer 2048

Timex's Portuguese-built 48K machine: a ZX Spectrum 48K-compatible with a new
"SCLD" ULA that adds extra screen modes. zx84 emulates it as a model of the
Spectrum machine, so it shares the Spectrum's CPU, keyboard, tape, snapshot and
software tooling, with the SCLD's port 0xFF screen modes (including the 512-pixel
hi-res mode), its built-in Kempston joystick port and its port decoding.

| | |
| --- | --- |
| **Manufacturer** | Timex Computer (Portugal), from a Timex Sinclair 2068 design |
| **Released** | 1984 |
| **CPU** | Zilog Z80A — 3.528 MHz |
| **zx84 kind** | `spectrum` — [`src/machines/spectrum/`](../../src/machines/spectrum/) |
| **Model ids** | `tc2048` — the MCP `model` target and `?model=` value |
| **Accuracy** | Per-T-state CPU with ULA contention; scanline display with mid-line (rainbow) rendering, including mid-frame screen-mode changes |
| **Status** | Working — boots the real ROM and draws every SCLD screen mode; contention timing is measured-close, not hardware-verified |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Timex Computer 2048 (`tc2048`) | 1984 | 48 KB | 16 KB | 256×192 with 8×8, or 8×1 ("hi-colour") attributes; 512×192 monochrome | Beeper | Cassette | The other Timex Spectrums (TS2068, TC2068) are not emulated yet |

### ROM sets

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| `tc2048` | none | 1 (16 KB) | hosted (`timex/tc2048.rom`); a lightly modified 48K ROM that sets its screen mode at boot |

The ROM can be replaced from the ROM pane. Dropping a raw 16 KB ROM image while
a TC2048 is the current machine keeps the TC2048.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80 CPU | all | ✅ | Shared core; 3.528 MHz, a 224 T × 312 line (69,888 T) frame |
| SCLD (Timex ULA) | all | ◐ | [`src/machines/spectrum/scld.ts`](../../src/machines/spectrum/scld.ts) holds port 0xFF; [`ula.ts`](../../src/machines/spectrum/ula.ts) draws the modes. The timing figures are Fuse's measurements (see Known issues) |
| Screen modes | all | ✅ | Port 0xFF bits 0–2; see below |
| Memory contention | all | ◐ | The Ferranti pattern (6,5,4,3,2,1,0,0) over 0x4000–0x7FFF, starting at T 14320 |
| Floating bus | — | — | None: an unattached port reads 0xFF |
| Kempston joystick | all | ✅ | Built in, answers any port with A5 low; not a Hardware-pane option |
| Keyboard | all | ✅ | The 48K matrix; `IN 0xFE` has bits 5 and 7 clear. The on-screen keyboard is the TC2048's own: hard grey keys on a black case, a second CAPS SHIFT, a BREAK key (CAPS SHIFT and SPACE together) and a SPACE bar of its own |
| Cassette interface | all | ✅ | Pulse-level deck, instant LOAD where the ROM allows |

### Port 0xFF

| Bits | Meaning |
| --- | --- |
| 0–2 | Screen mode (below) |
| 3–5 | Hi-res colour: the ink is this value, the paper its complement; both bright |
| 6 | Set: the frame interrupt is disabled, whatever `EI` says |
| 7 | Dock / EX-ROM select; remembered, but nothing on a TC2048 uses it |

Reading the port returns the last byte written. Ports 0xFE and 0xFF are decoded
on the low eight address bits, so an `OUT` to any other even port does not reach
the ULA.

| Mode | Picture |
| --- | --- |
| 0 | Screen 0 (the usual 0x4000 screen), 8×8 attributes |
| 1 | Screen 1 (the same layout at 0x6000), attributes at 0x7800 |
| 2 | Screen 0 bitmap; one attribute per 8×1 line from screen 1's bitmap layout |
| 3 | Screen 1 bitmap, each byte its own attribute (a hardware oddity) |
| 4 | 512×192: screen 0 bitmap bytes alternating with screen 0 attribute-area bytes |
| 5 | 512×192: screen 1 bitmap bytes alternating with screen 1 attribute-area bytes |
| 6 | 512×192: screen 0 and screen 1 bitmap bytes alternating (the usual hi-res) |
| 7 | 512×192: screen 1 bitmap bytes, each drawn twice |

The eight hi-res colour pairs are black on white, blue on yellow, red on cyan,
magenta on green, green on magenta, cyan on red, yellow on blue and white on
black. In hi-res the border takes the paper colour, whatever port 0xFE says.

---

## Peripherals

Fixed hardware only: the TC2048's edge connector is not decoded for the Spectrum
interfaces, so none of them are offered.

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Kempston joystick | input | all | ✅ | Always attached |
| SpecDrum | sound | all | ✅ | Port 0xDF, as on a Spectrum |
| Interface 1, +D, Beta Disk, Multiface, µSpeech, Interface 2, mice | — | — | ✗ | Not offered on this model |

---

## Media formats

The Spectrum's: `.tap`, `.tzx`, `.csw`, `.wav`, `.zip`, and snapshots.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.szx` | snapshot | RAM, CPU, screen mode | ✅ | ✅ | Machine id 8; an `SCLD` block carries port 0xFF. Offered to a non-Timex machine, a TC2048 file asks for a TC2048 |
| `.z80` | snapshot | RAM, CPU, screen mode | ✅ | ✅ | Hardware mode 14; byte 36 carries port 0xFF |
| `.sna`, `.sp` | snapshot | RAM, CPU | ✅ | ✗ | Load onto the current machine; no screen mode in either format |

**Save menu exports:** screenshot (at the live 704-wide size in hi-res), RAM dump,
and two screen dumps of the picture on show:

| Export | What it writes |
| --- | --- |
| Screen (`.scr`) | 6912 bytes for an ordinary screen (screen 0, or screen 1 when that is shown); 12288 bytes in hi-colour (the bitmap, then the 6144 attribute bytes laid out like the bitmap); 12289 bytes in hi-res (screen 0, screen 1, then a byte holding port 0xFF with the hi-res colour). Hi-res modes 4, 5 and 7 are written as mode 6, which looks the same |
| Multicolour screen (`.mlt`) | 12288 bytes: the bitmap, then an attribute for every 8×1 line in plain line order. An ordinary screen's cell attributes are repeated down their eight lines. Not available in hi-res, which has no attributes |

Both read back as exactly the picture the ULA drew, in every mode. The library
shows these formats too: Timex hi-res and hi-colour screens, and the multicolour
`.mlt` screens ZXDB holds for many ordinary Spectrum games.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Screen mode changes mid-frame | ✅ | Rendered up to the beam in the old mode first, in all three scanline accuracies |
| Display width follows the mode | ✅ | A frame that contains hi-res is 704 wide (512 pixels plus the border, each pixel half-width); otherwise 352. The display is resized and told the new pixel aspect on each change, as the BBC and C128 do |
| Interrupt-disable bit | ◐ | Honoured from the next frame; a write inside the 32 T interrupt window is ignored for that frame |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger, trace | ✅ | The Spectrum's Z80 debugger |
| Screen OCR / TEXT overlay | ✅ | Reads screen 0, or screen 1 when it is shown. In hi-res it reads the 512-pixel picture as three grids, found automatically: 64×24 (8-pixel cells, the usual 64-column text), 85×24 (6 pixels) and 128×24 (4 pixels); the MCP `ocr` tool takes `64x24h`, `85x24h` and `128x24h`. Hi-res has no attributes, so the text is drawn in the hi-res ink. The font is found as on any Spectrum (the CHARS pointer, the ROM, or a scan of memory); a font that only exists in a program's own memory is not available to OCR of a saved screen dump |
| Software library | ✅ | The Spectrum's, plus the 64 titles ZXDB tags for the TC2048 (tape or snapshot): they play on a TC2048 from any machine, which the library switches to; on a TC2048 the filter "TC2048" lists them with the plain 48K software it also runs |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| Timing is measured-close | contention, border effects | low | Fuse's tests put the contention pattern at T 14320 and the first pixel at 14321; the Timex literature leaves the line length open (226 T is quoted). A few border-effect programs are one line out on real hardware too |
| Interrupt-disable mid-window | port 0xFF bit 6 | low | See above |

## Not emulated

- The horizontal MMU, dock and EX-ROM (port 0xF4) — the TC2048 has no dock; the 128K upgrades (TC2128, TC2144) and the TS2068/TC2068's AY, joysticks and 24K ROM are not emulated.
- The Timex FDD disk system.

## Faithful quirks

- Reading port 0xFF returns the last byte written, so games that probe 0xFF for the floating bus (Arkanoid) do not see it, as on the real machine.
- Bits 5 and 7 of `IN 0xFE` read 0, unlike every other Spectrum.
- Unattached ports read 0xFF; the Timex ULA has no floating bus.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/machines/spectrum/tc2048.test.ts` (ports, all eight screen modes, display resizing, interrupt disable, snapshots; boots the real ROM when `tc2048.rom` is to hand) | Passing | 2026-11-21 |
