# Oric-1 / Oric Atmos

Tangerine's 6502 machines: a 1 MHz CPU, one custom chip doing all of the video
and the memory decode, a 6522 VIA joining the keyboard, the sound chip and the
cassette, and a passive keyboard with no encoder. zx84 emulates the Oric-1 and
the Atmos, including the Atmos's full attribute set, hires and mixed screens,
and the Microdisc floppy interface with its boot EPROM.

| | |
| --- | --- |
| **Manufacturer** | Tangerine Computer Systems |
| **Released** | 1983 (Oric-1), 1984 (Atmos) |
| **CPU** | MOS 6502A at 1 MHz |
| **zx84 kind** | `oric` — [`src/machines/oric/`](../../src/machines/oric/) |
| **Model ids** | `atmos`, `oric1` |
| **Accuracy** | frame (the ULA re-reads the whole 240x224 picture from memory each field) |
| **Status** | Working: boots BASIC 1.1 and 1.0, full keyboard, text/hires/mixed screens, PSG sound, cassette, Microdisc + `.dsk`, BASIC listing, snapshots, OCR. SAVE-to-tape decoding is not yet implemented (see Known issues). |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Oric Atmos (`atmos`) | 1984 | 48K + 16K overlay | 16K BASIC 1.1b | ULA HCS10017, 240x224 | AY-3-8912 | cassette, Microdisc | 58 keys (adds Funct) |
| Oric-1 (`oric1`) | 1983 | 48K + 16K overlay | 16K BASIC 1.0 | ULA HCS10017, 240x224 | AY-3-8912 | cassette, Microdisc | 57 keys |

### ROM sets

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| `atmos` | uk | one 16K image | hosted (`oric/basic11b.rom`, CRC `c3a92bef`) |
| `oric1` | uk | one 16K image | hosted (`oric/basic10.rom`, SHA1 `333116e6…`) |
| Microdisc | — | one 8K EPROM | hosted (`oric/microdis.rom`) |

The two BASIC images are told apart by the banner they contain. A dropped 16K
file that is not one of them is refused rather than booted into nonsense.

---

## Built-in hardware

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| 6502A | all | ✅ | 1 MHz, asymmetric clock; `src/cores/m6502.ts` |
| ULA HCS10017 | all | ✅ | Video, memory decode, clock generation. Custom silicon, so it lives in `oric/oric-ula.ts` |
| 6522 VIA | all | ✅ | Keyboard row select, PSG bus, cassette and printer lines. Timer 1 is the ROM's 100 Hz interrupt |
| AY-3-8912 | all | ✅ | Behind VIA port A, selected by the CA2/CB2 output levels; three tone channels, noise, envelope |
| Keyboard | all | ✅ | Passive 8x8 matrix: row on VIA PB0-PB2, column through PSG port A, sense on PB3 |
| Cassette | all | ◐ | 2400/1200 Hz FSK on PB6/PB7/CB1. Loading works; SAVE decoding is not yet implemented |
| Microdisc | fitted | ✅ | WD1793 at `$0310`, control latch at `$0314`, DRQ at `$0318`, 8K boot EPROM |

### Memory map

| Range | Contents |
| --- | --- |
| `$0000–$02FF` | Zero page, stack, BASIC's system variables |
| `$0300–$03FF` | I/O: the VIA, mirrored across the page; the Microdisc takes `$0310–$031B` |
| `$0400–$04FF` | Spare; the disk system's page |
| `$0500–$97FF` | BASIC program, variables and free RAM |
| `$9800–$9FFF` | Character set, hires copy |
| `$A000–$BFDF` | Hires screen (and the text screen at `$BB80`) |
| `$B400–$BBFF` | Character set, text copy |
| `$C000–$FFFF` | BASIC ROM — or the 16K overlay RAM, or the Microdisc EPROM at `$E000` |

---

## Peripherals

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| Microdisc | disk | both | ✅ | Hardware-pane setting; four WD1793 drives A:–D: |
| Centronics printer | output | both | ✗ | Shares VIA port A with the PSG |
| RS-232 / Minitel | comms | both | ✗ | Add-on cards; the Telestrat has one built in |

**Combination rules:** the Microdisc is a single add-on. Fitting it changes the
memory map, so the machine rebuilds when the setting changes.

---

