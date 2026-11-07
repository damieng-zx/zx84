# Acorn BBC Micro

Acorn's 6502 home and school computer, commissioned for the BBC's Computer
Literacy Project. zx84 emulates the Model B with 32 KB of RAM and the Model A
with 16 KB, the MOS and BBC BASIC ROMs, sixteen sideways ROM sockets (any of
which can be fitted with writeable sideways RAM), Modes 0–6 and Mode 7
teletext, the SN76489 sound chip, cassette, the parallel printer and RS423
serial ports, and either of the two period disc interfaces (Intel 8271 or
WD1770 Acorn DFS). The CPU is held for every access to the 1 MHz bus, as on
the real machine.

| | |
| --- | --- |
| **Manufacturer** | Acorn Computers |
| **Released** | 1981 |
| **CPU** | MOS 6502 — 2 MHz |
| **zx84 kind** | `bbc` — [`src/machines/bbc/`](../../src/machines/bbc/) |
| **Model ids** | `bbc-b`, `bbc-a` — the MCP `model` target and the `?model=` value (case-insensitive: `?model=BBC-B` works) |
| **Accuracy** | Instruction-stepped 6502 with a running cycle count, stretched by the 1 MHz bus (see below); 6845 CRTC advanced per scanline; the Display pane's Accuracy setting draws the picture as the beam goes (High, to the character), a scanline at a time (Mid) or once at the end of the frame (Low) |
| **Status** | Boots the OS 1.20 and BASIC II ROMs to BBC BASIC on both models; keyboard, sound, tape (load and save), both disc interfaces, sideways RAM, the printer port and RS423 are covered by tests |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Model A (`bbc-a`) | 1981 | 16 KB (0x0000–0x3FFF, mirrored at 0x4000–0x7FFF) | 16 KB OS + 16 KB BASIC, 16 sideways sockets | as the Model B | as the Model B | Cassette; a disc interface can be fitted as on the B | No User VIA, analogue port or RS423 line drivers (below) |
| Model B (`bbc-b`) | 1981 | 32 KB (0x0000–0x7FFF) | 16 KB OS + 16 KB BASIC, 16 sideways sockets | 6845 CRTC + Video ULA (Modes 0–6), SAA5050 teletext (Mode 7) | SN76489 (3 tone + noise) | Cassette (UEF, CSW); 5.25" DFS drives 0 and 1 via 8271 or WD1770 interface | 312 lines × 50 Hz = 40,000 CPU cycles per frame at 2 MHz |

