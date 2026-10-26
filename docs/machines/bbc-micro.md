# Acorn BBC Micro

Acorn's 6502 home and school computer, commissioned for the BBC's Computer
Literacy Project. zx84 emulates the Model B with 32 KB of RAM, the MOS and BBC
BASIC ROMs, sixteen sideways ROM sockets, Modes 0–6 and Mode 7 teletext, the
SN76489 sound chip, cassette, and either of the two period disc interfaces
(Intel 8271 or WD1770 Acorn DFS).

| | |
| --- | --- |
| **Manufacturer** | Acorn Computers |
| **Released** | 1981 |
| **CPU** | MOS 6502 — 2 MHz |
| **zx84 kind** | `bbc` — [`src/machines/bbc/`](../../src/machines/bbc/) |
| **Model ids** | `bbc-b` — the MCP `model` target and the `?model=` value (case-insensitive: `?model=BBC-B` works) |
| **Accuracy** | Instruction-stepped 6502 with a running cycle count; 6845 CRTC advanced per scanline; the picture is drawn once per frame from the register state at the end of the frame (no accuracy setting) |
| **Status** | Boots the OS 1.20 and BASIC II ROMs to BBC BASIC; keyboard, sound, tape (load and save) and both disc interfaces are covered by tests |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Model B (`bbc-b`) | 1981 | 32 KB (0x0000–0x7FFF) | 16 KB OS + 16 KB BASIC, 16 sideways sockets | 6845 CRTC + Video ULA (Modes 0–6), SAA5050 teletext (Mode 7) | SN76489 (3 tone + noise) | Cassette (UEF, CSW); 5.25" DFS drives 0 and 1 via 8271 or WD1770 interface | 312 lines × 50 Hz = 40,000 CPU cycles per frame at 2 MHz |

### Video modes

The mode is derived from the Video ULA control register and the CRTC. The frame
buffer is 640 pixels wide in every mode.

| Mode | Kind | Resolution | Colours | Notes |
| --- | --- | --- | --- | --- |
| 0 | Bitmap | 640 × 256 | 2 | |
| 1 | Bitmap | 320 × 256 | 4 | |
| 2 | Bitmap | 160 × 256 | 16 logical (8 physical) | |
| 3 | Text bitmap | 640 wide | 2 | 10 scanlines per character row; the last two are blanked |
| 4 | Bitmap | 320 × 256 | 2 | |
| 5 | Bitmap | 160 × 256 | 4 | |
| 6 | Text bitmap | 320 wide | 2 | 10 scanlines per character row; the last two are blanked |
| 7 | Teletext | 40 × 25 cells, 12 × 20 pixels each | 8 | SAA5050 character generator with character rounding, contiguous and separated mosaics |

At 1× scale the buffer holds one line per scanline and Mode 7's interlaced
half-lines are blended (both lit = ink, one lit = 50 % mix, none = paper). At
even scales from 2× the hi-res layout is used instead: 512 lines, each bitmap
scanline drawn twice and all 20 Mode 7 lines drawn unblended.

### ROM sets

The machine has a single locale (UK). Sources are fetched at start-up through
the shared ROM loader; any of them can be replaced from the ROM pane.

| ROM | Fitted when | Socket | Source |
| --- | --- | --- | --- |
| MOS OS (`os12.rom`, 16 KB) | always | OS window 0xC000–0xFFFF | `bbc/os12.rom`, or user-supplied |
| BBC BASIC II (`basic2.rom`, 16 KB) | always | Sideways socket 15 | `bbc/basic2.rom`, or user-supplied |
| Acorn DNFS (`dnfs.rom`: DFS 1.20 + NFS 3.60) | Disk system = Acorn DFS (8271) | Sideways socket 13 | `bbc/dnfs.rom`, or user-supplied |
| Acorn 1770 DFS 2.26 (`dfs-2.26.rom`) | Disk system = Acorn 1770 DFS (default) | Sideways socket 13 | `bbc/dfs-2.26.rom`, or user-supplied |

