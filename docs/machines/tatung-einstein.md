# Tatung Einstein

Tatung's Z80-based home computer: the TC-01 with a TMS9929A video chip and an
8 KB boot monitor, and the later Einstein 256 with a V9938 video chip and MOS 2.1.
zx84 emulates both as disk-only machines: the MOS boots to its monitor, and
BASIC or Xtal DOS loads from a floppy image in drive A:.

| | |
| --- | --- |
| **Manufacturer** | Tatung |
| **Released** | 1984 (TC-01), 1986 (256) |
| **CPU** | Zilog Z80A — 4 MHz |
| **zx84 kind** | `einstein` — [`src/machines/einstein/`](../../src/machines/einstein/) |
| **Model ids** | `einstein-tc01` `einstein-256` — the MCP `model` target and `?model=` value |
| **Accuracy** | Scanline: the CPU runs line by line (313 lines, 80,000 T-states per 50 Hz frame) and the VDP renders each line as it goes; no memory contention; no accuracy selector is offered |
| **Status** | Boots the MOS monitor and Xtal DOS from disk on both models; disk-only (no tape, no snapshots) |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TC-01 (`einstein-tc01`) | 1984 | 64 KB | 8 KB MOS | TMS9929A, 16 KB VRAM, 256×192 | AY-3-8910 | 2 × WD1770 floppy drives | PAL 50 Hz; output buffer 320×240 with border. 8251 USART, Z80 PIO and ADC0844 are stubbed |
| Einstein 256 (`einstein-256`) | 1986 | 64 KB (+ 192 KB VRAM) | 16 KB MOS 2.1 | V9938, 192 KB VRAM, 512×212 | AY-3-8910 | 2 × WD1770 floppy drives | Output buffer 576×240 presented at half width (`pixelAspectX` 0.5); adds ALPHA LOCK latch and system-status port; no PIO or ADC0844 |

### ROM sets

The system ROM can be replaced from the ROM pane (a single image, no separate
pages) and reset to the default. There are no locale variants. Dropping a raw
ROM image while an Einstein is active picks the model by size: 8 KB selects the
TC-01, 16 KB the 256.

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| TC-01 | — | 1 × 8 KB (`einstein/mos12.rom`) | hosted (ROM CDN) |
| Einstein 256 | — | 1 × 16 KB (`einstein/mos21.rom`) | hosted (ROM CDN) |

The optional Xtal DOS system disk (`einstein/xtaldos.dsk`) is fetched from the
same CDN and cached; see Peripherals.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80A CPU | all | ✅ | Shared core [`src/cores/`](../../src/cores/); 4 MHz; boots in interrupt mode 2 |
| Memory map | all | ✅ | 64 KB RAM. Reads of 0x0000–0x7FFF come from the MOS while the overlay is on, writes always land in RAM. 0x4000–0x7FFF reads 0xFF while the overlay is on. TC-01 mirrors the 8 KB MOS across 0x0000–0x3FFF; the 256 maps its 16 KB linearly. Port 0x24 toggles the overlay (any read or write) |
| TMS9929A VDP | TC-01 | ◐ | [`src/cores/tms9918a.ts`](../../src/cores/tms9918a.ts). Text, Graphics I, Graphics II and sprites; Multicolor mode and exact fifth-sprite and coincidence reporting are approximations. Frame flag is polled by the MOS (not wired to the CPU). Three colour maps (see Emulation features) |
| V9938 VDP | 256 | ✅ | [`src/cores/v9938.ts`](../../src/cores/v9938.ts). All text, character and bitmap modes (GRAPHIC 2 to 7), both sprite engines, line and frame interrupts, 512-colour palette, display adjust (R18), blitter command processor, 128 KB main + 64 KB expansion VRAM. R25–R27 are absent (V9958-only). Interrupt on the daisy chain, vector 0xFE, maskable through port 0x80 |
| AY-3-8910 | all | ✅ | 2 MHz clock, ABC stereo by default. Beeper gain is zero (no beeper). Its I/O ports carry the keyboard scan |
| Keyboard | all | ✅ | 8×8 matrix scanned through AY port A (row select) and port B (columns). SHIFT, CONTROL and GRAPH are read from status port 0x20. A 50 Hz scan raises the keyboard interrupt (vector 0xF7), masked at reset |
| WD1770 FDC | all | ✅ | Shared WD179x core in WD1770 mode. Ports 0x18–0x1B (mirrored at 0x1C–0x1F), polled (INTRQ and DRQ are not wired). Drive select latch 0x23: one-hot on bits 0–3, side on bit 4, no motor or density bit. Type I commands pulse BUSY because the MOS waits for it |
| Z80 CTC | all | ✅ | [`src/cores/z80-ctc.ts`](../../src/cores/z80-ctc.ts). Timer prescaler on the 4 MHz CPU clock; channels 0–2 clocked by a 2 MHz pin; channel 2 zero-count chained to channel 3 trigger (the periodic interrupt source); heads the daisy chain and decodes RETI |
| Board interrupts | all | ✅ | Below the CTC in priority order: keyboard (0xF7), ADC (0xFB), fire button (0xFD), each masked by a port 0x20, 0x21 or 0x25 write. Held off while a CTC channel is under service |
| ADC0844 | TC-01 | ◐ | Ports 0x38–0x3F. A write starts a conversion and raises the ADC interrupt after about 160 T-states; every read returns a centred 0x80 (no analogue joystick) |
| ALPHA LOCK latch, system status | 256 | ✅ | Port 0x22 toggles the latch on any access; port 0x26 reports ALPHA LOCK key, ROM paged in, and hardwired dipswitches (50 Hz, parallel printer, English, no mouse). The ALPHA LOCK key has a lamp on the on-screen keyboard |
| Intel 8251 USART | all | ✗ | Stubbed: status reads return Tx-ready, no receive, writes ignored |
| Z80 PIO | TC-01 | ✗ | Ports 0x30–0x37 decoded and ignored; reads return 0xFF |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Floppy drives A: and B: | disk | all | ✅ | Two WD1770 drives (units 0 and 1). Per-drive write-protect, drive-B force-ready, flip side for flippy images, and drive sounds (profile chosen from the image capacity) |
| Xtal DOS boot disk | disk | all | ✅ | Hardware-pane checkbox **Xtal DOS**, on by default. While drive A: is empty a hidden Xtal DOS system disk (fetched from the ROM CDN and cached) is mounted there, so the machine boots straight into Xtal DOS. A disk the user loads into drive A: replaces it; ejecting that disk brings it back; turning the option off removes it. If the disk cannot be fetched the option does nothing |
| Joystick | input | all | ✗ | Joystick pane is hidden (no host input drives the fire lines); see Not emulated |
| Mouse | input | all | ✗ | No mouse pane; the 256's status port reports no mouse |