**Model A.** The Model A has 16 KB of RAM at 0x0000–0x3FFF. The RAM array does
not decode address line A14, so the same 16 KB also answers at 0x4000–0x7FFF
(a write to one is seen at the other; the MOS 1.20 boots to `BBC Computer 16K`
with HIMEM at &3C00 in Mode 7). The User VIA (user port and printer port) and
the uPD7002 analogue port are not fitted: their windows float high (0xFF),
writes are ignored, and there is no joystick pane, printer capture or RS423.
The cassette interface (ACIA and serial ULA) is fitted. It uses the same OS and
BASIC ROMs. A Model B+ and the Master 128 are not offered (see Not emulated).

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
| Memory map | all | ✅ | RAM below 0x8000 (16 KB mirrored on the Model A); sideways ROM or RAM at 0x8000–0xBFFF selected by the ROMSEL latch, which is write-only, decoded across 0xFE30–0xFE3F and latches the low four bits; OS ROM above 0xC000; hardware window 0xFC00–0xFEFF. Writes to ROM are ignored |
| 1 MHz bus | all | ✅ | Every access to 0xFC00–0xFEFF (FRED, JIM and SHEILA: VIAs, ACIA, CRTC, ULAs, ADC, disc controller, Econet and Tube windows, and the unclaimed parts of those pages) holds the 2 MHz CPU until the 1 MHz clock catches up ([`bus-timing.ts`](../../src/machines/bbc/bus-timing.ts)). An access that begins on a cycle in phase with the 1 MHz clock (an even CPU cycle) takes one extra cycle; one that begins half a 1 MHz cycle out (an odd cycle) waits for the edge and then takes two; either way it ends in phase. The cycle of the instruction the access falls on is worked out from the opcode (a load or store on its last cycle, a read-modify-write's read two before the end, an indexed read's page-crossing cycle before the read). A read-modify-write on the bus also writes the old value back first: a second held access and a second write to the device. The VIAs, disc controller, ADC, tape and sound all run on the stretched time. Chips are still brought up to date once per instruction, not at the cycle of the access, so a register read sees timers as they stood when the instruction ended |
| Sideways RAM | all | ✅ | Any of the sixteen sockets can be fitted with 16 KB of writeable RAM, the way a RAM board in the ROM sockets works: writes to 0x8000–0xBFFF land in it while the ROM select latch names it. The Hardware pane offers banks 0–3, 4–7 and 8–11 (12–15 hold BASIC and the DFS); the choice is saved and rebuilds the machine. Contents survive BREAK, are blank after a rebuild, and are in the `.bbcstate`. A ROM image loaded into the socket from the ROM pane fills the RAM and is re-applied at every rebuild. No battery backup; not the Master's ANDY/HAZEL or the B+'s 12 KB |
| 6845 CRTC | all | ✅ | [`crtc-6845.ts`](../../src/cores/crtc-6845.ts); per-scanline stepping, interlace sync-and-video (needed for Mode 7's 312-line frame), VSYNC drives System VIA CA1 |
| Video ULA | all | ✅ | Control register at 0xFE20 and palette at 0xFE21; the whole 0xFE20–0xFE2F block aliases to those two registers. Logical-to-physical palette, 8 physical colours |
| SAA5050 teletext | all | ✅ | [`saa5050.ts`](../../src/cores/saa5050.ts); Mode 7 only; colour state reset each field |
| System VIA and User VIA (6522) | all | ✅ | [`m6522.ts`](../../src/cores/m6522.ts), ticked at 1 MHz. System VIA: 50 Hz VSYNC on CA1, Timer 1 as the 100 Hz clock, keyboard, sound bus, IC32 latch. User VIA (Model B only): port A is the printer data bus, CA2 the printer strobe and CA1 its acknowledge (below); the user port on port B and CB1/CB2 have nothing attached and read high |
| Parallel printer port | `bbc-b` | ✅ | [`printer-port.ts`](../../src/machines/bbc/peripherals/printer-port.ts). Data bits on User VIA port A (bits the VIA does not drive float high), /STROBE on CA2, /ACKNOWLEDGE on CA1; the connector has no BUSY line. The printer takes the byte as /STROBE falls (from the 6522's handshake or pulse output mode on a write to port A, or from PCR set by hand to CA2 low) and acknowledges 100 µs later with an 8 µs pulse on CA1, which interrupts the MOS and, in handshake mode, releases CA2. Everything printed is kept (4 MB at most) and downloaded from the Save menu as `bbc-printer.txt`, with CR, LF and CR LF as line breaks. No IC32 latch output belongs to the printer, so the latch plays no part. The captured text is not part of a `.bbcstate` |
| IC32 addressable latch | all | ◐ | Sound write strobe, keyboard auto-scan enable, screen-wrap C0/C1 (hardware scroll address wrap), CAPS LOCK and SHIFT LOCK lamps. Speech-processor outputs (latch bits 1–2) are ignored |
| SN76489 sound | all | ✅ | [`sn76489.ts`](../../src/cores/sn76489.ts), 4 MHz clock, TI 15-bit noise variant; reached through the System VIA slow data bus. Optional stereo placement of the three tone channels |
| Keyboard matrix | all | ✅ | Host keys mapped by produced character (so BBC shifted symbols type correctly) or by physical position; SHIFT is matrix cell (0,0) |
| Keyboard option links | all | ◐ | Modelled as row-0 matrix bits that the MOS reads at power-on. None are fitted by default, giving the standard Model B start-up (Mode 7, SHIFT+BREAK boots the disc). There is no control for changing them |
| 6850 ACIA + serial ULA | all | ✅ | [`mc6850.ts`](../../src/cores/mc6850.ts); serial ULA at 0xFE10 (baud rates, motor relay, and bit 6: cassette or RS423 for the ACIA) |
| RS423 serial port | `bbc-b` | ◐ | [`rs423-port.ts`](../../src/machines/bbc/peripherals/rs423-port.ts). With RS423 selected, bytes the ACIA transmits (at the rate the ULA and ACIA are set to) are kept for download (Hardware pane), and text typed into the Hardware pane's "RS423 in" box is sent to the ACIA's receive line as 8N1, back to back, at the receive rate, so RDRF, overrun, framing and the receive interrupt behave as on a cable. Through the MOS: `*FX7`/`*FX8` set the rates, `*FX2,1` takes BASIC input from the host, `*FX5,2` sends VDU 2 printing to it. RTS, CTS and DCD are not wired to a host, so there is no flow control: a long paste can overrun the MOS's 256-byte input buffer. A frame that is in flight is part of a `.bbcstate`; the downloaded bytes are not |
| Cassette interface | all | ✅ | Pulse-level playback through an FSK demodulator into the ACIA, 1200 and 300 baud; motor relay moves the tape; what the OS writes to the ACIA is recorded |
| Disc controller | all | ✅ | Intel 8271 or WD1770, or none (see Peripherals). Floppy window 0xFE80–0xFE87; interrupt output on the CPU NMI line |
| Floppy drives | all | ✅ | Two DFS drives (0 and 1), 5.25" (drive sounds use the 5.25" profile), 40 or 80 tracks, one or two sides; write-protect per drive |
| uPD7002 ADC (analogue port) | all | ✅ | [`upd7002.ts`](../../src/machines/bbc/peripherals/upd7002.ts) at 0xFEC0–0xFEDF (repeating every four bytes): channel/flag/precision write, status (/EOC, /BUSY, top two result bits), result high and low bytes. A conversion takes 4 ms (8-bit) or 10 ms (12-bit); end of conversion is a falling edge on System VIA CB1, the MOS's ADC interrupt |
| Joystick fire buttons | all | ✅ | System VIA PB4 (joystick 1) and PB5 (joystick 2), low while pressed |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Acorn DFS, Intel 8271 | disk | `bbc-b` | ✅ | Original interface; single-density command/parameter/result chip ([`i8271.ts`](../../src/cores/i8271.ts)) mapped at 0xFE80–0xFE84. Functional model on decoded sectors: reads single-density (FM) tracks only; a read stops at a deleted-data mark with "deleted data found" (result bit 5) or at a bad data CRC with 0x0E; WRITE DELETED DATA lays a deleted mark down; a weak sector (from SCP or HFE v3) reads one of its recorded readings |
| Acorn 1770 DFS, WD1770 | disk | `bbc-b` | ✅ | Later upgrade ([`wd179x.ts`](../../src/cores/wd179x.ts) base). Registers at 0xFE84–0xFE87 with a write-only drive-control latch at 0xFE80 (drive select, side, density, reset). Latch bit 3 selects single density; a track recorded in the other density reads as unformatted. Default |
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

ZIP archives are unpacked and their contents routed as below. HFE and SCP disks
are recognised by their signature whatever the file is called; other disks by
extension. For tapes the content decides (a UEF signature or gzip wrapper is
UEF, anything else is tried as CSW).

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.ssd` | Disk | DFS drive 0 (or 1) | ✅ | ✅ | Single-sided raw sector dump (10 × 256-byte sectors per track). Truncated images are padded to 40 or 80 tracks per the catalogue |
| `.dsd` | Disk | DFS drive 0 (or 1) | ✅ | ✅ | Double-sided, sides interleaved per track |
| `.img` | Disk | DFS drive 0 (or 1) | ✅ | ✅ | Treated as double-sided when larger than 204,800 bytes, otherwise single-sided; saved back as `.ssd` or `.dsd` |
| `.hfe` | Disk | DFS drive 0 (or 1) | ✅ | ✅ | HFE v1 or v3 bitstream, decoded track by track. Keeps deleted-data marks, CRC errors, odd sector IDs and sizes, and duplicate IDs; v3 weak bytes become weak sectors. Saved back as `.hfe` (v1), only written sectors re-encoded. A disc with no single-density track is refused, as the DFS cannot read it |
| `.scp` | Disk | DFS drive 0 (or 1) | ✅ | ◐ | SuperCard Pro flux, decoded at load; a sector that reads differently across revolutions is weak. Saved as `.ssd`/`.dsd` when its layout is plain DFS, otherwise as `.hfe` |
| `.uef` | Tape | Tape deck | ✅ | ✅ | Gzip-wrapped UEF also accepted. Save is whatever the OS wrote to the cassette port |
| `.csw` | Tape | Tape deck | ✅ | ✗ | Sampled tape |
| `.bbcstate` | Snapshot | Machine | ✅ | ✅ | zx84's own exact save state (see below) |

Loading a disk into drive 0 resets the machine and holds SHIFT (SHIFT+BREAK) so
the DFS auto-boots it; drive 1 is mounted without a reset. A tape is mounted
with play armed and waits for `*TAPE` then `CHAIN""` (or `*RUN`). Blank discs can be created in the Drives pane as `.ssd`
(100K SS/40T, 200K SS/80T) or `.dsd` (200K DS/40T, 400K DS/80T). A disc whose
layout a sector dump cannot hold (a protection track, deleted-data or bad-CRC
sectors) is saved as `.hfe` instead of `.ssd`, so nothing on it is lost.

**Snapshots.** `.bbcstate` is zx84's native save state, in the same container as the Atari's `.a8state` (a CRC-32 and length checked before the machine is touched, deflated when saved from the Save menu), magic
`ZXBB`: the 6502 (with the one-instruction IRQ lag after CLI/SEI/PLP), the
32 KB of RAM and the ROM select latch, the 6845's registers and raster
counters, the video ULA's control and palette, the IC32 latch, both 6522 VIAs
(timers mid-count, handshake lines), the SN76489's generators, the 6850 ACIA
and serial ULA with a byte half received or held for sending, the cassette
relay, tone demodulator and what has been recorded, the uPD7002 ADC with a
conversion in progress and the joysticks as held, the beam's frame grid, the printer port's lines and a pending
acknowledge, an RS423 frame being sent to the ACIA, the sideways RAM, and
the fitted disc controller (8271 or 1770) down to a transfer in flight. States
from before the printer, RS423 and sideways RAM were modelled load with those
idle and no sideways RAM. A file
saved from the Save menu also carries the discs (exactly as the controller
sees them, writes included, with names and write-protect tabs) and the tape
with the deck's position to the cycle. The header records the CRCs of the OS
and all sixteen sideways sockets (a mismatch loads with a warning; a socket fitted with RAM counts as empty); a state
saved with another disc interface or drive count is refused until the
Hardware or Drives pane matches (the same for sideways RAM: which sockets are
RAM and their contents are in the state, in sections early in the file so a
mismatch is refused before anything changes; their contents are not counted as
firmware in the ROM CRCs). A state is taken between frames (a frame a
debugger stop left open is run to its end first), and restores cycle for
cycle. The same state without the media backs browser-refresh resume; the
shell then remounts the persisted discs without a SHIFT+BREAK or a head move,
and the tape from its start.

**Save menu exports:** Snapshot `.bbcstate`, recorded tape (`.uef`, offered as `bbc-tape.uef`), PNG
screenshot, RAM `.bin` (32 KB, `bbc-b-ram-32k.bin`; 16 KB on the Model A) and, on the
Model B, the printer output as text (`bbc-printer.txt`). Disks are saved from the
Drives pane; RS423 output from the Hardware pane.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Tape turbo | ✅ | Runs flat out while the tape is being read, staying engaged across inter-block gaps; the "Turbo while loading" option in the Drives pane (`tape-turbo-load`, on by default) disables it. Not a ROM trap |
| Tape sound | ✗ | Not offered, because the hardware does not do it: the cassette input and output go only to the DIN socket and the serial ULA, and the sound amplifier is fed from the SN76489 alone, so the tape signal is never heard from the machine's own speaker (only an external recorder's speaker plays it). Descriptor sets `tapeSound: false` |
| Tape transport | ✅ | A mounted tape is armed to play and only moves while the OS switches the cassette motor relay on; play, pause, stop, rewind and seek by block are available |
| Tape recording | ✅ | `SAVE` to tape is captured and exported as UEF; verified by a SAVE then LOAD round trip in the tests |
| Palette family | ✅ | Display pane: fully saturated `pal`, or muted `measured` levels (`bbc-color-map`) |
| SAA5050 upscaler | ✅ | When the display scaling mode is the SAA5050 upscaler, Mode 7 is emitted as plain unrounded dots at the 1× layout and the display stage does the rounding |
| Border size | ✅ | None / small / normal; the border is always black and fully rendered, the setting crops it |
| Resolution layout | ✅ | 1× layout at 1× and odd scales; hi-res 512-line layout at even scales from 2× |
| Flashing colours | ✅ | Logical colours 8–15 flash between a colour and its inverse. The MOS toggles bit 0 of the Video ULA control register on its flash timer; the renderer swaps the flashing entries whenever it is set |
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
| MCP tools | ✅ | Generic: `run`, `step`, `step_frame`, `continue`, `registers`, `set_register`, `read_memory`, `write_memory`, `find`, `disassemble`, `breakpoint`, `delete_breakpoint`, `memory_watchpoint`, `delete_memory_watchpoint`, `symbols`, `symbols_load`, `key`, `type`, `ocr`, `screenshot`, `load` (`.ssd/.dsd/.img/.hfe/.scp` disks and `.uef/.csw` tapes), `eject` (tape or disk), `model`. `port_in` and `port_out` report that the machine has no I/O port space (hardware is memory-mapped). `trace` and `stop_trace` work in full and portio modes. The Spectrum- and CPC-specific disk, FDC, Multiface and `frame_trace` tools do not apply, and `save` (SZX snapshot) is Spectrum-only |
| Drive count | ✅ | One or two drives, from **Drive count** in drive 0's options menu; saved, rebuilds the machine. With one drive the 8271 reports drive 1 neither ready nor at track 0 (as the DFS expects), and the 1770 ends a restore on it with a seek error |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| Chips are brought up to date once per instruction | A VIA, ADC or disc register read inside a 1 MHz-bus instruction | low | The CPU's wait for the 1 MHz bus is exact, but the chips are advanced after each instruction, so a read of a timer sees the count at the instruction's end rather than at the cycle of the access (a one-to-few 1 MHz count difference). The read-modify-write dummy write does reach the device |
| No RS423 flow control | Long host pastes over RS423 | low | RTS/CTS are not wired to the host; pasted text faster than the program drains the MOS's 256-byte buffer is lost |

## Not emulated

- **Tube.** The ULA is absent: reads of the Tube window return 0x00 and writes are ignored.
- **Econet.** 0xFEA0–0xFEBF reads 0xFF and writes are ignored; DNFS therefore runs as plain DFS.
- **Speech processor.** The IC32 latch outputs that would select it are ignored.
- **User port.** User VIA port B and CB1/CB2 have nothing attached (inputs read high); only the printer port on port A/CA1/CA2 is wired.
- **Other models.** The Model B+ 64K is not offered: its shadow RAM and ROM selection need the B+ OS ROM (OS 2.00), which is not on the ROM host (`bbc/`). No Master 128 / Compact. The Model A is registered (16 KB, mirrored).
- **Mice and cartridges.** None are offered for this machine.
- **Snapshots from other emulators.** Only zx84's own `.bbcstate` is read and
  written (not BeebEm's `.uefstate` or b2's states). Keys held on the host are
  not part of a state, and a disc transfer in flight when a refresh copy is
  taken loses its place (the drive is empty until the shell remounts it).
- **ADC conversion noise.** A converted value is the stick's position exactly; a real uPD7002 jitters in its low bits.
- **Tape sound.** The BBC does not play the cassette through its speaker, so nothing is offered (see Emulation features).
- **8271 and WD1770 at bitstream level.** Both controllers work on sectors decoded once at load, from HFE and SCP tracks as from sector dumps. Deleted-data marks, CRC errors, odd sector IDs and sizes, duplicate IDs and weak sectors carry over, but protections that time the track itself (gap lengths, where a sector sits relative to the index, sectors spanning both densities) are not reproduced. An ID field with a bad CRC drops its sector, and the 8271's plain READ DATA stops at a deleted mark just as READ DATA AND DELETED DATA does.

## Faithful quirks

- **Unfitted Tube reads 0x00.** The MOS presence test reads the Tube ULA and requires bit 0 clear, so an absent Tube reads 0x00 rather than the 0xFF of other unclaimed addresses.
- **1770 drive-control latch reads 0xFF.** It is a write-only register, and the DFS presence probe reads it and requires a bit set, so it must not echo what was written.
- **ROM select is write-only and four bits wide.** The Model B latches the low nibble of any write in 0xFE30–0xFE3F; bit 7 and the other bits do nothing (the B+ and Master decode more).
- **Model A RAM mirror.** Address line A14 is not decoded by the 16 KB of RAM, so 0x4000–0x7FFF is the same bytes as 0x0000–0x3FFF, which the video circuit sees as well.
- **Sideways RAM keeps its contents across BREAK.** Only the ROM select latch is reset, as on the real board.
- **Printer strobe is a falling edge.** A byte is taken as /STROBE goes low, whether the 6522 pulsed it or software set CA2 by hand; a read of port A in handshake mode strobes too, as the chip does.
- **Read-modify-write on the 1 MHz bus writes twice.** The NMOS 6502 writes the old value back before the new one; to a device that is two writes and two held cycles.
- **Video ULA aliasing.** The whole 0xFE20–0xFE2F block mirrors the two ULA registers (Acorn DFS 1.20 probes 0xFE29).
- **8K sideways ROMs mirror.** An 8 KB image such as Acorn DFS 1.20 ignores the socket's A13 line and appears in both halves of the 16 KB window.
- **Mode 7 uses a 312-line interlaced CRTC frame.** The 6845 interlace sync-and-video mode steps the raster address by two, which is how Mode 7 keeps a 50 Hz frame and its VSYNC interrupt.
- **Mode 3 and 6 character rows have two blank scanlines.** Rows are 10 scanlines tall and the last two are blanked by the ULA.
- **NMOS decimal-mode Z flag.** Z is taken from the binary result, as on the original 6502.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| [`tests/snapshot/bbc-state.test.ts`](../../tests/snapshot/bbc-state.test.ts) — `.bbcstate`: synthetic firmware with a 1770 or 8271 multi-sector read, the tape, a free-running VIA timer, the SN76489, the ADC with sticks held and Mode 1 drawing all in flight; a fresh machine restored from the file matches the original's registers, cycle count, picture and whole state for 40 frames at High, Mid and Low accuracy; damaged files and another disc interface refused with the machine untouched; refresh resume with the disc remounted and no SHIFT+BREAK; a BASIC program on MOS 1.20 (skipped when the cached ROMs are absent) | Tests | — |
| [`tests/bbc.test.ts`](../../tests/bbc.test.ts) — registration with the `m6502` CPU family, memory map (RAM, sideways ROM, OS, write-ignoring ROM windows), two 16 KB RAM banks, boot smoke test, RAM dump export | Tests | — |
| [`tests/bbc-hardware.test.ts`](../../tests/bbc-hardware.test.ts) — SAA5050 alpha and mosaics, sheila IO decode, ROMSEL, IC32 latch, keyboard matrix, option links and CA2, sound strobe, Mode 7 half-line blending, scale-dependent layout, bitmap mode pixel unpacking, ULA palette decode | Tests | — |
| [`tests/bbc-dfs.test.ts`](../../tests/bbc-dfs.test.ts) — SSD/DSD parse and serialize round trip, 1770 and 8271 register access through the memory bus, drive and ROM socket exposure, NMI handshake per byte | Tests | — |
| [`tests/i8271.test.ts`](../../tests/i8271.test.ts) — 8271 registers, read and write commands, errors (not found, not ready, write-protected), interrupt, format | Tests | — |
| [`tests/cores/disc-density.test.ts`](../../tests/cores/disc-density.test.ts) — WD1770 single/double density selection and WRITE TRACK density; 8271 refusing MFM tracks, deleted-data and CRC-error results, WRITE DELETED DATA, weak sectors | Tests | — |
| [`tests/floppy/fm-track.test.ts`](../../tests/floppy/fm-track.test.ts), [`tests/floppy/hfe-v3.test.ts`](../../tests/floppy/hfe-v3.test.ts), [`tests/media/acorn-disc.test.ts`](../../tests/media/acorn-disc.test.ts) — FM track decode/encode from an IBM 3740 encoder written in the test, FM in HFE and SCP, HFE v3 opcodes, Acorn disc sniffing and save formats | Tests | — |
| [`tests/disc-formats-boot.test.ts`](../../tests/disc-formats-boot.test.ts) — a DFS disc made in the test boots identically from `.ssd`, FM `.hfe` (v1 and v3) and `.scp` on both controllers (skipped without the cached MOS, BASIC, DNFS and DFS 2.26 ROMs) | Tests | — |
| [`tests/bbc-tape.test.ts`](../../tests/bbc-tape.test.ts) — motor-gated tape, carrier detect, ordered byte delivery at 1200 baud, recording to UEF, RS423 ignores recording; SAVE then LOAD/LIST/RUN round trip on the real OS and BASIC ROMs (skipped when the cached ROMs are absent) | Tests | — |
| [`tests/bbc-joystick.test.ts`](../../tests/bbc-joystick.test.ts) — uPD7002 register layout and 4 ms / 10 ms conversion times from the data sheet, CB1 end-of-conversion edge, channel and fire-button wiring, proportional input; ADVAL(0), (1), (2) and (4) through MOS 1.20's OSBYTE 128 on the real ROMs (skipped when the cached ROMs are absent) | Tests | — |
| [`tests/bbc-ocr.test.ts`](../../tests/bbc-ocr.test.ts) — Mode 7 text read-back, overlay masks and framebuffer blanking, bitmap-mode OCR against the MOS font, BASIC listing provider | Tests | — |
| [`tests/bbc-accuracy.test.ts`](../../tests/bbc-accuracy.test.ts) — 1 MHz bus: hand-assembled loops against the in-phase (+1) and out-of-phase (+2) hold, derived by hand (LDA &FE40 = 6 cycles from cycle 0, a LDA / DEX / BNE loop settling at 10, INC &FE60 = 10, an indexed read across a page, VIA timer counts); sideways RAM paging, write and read-back, bank independence, ROMSEL decode, BREAK persistence, running code from a RAM bank; Model A mirror and absent User VIA; printer strobe/acknowledge by hand, in handshake and pulse mode, undriven pins and the text export; RS423 transmit, receive with RDRF/IRQ, overrun and the cassette selection; `.bbcstate` of sideways RAM, a refused mismatch, an older state without the new sections, and a printer acknowledge and RS423 frame resumed exactly; through MOS 1.20 and BASIC 2 (skipped without the cached ROMs): the Model A banner and HIMEM, a 24-byte routine paging a RAM bank and reading a byte back (and reading 0 from a ROM socket), `*FX5,1` / `VDU2:PRINT "HELLO":VDU3` captured as `HELLO` CR, `*FX5,2` to RS423, and `*FX2,1` taking `PRINT 6*7` typed by the host. With `ZX84_BBC_RAMUTIL` set to a RAMUtil (D. Walker, 1994) ROM image and the cached 1770 DFS ROM, `*BRLOAD` loads a file from a DFS disc into a sideways RAM bank | Tests | — |
| [`tests/bbc-video-accuracy.test.ts`](../../tests/bbc-video-accuracy.test.ts) — a mid-scanline palette write shows from the character the beam had reached at High, from that scanline at Mid and over the whole frame at Low (the write's cycle includes the 1 MHz-bus hold); a stop mid-scanline leaves the picture as an unbroken run; the ULA flash bit swaps a flashing colour | Tests | — |
| [`tests/cores/crtc-6845-interlace.test.ts`](../../tests/cores/crtc-6845-interlace.test.ts) — 312-line frames with the Mode 7 and Mode 0 register sets | Tests | — |
| [`tests/tape/uef.test.ts`](../../tests/tape/uef.test.ts) — UEF codec, 300 baud, gzip, recorder, UEF to demodulator round trip, UEF/CSW choice by content | Tests | — |
| Oracle or real-media results | No recorded reference results. | — |