## Media formats

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.tap` | tape | cassette deck | ✅ | ✗ | Leader/sync/9-byte header/NUL-terminated name/payload. Also a Spectrum extension; the signature decides |
| `.dsk` | disk | Microdisc | ✅ | ✅ | `MFM_DISK` and `ORICDISK` containers, told apart by signature. Saved as `ORICDISK` |
| `.txt`, `.bas` | listing | keyboard | ✅ | — | Typed in at a readable pace |
| `.oricstate` | snapshot | — | ✅ | ✅ | zx84's native container |

**Save menu exports:** snapshot, saved tape, screenshot, RAM dump.

---

## Emulation features

| Feature | Status | Notes |
| --- | --- | --- |
| Text mode | ✅ | 40x28, six-pixel cells, in-line serial attributes |
| Hires mode | ✅ | 240x200, six bits a byte from `$A000`; never reads the charsets |
| Mixed text/hires | ✅ | The ULA forces text from line 200, reading `$BF68` onward |
| Serial attributes | ✅ | Ink, paper, style (alternate charset, double height, blink) and mode |
| Double height | ✅ | Each glyph scanline covers two displayed lines; the ROM's odd-line quirk is reproduced |
| Blink | ✅ | The ULA's own 64-field clock |
| 50/60 Hz select | ✅ | Mode-register bit 1; the frame really runs 260 lines at 60 Hz against 312 |
| Light pen | ✗ | |
| Fast tape loading | ✗ | The tape plays at the ROM's own pace |
| On-screen keyboard | ✅ | Five rows, 58 caps. Black character keys and orange control caps (ESC, CTRL, both SHIFTs, DEL, RETURN, the four arrows, FUNCT), the orange caps bracketing the letter block as on the machine. No CAPS key: the Atmos has none, and uppercase is CTRL-T |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | ✅ | 6502 family substrate, shared with the other 6502 machines |
| Trace | ✅ | Full and port-IO modes; the I/O labels name the VIA's registers |
| Memory layout | ✅ | ROM / overlay / EPROM, and the page-3 block |
| BASIC listing | ✅ | Detokenised from the record chain; the keyword table is read from the resident ROM |
| BASIC variables | ◐ | Reports the allocation map (program/variables/arrays/strings), not decoded variable values |
| Chip dump | ✅ | ULA, VIA, PSG and the memory select |
| Screen OCR / TEXT overlay | ✅ | The flat 40x28 text screen |
| Software library | ✗ | |
| Machine-specific panes | ✅ | Hardware section (Microdisc), on-screen keyboard |
| MCP tools | ✅ | The generic set, plus `ocr` and `screenshot` through the services |

---

## Known issues

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| SAVE-to-tape is not decoded | cassette | medium | The recording is captured correctly — the ROM's `CSAVE` really does drive PB7 through the VIA's timer and the two half-cycle populations are clean (~209 and ~417 cycles at 1 MHz) — but the bit framing across those tones is not yet established, so the export reports "nothing saved" rather than writing a corrupt `.tap`. `tests/oric-tape.test.ts` pins the measured lengths as the starting evidence. |
| BASIC variable *values* are not decoded | BASIC pane | low | The numeric/string/array slot layouts differ between BASIC revisions; the allocation map is exact and is what is shown. |
| Error: the DOS stops after its banner | Microdisc | medium | A Sedoric disk prints `SEDORIC V3.0` and then the CPU runs `BRK` at `$D0A5` in overlay RAM. Every sector the boot asks for is served correctly, so the disk path works and the second stage is not landing where the DOS expects it. See the Real media notes above. |
| Printer port is inert | printer | low | Centronics output is not captured |

## Not emulated

- **Jasmin** (WD1773 at `$03F4`, 2K EPROM at `$F800`, interrupt-driven) and the
  **BD-500** controller.
- **Telestrat** — a second VIA, eight memory banks, a 6551 ACIA and two
  cartridge slots; a different machine in the same family.
- **Pravetz 8D** — a Bulgarian Atmos clone with an Apple II disk interface.
- **Light pen**, **RS-232 / Minitel**, the Centronics printer, and the CH376 USB
  stick.
- **NTSC**: the Oric is a PAL machine. The ULA's own 50/60 Hz attribute is
  honoured; there is no NTSC ROM.

## Faithful quirks

- **Double height is screen-aligned, not text-aligned.** Each glyph scanline
  covers two displayed lines and the halving starts from the screen, so a
  double-height block beginning on an odd line shows its bottom half above its
  top half. This is the ROM's documented behaviour; software written around it
  would break if it were "fixed".
- **A serial attribute takes a cell of its own.** The ULA draws it in the paper
  colour, so changing the paper visibly affects the cell the attribute is in.
- **Reading the WD1793 status clears INTRQ.** The Microdisc ROM polls `$0314`
  instead, which is why the latch's read side is part of its contract.
- **`$C000` is three different things.** Which one depends on the ROMDIS and
  EPROM-select bits of the Microdisc latch, so a program can swap its own ROM  out for RAM.
- **The Oric-1's BASIC 1.0 has two token names the Atmos does not**: `STORE` and
  `RECALL` are `INVERSE` and `NORMAL` on the earlier machine. The token table is
  read from whichever ROM is running, so each gets its own names.

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| `tests/oric.test.ts` | boots BASIC 1.1 to `37631 BYTES FREE`, types `PRINT "HELLO"` and `PRINT 6*7` (→ `42`) | 2026-11-22 |
| `tests/oric-basic.test.ts` | token table pinned against POKE/PRINT/FOR; typed program reads back detokenised | 2026-11-22 |
| `tests/oric-sound-keyboard.test.ts` | the ROM's `PING` reaches the PSG and produces a waveform; the on-screen deck draws the 58 Atmos caps in QWERTY order with no overlaps, orange control caps at the edges, and no CAPS key | 2026-11-23 |
| `tests/oric-tape.test.ts` | `.tap` codec round-trips; the ROM's `CSAVE` measured at 2400/1200 Hz | 2026-11-22 |
| `tests/oric-disk.test.ts` | both `.dsk` containers; the latch flips the memory map; a disk mounts and saves | 2026-11-22 |
| `tests/oric-memory-psg.test.ts` | the ROM/overlay/EPROM windows, and the PSG's four BDIR/BC1 bus cycles | 2026-11-22 |
| `tests/oric-real-media.test.ts` | seven published `.dsk` images, plus Sedoric 2.1/3.0 and OricDOS booting a Microdisc | 2026-11-22 |

### Real media

`tests/oric-real-media.test.ts` reads actual `.dsk` files from the Oric community
(`sembiance.com`'s file-format samples and the official Sedoric 3 system disk):

| Image | Container | Boots to |
| --- | --- | --- |
| `SEDORIC3.DSK` | `MFM_DISK` 42×2 | `SEDORIC V3.0` / `© 1985 ORIC INTERNATIONAL` |
| `BuggyBoy.dsk` | `MFM_DISK` 42×2 | `SEDORIC V3.0` |
| `barbitoric.dsk` | `MFM_DISK` 42×2 | hires demo, no text |
| `ANIM.DSK` | `MFM_DISK` 80×2 | `SEDORIC V2.1` |
| `MINISED2.DSK` | `MFM_DISK` 44×1 | `SEDORIC V2.1` |
| `oricdos.dsk` | `MFM_DISK` 80×2 | `ORIC EXTENDED BASIC V1.1` (no DOS) |
| `xenon1.new.dsk` / `.old.dsk` | both | `SEDORIC V3.0`; the pair decodes byte-identically |

That cross-check is the strongest evidence the container codecs are right: the
same disk published in both formats yields **357 identical sectors**.

Booting them found two bugs no hand-built fixture could have:

1. **`MFM_DISK` tracks are the decoded byte stream, not MFM cells.** Feeding
   them to the HFE cell decoder yields zero sectors, because the `00 00 00 A1 A1
   A1 FE` ID fields only make sense as bytes.
2. **The card's latch was not re-applied after a reset**, so a boot wrote the
   latch and then read from a drive the controller did not have selected — which
   presents as "insert system disc" with the disk in place.

### Known limitation: the DOS stops after its banner

A Sedoric disk gets as far as printing `SEDORIC V3.0`, then the CPU ends up
executing `BRK` at `$D0A5` in overlay RAM. The controller serves every sector it
is asked for (`status $03` on all thirteen read commands, 12 sectors of data), so
the disk path works; the second stage is not being placed where the DOS expects.
Until that is understood the machine is documented as booting a disk's *banner*
rather than its DOS prompt.