**Combination rules:** None. The Xtal DOS option only applies while drive A: holds
no user disk.

---

## Media formats

ZIP archives are unpacked and only entries with the extensions below are offered.
All disk formats mount in drive A: by default; the load call's unit hint selects
drive B:.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.dsk` | Disk | Drive A: / B: | ✅ | ✅ | Extended CPC DSK; the controller formats 10 sectors per track |
| `.hfe` | Disk | Drive A: / B: | ✅ | ✅ | Saved back as `.hfe` when the mounted image is bitstream-based |
| `.scp` | Disk | Drive A: / B: | ✅ | ✗ | SuperCard Pro flux images; the drive's Save writes `.dsk` or `.hfe`, never `.scp` |

The Drives pane offers the standard blank-disk set (DSK or HFE) for either drive.
Mounted disks are not restored after a page reload. There is no tape or snapshot
format.

**Save menu exports:** PNG screenshot; `.scr` screen dump (the raw contents of VDP
video RAM: 16 KB on the TC-01, 192 KB on the 256); RAM `.bin` (`ram-64k.bin`, the
full 64 KB of underlying RAM, ignoring the ROM overlay).

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Timing | ✅ | 4 MHz Z80, 50 Hz PAL field (80,000 T-states, 313 lines); the CTC advances with the CPU, the VDP renders per scanline, the FDC is ticked once per frame; no contention |
| Interrupts | ✅ | IM 2 with the CTC → keyboard → ADC → fire daisy chain, plus the V9938 on the 256 |
| TMS9929A colour maps | ✅ | Display pane choice of MAME, Accurate (default) or Naive, TC-01 only; the 256's palette is set by V9938 registers |
| Border size | ✅ | None / half / full, cropped from the output buffer |
| 256 display adjust | ✅ | The V9938's R18 shift is applied to the picture and to the OCR and TEXT-overlay positions |
| Disk sounds | ✅ | Shared floppy sound model; Drive A: and B: LED, track and sector readout |
| Fast / turbo loading | ✗ | No ROM-load trap and no tape |
| Media persistence | ✗ | Disks are session-only (`persistMedia` off) |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | Shared Z80 debug service: breakpoints, memory and port watchpoints, disassembly, registers. Memory pane offers the MOS ROM region and a memory-layout view showing the ROM overlay (CPU read vs write per 16 KB slot) |
| Trace | ✗ | `startTrace` is a no-op; the MCP `trace` tool declines on every machine except the Spectrum |
| Screen OCR / TEXT overlay | ◐ | Matches 6-pixel glyphs on a 42×24 grid against the MOS ROM font (normal and inverse video). TC-01: any mode but Multicolor. 256: GRAPHIC 2 only (the mode MOS 2.1 boots in); other modes report no text. Unmatched cells read as `?` |
| Software library | ✗ | No library button |
| Xtal BASIC listing pane | ✅ | Detokenises the program held in RAM from 0x3E01 |
| On-screen keyboard | ✅ | A separate deck for each model (TC-01 deck; the 256's deck with L-shaped ENTER, function-key legend card and four-wedge cursor pad). Keyboard Lab preset "Tatung Einstein" |
| Host keyboard | ✅ | Physical-position mapping, US layout (best-effort for punctuation). Alt is GRAPH, CapsLock is ALPHA LOCK, F1–F8 are F0–F7, Pause is BREAK, Backspace and Delete are INS DEL. Cursor keys are model-specific chords: TC-01 holds SHIFT for left and up; on the 256 left has its own cell and up is CONTROL+K |
| Status LEDs | ✅ | Keyboard, sound chip (AY-3-8910), disk and TEXT |
| MCP tools | ✅ | Generic tools only (run, step, registers, memory, breakpoints and watchpoints, ports, `key`, `type`, `load` with `drive`, `eject`, `screenshot`, `ocr`, `model`). No Einstein-specific tools. `trace`, `save` (Spectrum snapshot), the uPD765A inspection tools (`disk_geometry`, `track_geometry`, `sector_read`, `weak`) and the Spectrum/CPC disk helpers do not apply; `fdc_log` stays empty because the WD1770 core does not write to the log |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| Trace control does nothing | TC-01, 256 | low | The descriptor sets `trace: true`, so the Disassembly pane shows the trace menu, but `startTrace()` is an empty method and `stopTrace()` returns an empty string. The MCP `trace` tool declines on every machine except the Spectrum |

## Not emulated

- **Cassette.** No tape service, tape pane or tape port I/O; the deck is inert. The 256's system-status cassette bit is never set.
- **Snapshots.** There is no snapshot format or service.
- **Execution trace.** `startTrace` is a stub (see Tools).
- **Intel 8251 USART.** Stubbed (Tx-ready status, no receive).
- **Z80 PIO (TC-01) and 256 printer port.** Writes are ignored; the TC-01 reads 0xFF. The 256's port 0x30 returns idle printer status.
- **Analogue joystick (ADC0844).** Reads a fixed centred value; the 256's pseudo-ADC returns 0x7F.
- **Joystick direction and fire input.** The fire lines (status port, 256 ports 0x30 and 0x32) and fire interrupt are decoded, but nothing on the host side drives them and directions are not mapped.
- **Mouse.** No mouse type is offered.
- **256 dipswitches.** Hardwired to 50 Hz, parallel printer, English.
- **TMS9929A Multicolor mode and fifth-sprite and coincidence reporting.** Approximate.
- **WD1770 FDC log.** The `logFn` hook is not driven.

## Faithful quirks

- **Port 0x24 toggles on any access.** A read flips the ROM overlay as well as a write (documented in the I/O decode as following the MAME einstein driver).
- **Writes under the ROM go to RAM.** Stores to 0x0000–0x7FFF always reach the underlying RAM while the MOS is mapped for reads.
- **On-board ports are not aliased by A6 and A7.** Xtal DOS 1.31 writes to ports 0x48 and 0x49; they must not reach the VDP at 0x08 and 0x09.
- **The TC-01 VDP interrupt is not wired to the CPU.** The MOS polls the status flag; CPU interrupts come from the CTC. On the 256 the V9938 interrupt is on the daisy chain.
- **Type I commands hold BUSY for a few status reads.** The MOS waits for BUSY to set before waiting for it to clear.
- **No TAB key, and the TC-01 has two cursor caps.** Each prints two arrows, picked with SHIFT. MOS 2.1 decodes shifted and unshifted cursor cells identically, so the 256 uses separate cells and CONTROL+K for up.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/einstein/einstein-machine.test.ts` | ROM overlay and mirror, port 0x24 toggle, I/O mirrors, AY-scanned keyboard, CTC interrupt path and 2 MHz clocking, keyboard/ADC/fire interrupts and daisy-chain gating, boot-disk profile, Xtal BASIC listing, frame smoke | — |
| `tests/einstein/einstein-256.test.ts` | 16 KB linear ROM window, V9938 port decode, port 0x80 mask, system status 0x26, ALPHA LOCK, registry ROM-size detection, 512×212 descriptor and pixel aspect, boot smoke | — |
| `tests/einstein/v9938.test.ts` | V9938 ports, VRAM and palette addressing, status registers and interrupts, mode decode, text, graphics and bitmap rendering, sprites, command processor | — |
| `tests/einstein/einstein-keyboard.test.ts` | Matrix scan, status line modifiers, host-key and per-model cursor chords | — |
| `tests/einstein/einstein-256-ocr.test.ts` | GRAPHIC 2 OCR, no text in other modes | — |
| `tests/machines/einstein/media-routing.test.ts`, `tests/machines/disk-pause.test.ts`, `tests/machines/frame-probe.test.ts` | `.dsk`/`.hfe` mount to drive A:/B:, `accepts()` list, refusal of other files, mount preserves run state, drive-sound feed and format latch | — |
| Genuine MOS 1.21 boot (headless) | Renders the MOS sign-on screen; typed keys echo and are processed | 2026-07-14 |
| Genuine Xtal DOS 1.11 system `.dsk` | Boots from drive A: through the WD1770 | 2026-07-14 |
| MOS 1.2 and MOS 2.1 key-decode tables, every matrix cell and modifier swept headlessly against the real ROMs | Matrix and cursor chords match the ROMs | 2026-09-08 |