The OS and BASIC are replaced together as one 32 KB image (16 KB OS followed by
16 KB BASIC). The other fourteen sideways sockets start empty and each accepts a
user-supplied ROM image from the ROM pane. An 8 KB image is mirrored across both
halves of the 16 KB socket. The DNFS ROM falls back to plain DFS because no
Econet hardware is fitted.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| MOS 6502 CPU | all | ✅ | Core in [`src/cores/m6502.ts`](../../src/cores/m6502.ts): official opcodes plus the stable undocumented ones (SLO, RLA, SRE, RRA, SAX, LAX, DCP, ISC, ANC, ALR, ARR, AXS); IRQ level-sensitive, NMI edge-triggered; decimal mode including the NMOS Z-flag quirk |
| Memory map | all | ✅ | RAM below 0x8000; sideways ROM at 0x8000–0xBFFF selected by the ROMSEL latch at 0xFE30 (low nibble used); OS ROM above 0xC000; hardware window 0xFC00–0xFEFF. Writes to ROM are ignored |
| 6845 CRTC | all | ✅ | [`crtc-6845.ts`](../../src/cores/crtc-6845.ts); per-scanline stepping, interlace sync-and-video (needed for Mode 7's 312-line frame), VSYNC drives System VIA CA1 |
| Video ULA | all | ✅ | Control register at 0xFE20 and palette at 0xFE21; the whole 0xFE20–0xFE2F block aliases to those two registers. Logical-to-physical palette, 8 physical colours |
| SAA5050 teletext | all | ✅ | [`saa5050.ts`](../../src/cores/saa5050.ts); Mode 7 only; colour state reset each field |
| System VIA and User VIA (6522) | all | ✅ | [`m6522.ts`](../../src/cores/m6522.ts), ticked at 1 MHz. System VIA: 50 Hz VSYNC on CA1, Timer 1 as the 100 Hz clock, keyboard, sound bus, IC32 latch. User VIA: timers and registers only |
| IC32 addressable latch | all | ◐ | Sound write strobe, keyboard auto-scan enable, screen-wrap C0/C1 (hardware scroll address wrap), CAPS LOCK and SHIFT LOCK lamps. Speech-processor outputs (latch bits 1–2) are ignored |
| SN76489 sound | all | ✅ | [`sn76489.ts`](../../src/cores/sn76489.ts), 4 MHz clock, TI 15-bit noise variant; reached through the System VIA slow data bus. Optional stereo placement of the three tone channels |
| Keyboard matrix | all | ✅ | Host keys mapped by produced character (so BBC shifted symbols type correctly) or by physical position; SHIFT is matrix cell (0,0) |
| Keyboard option links | all | ◐ | Modelled as row-0 matrix bits that the MOS reads at power-on. None are fitted by default, giving the standard Model B start-up (Mode 7, SHIFT+BREAK boots the disc). There is no control for changing them |
| 6850 ACIA + serial ULA | all | ◐ | [`mc6850.ts`](../../src/cores/mc6850.ts); serial ULA at 0xFE10 (baud rates, cassette/RS423 select, motor relay). Wired to the cassette port; RS423 receives nothing and its output goes nowhere |
| Cassette interface | all | ✅ | Pulse-level playback through an FSK demodulator into the ACIA, 1200 and 300 baud; motor relay moves the tape; what the OS writes to the ACIA is recorded |
| Disc controller | all | ✅ | Intel 8271 or WD1770, or none (see Peripherals). Floppy window 0xFE80–0xFE87; interrupt output on the CPU NMI line |
| Floppy drives | all | ✅ | Two DFS drives (0 and 1), 5.25" (drive sounds use the 5.25" profile), 40 or 80 tracks, one or two sides; write-protect per drive |
| uPD7002 ADC (analogue port) | all | ✅ | [`upd7002.ts`](../../src/machines/bbc/peripherals/upd7002.ts) at 0xFEC0–0xFEDF (repeating every four bytes): channel/flag/precision write, status (/EOC, /BUSY, top two result bits), result high and low bytes. A conversion takes 4 ms (8-bit) or 10 ms (12-bit); end of conversion is a falling edge on System VIA CB1, the MOS's ADC interrupt |
| Joystick fire buttons | all | ✅ | System VIA PB4 (joystick 1) and PB5 (joystick 2), low while pressed |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Acorn DFS, Intel 8271 | disk | `bbc-b` | ✅ | Original interface; single-density command/parameter/result chip ([`i8271.ts`](../../src/cores/i8271.ts)) mapped at 0xFE80–0xFE84. Functional model: sector data comes straight from the disk image, with no flux or bitstream layer |
| Acorn 1770 DFS, WD1770 | disk | `bbc-b` | ✅ | Later upgrade ([`wd179x.ts`](../../src/cores/wd179x.ts) base). Registers at 0xFE84–0xFE87 with a write-only drive-control latch at 0xFE80 (drive select, side, reset). Default |
| No disc interface | — | `bbc-b` | ✅ | No DFS ROM fitted and the Drives pane is hidden |
| Joysticks (analogue port) | input | all | ✅ | Two sticks, one fire button each. Player 1 is ADC channels 0/1 (ADVAL(1)/(2)) and PB4, player 2 channels 2/3 and PB5. A stick reads highest at full left and full up (ADVAL 65520) and 0 at full right and full down. Keys and the on-screen pad give full deflection; a gamepad's analogue stick is proportional |
| Mouse | input | — | ✗ | None offered (descriptor has no mouse types) |
| Cartridge slot | — | — | ✗ | None offered |

