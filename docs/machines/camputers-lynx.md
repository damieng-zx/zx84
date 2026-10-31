# Camputers Lynx

Camputers' Z80 home computer: a Motorola 6845 sequences a three-plane,
eight-colour bitmap display, and the 96K and 128K add a floppy interface. zx84
emulates the 48K, 96K and 128K, booting the real system ROMs, with cassette
loading, the FD1793 disk interface, the on-screen keyboard and screen OCR.

| | |
| --- | --- |
| **Manufacturer** | Camputers |
| **Released** | 1983–1984 |
| **CPU** | Zilog Z80A — 4 MHz (48K, 96K), 6 MHz (128K) |
| **zx84 kind** | `lynx` — [`src/machines/lynx/`](../../src/machines/lynx/) |
| **Model ids** | `lynx48` `lynx96` `lynx128` — the MCP `model` target and `?model=` value (no URL spelling quirks) |
| **Accuracy** | Whole-scanline: CPU runs per instruction, the display is composed one scanline at a time under the 6845; no per-T-state video effects and no accuracy control (`descriptor.ui.accuracy` is off) |
| **Status** | Working — covered by unit tests of banking, ports, video, tape, disk and OCR; no real-media or oracle results recorded |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Lynx 48K (`lynx48`) | 1983 | 48 KB | 16 KB (2 × 8 KB images) | 6845, 256 × 248, 8 colours | 6-bit DAC | Cassette | 4 MHz = 80,000 T/frame at 50 Hz; no disk interface |
| Lynx 96K (`lynx96`) | | 96 KB | 24 KB (3 × 8 KB) + 8 KB DOS ROM | 6845, 256 × 248, 8 colours | 6-bit DAC | Cassette + FD1793 floppy, drives A:–D: | Same board design as the 48K with a longer ROM; floppy interface can be removed in the Hardware pane |
| Lynx 128K (`lynx128`) | 1984 | 128 KB | 24 KB (3 × 8 KB) + 8 KB DOS ROM | 6845, 512 × 248, 8 colours | 6-bit DAC | Cassette (twice the 48K tape speed) + FD1793 floppy, drives A:–D: | Different board: bank port 0x82, other video plane layout, motor on port 0x80 bit 3. 6 MHz = 120,000 T/frame; 80-column text (see Tools) |

### ROM sets

Locale does not apply: there is one ROM set per model. All images are hosted
(fetched from the ROM host); any 8 KB socket can be replaced from the ROM pane.

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| 48K | — | `lynx48-1.rom`, `lynx48-2.rom` | hosted (`camputers/`) |
| 96K | — | `lynx96-1/2/3.rom`, `dosrom.rom` | hosted (`camputers/`) |
| 128K | — | `lynx128-1/2/3.rom`, `dosrom.rom` | hosted (`camputers/`) |

ROM pane sockets are 8 KB each: System 1–2 on the 48K; System 1–3 plus DOS ROM
on the 96K and 128K. The DOS socket disappears when the floppy interface is
switched off. A combined image at least as long as the fitted sockets, dropped
on any one socket, is split across all of them. Dropping a raw ROM image picks
the model by size: 16 KB → 48K; 24 KB or 32 KB → 128K when the current model
is the 128K, otherwise 96K. Other sizes are not detected.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| Z80A CPU | all | ✅ | Shared core [`src/cores/z80.ts`](../../src/cores/z80.ts); no memory contention modelled |
| Motorola 6845 CRTC | all | ◐ | Shared core [`src/cores/crtc-6845.ts`](../../src/cores/crtc-6845.ts). Programmed line count sets the raster. The frame interrupt comes from VSYNC, not the board's CURSOR one-shot (see Known issues). A plain 6845 has no status register, so a read of port 0x86 is undriven and returns 0xFF. R14–R17 read back through port 0x87; the light-pen registers never change (see Not emulated) |
| Colour-plane video | all | ✅ | Three 1-bit planes (red, green, blue) → 8 fixed colours. Port 0x80 bit 4 swaps in an alternate green plane (48K/96K plane map and 128K plane map differ) |
| Banked memory | all | ✅ | 8 KB pages; a write lands in every write-enabled bank at once, a read comes from the bank the decode selects. Bank port 0x7F (48K/96K), 0x82 (128K) |
| Sound DAC | all | ✅ | Port 0x84 D0–D5 latch into a 40174 driving a binary-weighted resistor ladder (D5 75K … D0 2.4M); D6 and D7 are not connected. All 64 levels reach the speaker channel at the ladder's own weights (D2's 620K leaves that bit 3% light), so BEEP volume and sampled sound play. /RESET clears it. Held off the speaker while the cassette motor runs (see Not emulated) |
| Keyboard | all | ✅ | 10-line matrix read through the address bus: a read of port 0x80 carries the line in A8–A11. BREAK is off the matrix: a separate switch on keyboard-connector pin 6, wired to the Z80's /INT, so it holds an interrupt request while down |
| Cassette interface | all | ◐ | Motor relay on port 0x80 (bit 1; bit 3 on the 128K); input on keyboard line 0 bit 0 (48K/96K) or port 0x82 bit 2 (128K); output on port 0x84 bit 5 while the motor runs, recorded (see Tape recording) |
| FD1793 + DOS ROM | 96K, 128K | ✅ | Shared `WD179x` core ([`src/cores/wd179x.ts`](../../src/cores/wd179x.ts)); ports 0x50–0x53 read, 0x54–0x57 write, 0x58 drive/side/motor latch. Latch bit 4 pages RAM over the DOS ROM slot |