**Combination rules:** The disc interface is chosen with the **Disk system**
selector in the Hardware pane (None, Acorn DFS (8271), Acorn 1770 DFS; default
1770). The interface ROM is fitted at build time, so changing the selector
rebuilds the machine, and switching to a different interface ejects any mounted
discs. Exactly one interface is fitted at a time.

---

## Media formats

ZIP archives are unpacked and their contents routed as below. File type is
decided by extension for disks; for tapes the content decides (a UEF signature
or gzip wrapper is UEF, anything else is tried as CSW).

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.ssd` | Disk | DFS drive 0 (or 1) | ✅ | ✅ | Single-sided raw sector dump (10 × 256-byte sectors per track). Truncated images are padded to 40 or 80 tracks per the catalogue |
| `.dsd` | Disk | DFS drive 0 (or 1) | ✅ | ✅ | Double-sided, sides interleaved per track |
| `.img` | Disk | DFS drive 0 (or 1) | ✅ | ✅ | Treated as double-sided when larger than 204,800 bytes, otherwise single-sided; saved back as `.ssd` or `.dsd` |
| `.uef` | Tape | Tape deck | ✅ | ✅ | Gzip-wrapped UEF also accepted. Save is whatever the OS wrote to the cassette port |
| `.csw` | Tape | Tape deck | ✅ | ✗ | Sampled tape |

Loading a disk into drive 0 resets the machine and holds SHIFT (SHIFT+BREAK) so
the DFS auto-boots it; drive 1 is mounted without a reset. A tape is mounted
with play armed and waits for `*TAPE` then `CHAIN""` (or `*RUN`). There are no
snapshot formats. Blank discs can be created in the Drives pane as `.ssd`
(100K SS/40T, 200K SS/80T) or `.dsd` (200K DS/40T, 400K DS/80T).

**Save menu exports:** recorded tape (`.uef`, offered as `bbc-tape.uef`), PNG
screenshot, RAM `.bin` (32 KB, `bbc-b-ram-32k.bin`). Disks are saved from the
Drives pane.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Tape turbo | ✅ | Runs flat out while the tape is being read, staying engaged across inter-block gaps; the "Turbo while loading" option in the Drives pane (`tape-turbo-load`, on by default) disables it. Not a ROM trap |
| Tape sound | ✗ | Descriptor sets `tapeSound: false` |
| Tape transport | ✅ | A mounted tape is armed to play and only moves while the OS switches the cassette motor relay on; play, pause, stop, rewind and seek by block are available |
| Tape recording | ✅ | `SAVE` to tape is captured and exported as UEF; verified by a SAVE then LOAD round trip in the tests |
| Palette family | ✅ | Display pane: fully saturated `pal`, or muted `measured` levels (`bbc-color-map`) |
| SAA5050 upscaler | ✅ | When the display scaling mode is the SAA5050 upscaler, Mode 7 is emitted as plain unrounded dots at the 1× layout and the display stage does the rounding |
| Border size | ✅ | None / small / normal; the border is always black and fully rendered, the setting crops it |
| Resolution layout | ✅ | 1× layout at 1× and odd scales; hi-res 512-line layout at even scales from 2× |
| Flashing colours | ◐ | See Known issues |
| SN76489 stereo and filter | ✅ | Sound pane: tone-channel stereo placement and anti-aliasing mode |
| Media persistence | ✅ | `persistMedia` is on: mounted tapes and discs survive a reload |
| Disk sounds and LEDs | ✅ | Shared floppy sound model; drive LEDs show motor, read and write; track and sector tracked per drive |
| Cassette motor, CAPS LOCK and SHIFT LOCK lamps | ✅ | Shown on the on-screen keyboard |
| Hardware scroll wrap | ✅ | The IC32 C0/C1 outputs select the address wrap amount applied when the display address passes the top of RAM |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | Shared 6502 debug service ([`src/debug/m6502/`](../../src/debug/m6502/)): A, X, Y, P, SP, PC, flags N V D I Z C; memory watchpoints (read, write or either; the frame stops after the accessing instruction); step into, step over (JSR), step out; 6502 disassembly. The memory pane shows RAM as two 16 KB banks. The banks, system-variables and font panes are hidden |
| Trace | ✅ | Full (address, disassembly, registers, cycles and operand context, with interrupt entries marked and tight loops folded) and an I/O tally of the CPU's reads and writes in FC00-FEFF (FRED, JIM and SHEILA) — the shared 6502 trace engine; no ZXTrace, which is a Z80 layout; a trace stops capturing at 500,000 lines |
| Screen OCR / TEXT overlay | ✅ | Mode 7 is read directly from the 40 × 25 teletext bytes (control codes blank, mosaics blank, flash bit dropped); bitmap modes are matched against the MOS font from the OS ROM, including inverse video and multi-colour cells. Overlay blanks the matched cells in the framebuffer |
| BASIC tools | ✅ | BBC BASIC II listing and variables panes read the tokenised program from RAM |
| Software library | ✗ | `library: false` |
| Boot disk helper | ✗ | `bootDisk: false`; disc boot is the automatic SHIFT+BREAK on mount |
| Machine-specific panes | ✅ | On-screen BBC keyboard with function-key strip, working BREAK key and lamps; Hardware-pane Disk system selector; Display-pane colour map; Sound-pane stereo and filter controls |
| MCP tools | ✅ | Generic: `run`, `step`, `step_frame`, `continue`, `registers`, `set_register`, `read_memory`, `write_memory`, `find`, `disassemble`, `breakpoint`, `delete_breakpoint`, `memory_watchpoint`, `delete_memory_watchpoint`, `symbols`, `symbols_load`, `key`, `type`, `ocr`, `screenshot`, `load` (`.ssd/.dsd/.img` disks and `.uef/.csw` tapes), `eject` (tape or disk), `model`. `port_in` and `port_out` report that the machine has no I/O port space (hardware is memory-mapped). `trace` and `stop_trace` work in full and portio modes. The Spectrum- and CPC-specific disk, FDC, Multiface and `frame_trace` tools do not apply, and `save` (SZX snapshot) is Spectrum-only |
| Drive count | ✅ | One or two drives, from **Drive count** in drive 0's options menu; saved, rebuilds the machine. With one drive the 8271 reports drive 1 neither ready nor at track 0 (as the DFS expects), and the 1770 ends a restore on it with a seek error |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| Flashing colours never flash | Modes 0–6 flashing palette entries; Mode 7 when the ULA flash bit is set | low | `BbcVideo.flashPhase` is documented as "toggled every ~32 frames" but is only ever assigned `false` (in `bbc-video.ts`), so the flash swap in `render()` never takes effect |

## Not emulated

- **Mid-frame raster effects.** The whole picture is rendered once per frame from the video registers at the end of the frame, so palette, mode or screen-start changes made part-way down the frame show for the entire frame.
- **1 MHz bus cycle stretching.** The CPU runs at a flat 2 MHz cycle count with no wait states added for accesses to the 0xFC00–0xFEFF hardware window (the VIAs and disc controller are simply ticked at half the CPU rate).
- **Tube.** The ULA is absent: reads of the Tube window return 0x00 and writes are ignored.
- **Econet.** 0xFEA0–0xFEBF reads 0xFF and writes are ignored; DNFS therefore runs as plain DFS.
- **Speech processor.** The IC32 latch outputs that would select it are ignored.
- **User port and printer port.** The User VIA's port A and B inputs are tied high; nothing is connected to the printer or user port, and the User VIA is not wired to any host device.
- **RS423 serial port.** Nothing is received and transmitted bytes go nowhere; only the cassette selection of the ACIA is connected.
- **Sideways RAM and ROM writes.** Writes to 0x8000–0xFFFF ROM areas are ignored; there is no writeable sideways RAM.
- **Mice, cartridges and snapshots.** None are offered for this machine.
- **ADC conversion noise.** A converted value is the stick's position exactly; a real uPD7002 jitters in its low bits.
- **Tape sound.** The cassette signal is not played through the speaker.
- **Other Model B variants.** Only the Model B (32 KB) is registered; no B+, Master, or 16 KB Model A.
- **8271 and WD1770 at bitstream level.** Both controllers are functional models working on sectors; there are no flux, HFE or SCP disc formats, and copy-protected discs that depend on raw track layout are not supported.

## Faithful quirks

- **Unfitted Tube reads 0x00.** The MOS presence test reads the Tube ULA and requires bit 0 clear, so an absent Tube reads 0x00 rather than the 0xFF of other unclaimed addresses.
- **1770 drive-control latch reads 0xFF.** It is a write-only register, and the DFS presence probe reads it and requires a bit set, so it must not echo what was written.
- **Video ULA aliasing.** The whole 0xFE20–0xFE2F block mirrors the two ULA registers (Acorn DFS 1.20 probes 0xFE29).
- **8K sideways ROMs mirror.** An 8 KB image such as Acorn DFS 1.20 ignores the socket's A13 line and appears in both halves of the 16 KB window.
- **Mode 7 uses a 312-line interlaced CRTC frame.** The 6845 interlace sync-and-video mode steps the raster address by two, which is how Mode 7 keeps a 50 Hz frame and its VSYNC interrupt.
- **Mode 3 and 6 character rows have two blank scanlines.** Rows are 10 scanlines tall and the last two are blanked by the ULA.
- **NMOS decimal-mode Z flag.** Z is taken from the binary result, as on the original 6502.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| [`tests/bbc.test.ts`](../../tests/bbc.test.ts) — registration with the `m6502` CPU family, memory map (RAM, sideways ROM, OS, write-ignoring ROM windows), two 16 KB RAM banks, boot smoke test, RAM dump export | Tests | — |
| [`tests/bbc-hardware.test.ts`](../../tests/bbc-hardware.test.ts) — SAA5050 alpha and mosaics, sheila IO decode, ROMSEL, IC32 latch, keyboard matrix, option links and CA2, sound strobe, Mode 7 half-line blending, scale-dependent layout, bitmap mode pixel unpacking, ULA palette decode | Tests | — |
| [`tests/bbc-dfs.test.ts`](../../tests/bbc-dfs.test.ts) — SSD/DSD parse and serialize round trip, 1770 and 8271 register access through the memory bus, drive and ROM socket exposure, NMI handshake per byte | Tests | — |
| [`tests/i8271.test.ts`](../../tests/i8271.test.ts) — 8271 registers, read and write commands, errors (not found, not ready, write-protected), interrupt, format | Tests | — |
| [`tests/bbc-tape.test.ts`](../../tests/bbc-tape.test.ts) — motor-gated tape, carrier detect, ordered byte delivery at 1200 baud, recording to UEF, RS423 ignores recording; SAVE then LOAD/LIST/RUN round trip on the real OS and BASIC ROMs (skipped when the cached ROMs are absent) | Tests | — |
| [`tests/bbc-joystick.test.ts`](../../tests/bbc-joystick.test.ts) — uPD7002 register layout and 4 ms / 10 ms conversion times from the data sheet, CB1 end-of-conversion edge, channel and fire-button wiring, proportional input; ADVAL(0), (1), (2) and (4) through MOS 1.20's OSBYTE 128 on the real ROMs (skipped when the cached ROMs are absent) | Tests | — |
| [`tests/bbc-ocr.test.ts`](../../tests/bbc-ocr.test.ts) — Mode 7 text read-back, overlay masks and framebuffer blanking, bitmap-mode OCR against the MOS font, BASIC listing provider | Tests | — |
| [`tests/cores/crtc-6845-interlace.test.ts`](../../tests/cores/crtc-6845-interlace.test.ts) — 312-line frames with the Mode 7 and Mode 0 register sets | Tests | — |
| [`tests/tape/uef.test.ts`](../../tests/tape/uef.test.ts) — UEF codec, 300 baud, gzip, recorder, UEF to demodulator round trip, UEF/CSW choice by content | Tests | — |
| Oracle or real-media results | No recorded reference results. | — |