The DAC, BREAK, interrupt and light-pen notes come from Camputers' own
keyboard and 128K (Mk II) motherboard circuit diagrams, as collected in
[ukscone/Camputers-Lynx](https://github.com/ukscone/Camputers-Lynx/tree/master/Schematics).
The 48K/96K diagram there is too coarse to read at the scan's resolution; the
6-bit DAC on those models is also MAME's and Wikipedia's account, and BEEP's
volume runs 0–63 on all of them.

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Floppy disk interface (FD1793 + DOS ROM) | disk | 96K, 128K | ✅ | Hardware-pane checkbox "Floppy disks", on by default; toggling rebuilds the machine. Off removes the FDC ports, `.ldf` media, DOS ROM socket and Drive pane |
| Joystick / mouse | input | — | ✗ | None fitted (see Not emulated) |
| Cartridge slot | ROM | — | ✗ | None |

**Combination rules:** None. The floppy interface is the only Hardware-pane
option, and the 48K cannot have it.

---

## Media formats

ZIP archives are unpacked and their contents routed as below.

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.tap` | Tape | Tape deck | ✅ | ✅ | Save is a recording of what the ROM SAVEs (Save menu), not a re-save of the mounted tape. Lynx format only (shares the extension with the ZX Spectrum's; a Spectrum `.tap` is refused). Mount message gives the `LOAD "name"` or `MLOAD "name"` command |
| `.ldf` | Disk | Drives A:–D: (A: by default) | ✅ | ✅ | 96K and 128K only; refused on the 48K. 204,800-byte (200 KB, single-sided 40 track) and 819,200-byte (800 KB, double-sided 80 track) raw sector dumps; 10 × 512-byte sectors per track. Saved as `.ldf` |
| `.lynxstate` | Snapshot | Machine | ✅ | ✅ | zx84's own exact save state (see below) |

Blank disks can be created in the Drive pane: 800 KB double-sided 80-track or
200 KB single-sided 40-track. Mounted disks come back after a reload on the
96K and 128K.

**Snapshots.** `.lynxstate` is zx84's native save state, in the same
container as the Atari's `.a8state` (magic `ZXLX`, a CRC-32 and length checked
before the machine is touched, deflated when saved): the Z80 with its hidden
MEMPTR/Q latches and interrupt delays, every RAM chip with the bank port and
ports 0x80/0x58 the bank decode is built from, the 6845's registers and raster
counters, the DAC level and motor relay, the beam's frame grid and the FD1793
down to a transfer in flight, so a restore carries on cycle for cycle. A saved
file also carries the four drives (the disks exactly as the controller sees
them, writes included, with their names and write-protect tabs). The header
records the model, so a state from another Lynx asks for that model, and the
CRC of the ROMs (a different ROM is loaded anyway, with a warning); a state
saved with the disk interface fitted or removed, or with a different number of
drives, is refused until the Hardware or Drives pane matches. A state is taken
between frames (a frame a debugger stop left open is run to its end first).
The same state, without the disks, backs browser-refresh resume. The cassette
is not part of the state.

**Save menu exports:** Snapshot `.lynxstate`, Saved tape (`.tap`, named after the first file on it), PNG screenshot, RAM `.bin` (every
RAM chip back to back, without the ROM: user RAM then video RAM, 96 KB on the
48K/96K; the 128K adds its extra RAM, 192 KB). No screen-dump format.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Tape pulse playback | ✅ | Bit widths from the board's tape rate (4 kHz; 8 kHz on the 128K); leader and sync byte are regenerated, since the `.tap` omits them |
| Motor-gated deck | ✅ | The deck runs only while the ROM has the motor on; a mounted tape waits paused at the start |
| Tape turbo loading | ✅ | Runs flat out while the motor is on and the ROM is reading the cassette port; "Turbo while loading" setting, on by default; releases 25 frames after reads stop |
| Tape sound | ✗ | `tapeSound` is off |
| Tape recording | ✅ | The edges SAVE puts on port 0x84 bit 5 (motor on) are timed and decoded back to bytes: each leader sets the bit width (so the 48K and 128K rates and other TAPE speeds all decode), the first wide half-cycle after it fixes the bit phase, and a block counts only if it starts with the A5 sync byte. Name blocks and data entries are reassembled into a Lynx `.tap` (data cut to the size its header gives), offered as **Saved tape** in the Save menu. Cleared by a reset. Checked with synthetic pulse trains and zx84's own deck playback; not yet against a real ROM SAVE (no ROM to hand) |
| Fast ROM loading | ✗ | No ROM trap; loading is at pulse level |
| Raster from the 6845 | ✅ | Frame divided among however many lines R4/R9 set |
| Border | ◐ | Always black; no border colour register. Border size is not croppable |
| Pixel aspect | ✅ | 128K pixels are half width so 512 across fills the same screen as the 48K's 256 |
| Disk sounds | ✅ | Shared floppy sound model, 5.25" profile, following the selected drive |
| Media persistence | ◐ | Disk media persists across reloads (`persistMedia` is set on the 96K and 128K only) |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | Shared Z80 debug service; memory regions for the system ROM and (with the floppy interface) the DOS ROM; memory and port watchpoints |
| Trace | ✅ | Full (address, disassembly, registers, T-states and operand context, with tight loops folded), a port I/O tally, and ZXTrace — the shared Z80 trace engine; a trace stops capturing at 500,000 lines |
| Memory layout pane | ✅ | Per-slot page names (ROM, RAM, Video), the write-enabled banks, green plane (main/alternate), cassette motor |
| Screen OCR / TEXT overlay | ✅ | Matches the screen against the 96-glyph (6 × 10 pixel) character set in the first ROM image. 40 × 24 grid on the 48K/96K, 80 × 24 on the 128K. Reports an error rather than guessing when a replaced ROM has no font at the usual address. Understands inverse video |
| Software library | ✗ | None |
| On-screen keyboard | ✅ | Skeuomorphic Lynx deck, same on all models; the BREAK cap holds /INT low while pressed |
| Hardware pane | ✅ | "Floppy disks" checkbox (96K, 128K) |
| Status bar | ✅ | Keyboard, load and TEXT indicators, plus a disk indicator on 96K/128K |
| MCP tools | ✅ | All generic tools (`run`, `step`, `registers`, `read_memory`, breakpoints, watchpoints, traps, `key`, `type`, `load`, `eject`, `screenshot`, `ocr`, …). `trace` works. No machine-specific tools; `frame_trace`, `save` (SZX) and the +3/CPC disk-inspection tools do not apply |
| Drive count | ✅ | One to four drives on the FD1793, from **Drive count** in drive A's options menu; saved, rebuilds the machine. Unconnected units give a seek error and stay not-ready |

Host keyboard: mapped by physical key position; the Lynx has no function keys.
Esc → ESC, Backspace → DELETE, Caps Lock → SHIFT LOCK, Pause → BREAK, either
Shift or Control key works.

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| Frame interrupt timing | all | low | Camputers' 128K diagram (sheet 5) drives /INT from the 6845's CURSOR output through a 4538 one-shot of 40 µs ± 8 µs and a 7406. zx84, like MAME (whose notes say CURSOR did not work for it), interrupts on the first line of VSYNC instead, and offers the request once rather than holding it for 40 µs, so an interrupt that arrives while interrupts are disabled is lost rather than taken when they come back on within the pulse |

## Not emulated

- **Tape sound while saving.** With the motor on, port 0x84 is recorded but kept off the DAC, so SAVE is silent.
- **Non-ROM tape formats in recordings.** Only blocks in the ROM's encoding (leader, A5 sync, two-width bit cycles) are kept; anything else on the cassette output is dropped, since the Lynx loader only takes `.tap`.
- **Joystick and mouse.** The input service has no joystick or mouse ("later increment").
- **Snapshots: the cassette.** `.lynxstate` restores the machine exactly but not the tape deck's position. No other emulator's snapshot format is read or written.
- **Cartridge slot.** `cartridge` is `null`.
- **6845 light pen.** R16/R17 never change. The 128K board has a light-pen input (SKT4 pin 1, "LPI", pulled up through 10K and clocked onto the 6845's LPSTB by a 74LS74, diagram sheet 6), but no light pen is known for the Lynx, and with nothing plugged in the input idles high and never strobes.

## Faithful quirks

- **A write goes to every enabled bank.** The ROM paints one byte into red and blue planes with a single store; reads come from one bank only.
- **48K video stores appear at four addresses.** The video banks leave A13 and A15 out of the decode (the 128K decodes fully).
- **Bank 4 drops out when bank 2 is selected on the 128K.** An AND gate in IC82.
- **48K/96K cassette input shares keyboard line 0 bit 0.** While the motor bit is set, SHIFT's column carries the tape signal instead.
- **The 128K runs its tape at twice the speed**, so bit cells are half as wide.
- **The border is black.** There is no border colour register.
- **BREAK does not stop a program.** It holds /INT low, so the CPU takes RST 38h again each time it re-enables interrupts, for as long as the key is down; what that does is up to the ROM. ESC is the key that interrupts a program (Computing Today, June 1983, found BREAK "appears to do nothing in particular").
- **Port 0x86 reads 0xFF.** The plain 6845 has no status register to answer it.
- **FD1793 status bit 7 is NOT READY** rather than MOTOR ON, as on a WD1793.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/lynx/lynx-clock.test.ts` — 4 MHz / 6 MHz clocks, 80,000 / 120,000 T-states per frame | Pass | 2026-10-18 |
| `tests/lynx/lynx-memory.test.ts`, `lynx-memory-128.test.ts` — bank decode, multi-bank writes, DOS ROM paging, IC82 gate | Pass | 2026-10-18 |
| `tests/lynx/lynx-io.test.ts` — keyboard line in A8–A11, DAC (6-bit latch) vs tape on port 0x84, 48K/128K bank and cassette ports, FDC ports | Pass | 2026-10-26 |
| `tests/lynx/lynx-sound-break.test.ts` — DAC levels worked by hand from the ladder's resistor values (full scale, D5 alone, a mixed code, D6/D7 ignored, every code above the last, cleared by reset); BREAK as a held /INT level (re-entered while down, stops when let go, masked by DI, host Pause key); port 0x86 undriven, R14 read back | Pass | 2026-10-26 |
| `tests/lynx/lynx-video.test.ts` — screen sizes, row stride, alternate green plane, black border | Pass | 2026-10-18 |
| `tests/lynx/lynx-tap.test.ts`, `lynx-tape-deck.test.ts` — `.tap` parse (sizes checked against the "Lynx Invaders" image length), motor-gated deck, Spectrum `.tap` refusal, tape turbo | Pass | 2026-10-18 |
| `tests/lynx/lynx-tape-save.test.ts` — SAVE recording: spec-built pulse trains through port 0x84 at the 48K and 128K rates decode to the exact `.tap` and mount back; motor-off and reset; sync byte, partial byte, header-sized cut; a `.tap` played through the deck and captured decodes to itself | Pass | 2026-10-26 |
| `tests/lynx/lynx-disk.test.ts`, `tests/floppy/ldf-image.test.ts` — `.ldf` mount, four drives, round-trip save, 48K refusal | Pass | 2026-10-18 |
| `tests/lynx/ocr.test.ts` — glyph matching with a synthetic font, 40/80-column grids, inverse video, missing-font handling | Pass | 2026-10-18 |
| `tests/lynx/lynx-keyboard.test.ts`, `lynx-keyboard-layout.test.ts`, `lynx-rom-slots.test.ts`, `lynx-watchpoints.test.ts` | Pass | 2026-10-18 |
| Oracle or real-media results | No recorded reference results. | — |
