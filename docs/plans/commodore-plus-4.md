# Plan: Commodore Plus/4 (and Commodore 16)

Status: **research done, building.** Worktree `F:/src/zx/zx84-plus4`, branch
`feature/plus4`, cut from `dev` at dc3b3d31. When the machine lands, this file
becomes `docs/machines/commodore-plus-4.md`, written to
[`TEMPLATE.md`](../machines/TEMPLATE.md). Follow
[`docs/adding-a-machine.md`](../adding-a-machine.md) for the definition of done.

Two model ids of one motherboard: `plus4` (64K, the 3+1 function ROMs, the
6551A RS-232 interface) and `c16` (16K, no ACIA, no user port). The C16/116 is a
Plus/4 with less fitted, so it is a model, not a second machine folder.

Hardware statements below come from VICE's `plus4/` sources (read as
documentation, no code copied), the Plus/4 technical reference on
archive.org, the annotated memory maps at zimmers.net and floodgap, and the
TED register reference at oxyron.de.

---

## 1. The machine

| | PAL (`plus4`, locale `uk`) | NTSC (`plus4`, locale `us`) |
| --- | --- | --- |
| CPU | MOS 7501 (a 6510: 6502 + I/O port at `$00`/`$01`) at 1.773447 MHz | 1.789772 MHz |
| Video | MOS 7360 "TED": 40×25 text, multicolour text, hires and multicolour bitmap | same |
| Raster | 114 cycles × 312 lines, 49.8 Hz | 114 cycles × 262 lines, 59.9 Hz |
| RAM | 64K (the C16: 16K, mirrored) | same |
| ROM | BASIC 3.5 (16K), KERNAL (16K), the 3+1 function ROMs (16K × 2), character ROM 8K | same |
| Sound | TED: two square voices + noise, 4-bit volume | same |
| I/O | two 6529B PIOs (the user port and the keyboard lines), 6551A ACIA on the Plus/4 | same |

### Memory map (CPU)

| Range | Contents |
| --- | --- |
| `$0000–$00FF` | the 7501's page: `$00` DDR, `$01` port (serial ATN/CLK/DATA, cassette write and motor, cassette read) |
| `$0100–$7FFF` | RAM |
| `$8000–$BFFF` | ROM bank low: BASIC, else the 3+1 ROM, else a cartridge (`$FDD0–$FDDF` picks) |
| `$C000–$FBFF` | ROM bank high: KERNAL, else the 3+1 ROM, else a cartridge |
| `$FC00–$FCFF` | KERNAL (always, for the bank-switching routines) |
| `$FD00–$FD0F` | 6551A ACIA (Plus/4 only) |
| `$FD10–$FD1F` | 6529B PIO 1: the user port; its bit 2 reads the cassette PLAY line |
| `$FD30–$FD3F` | 6529B PIO 2: the keyboard matrix rows |
| `$FDD0–$FDDF` | ROM bank select: `$FDD0 + (low bank) + 4 × (high bank)` |
| `$FEE0–$FEFF` | 1551 drive TIA mirrors (only with a 1551) |
| `$FF00–$FF3F` | the TED's 64 registers |
| `$FF3E` | write: ROM on (bit 0) |
| `$FF3F` | write: RAM on (`$FF3F` banks the ROMs out over `$8000–$FFFF`) |
| `$FF40–$FFFF` | RAM, or the KERNAL when ROM is selected (the KERNAL's top 16K) |

`$FF3E`/`$FF3F` cannot be read. A write to ROM always bleeds through to the RAM
under it.

### TED registers (`$FF00–$FF3F`)

| Reg | R/W | Contents |
| --- | --- | --- |
| `$00–$05` | R/W | timers 1–3, high byte first (a timer counts 2 cycles a tick) |
| `$06` | R/W | CR1: TEST, ECM, BMM, DEN, RSEL (24/25 rows), YSCROLL |
| `$07` | R/W | CR2: REVERSE, PAL/NTSC, STOP, MCM, CSEL (38/40 columns), XSCROLL |
| `$08` | R/W | keyboard: the column lines, selected by who drives the rows (PIO 2, both joysticks) |
| `$09` | R/W | interrupt status: raster, timer 1/2/3, light pen; bit 7 any |
| `$0A` | R/W | interrupt mask, plus bit 8 of the raster compare line |
| `$0B` | R/W | read: raster counter; write: raster compare low byte |
| `$0C–$0D` | R/W | cursor position |
| `$0E–$11` | R/W | sound: voice 1 and 2 frequency, control (volume, voice enables, noise, D/A) |
| `$12` | R/W | bitmap base (bits 3–5), video ROM/RAM select, voice 1 frequency high |
| `$13` | R/W | character base (bits 2–7), 1 MHz (bit 1), video ROM select (bit 0) |
| `$14` | R/W | video matrix / colour base (bits 3–7) |
| `$15` | R/W | background colour (0–127) |
| `$16–$18` | R/W | colour 1–3 (0–127) |
| `$19` | R/W | extended background colour |
| `$1A–$1B` | R/W | bitmap reload |
| `$1C–$1D` | R | vertical (raster) scan position |
| `$1E` | R | horizontal scan position |
| `$1F` | R/W | blink counter, vertical character position |
| `$3E` | W | ROM on |
| `$3F` | W | RAM on |

Unused bits read back as 1 (`$FF0A` `$A0`, `$FF0C` `$FC`, `$FF14` `$07`,
`$FF15–$FF19` `$80`, `$FF3E`/`$FF3F` `$FF`).

A colour is 7 bits: luminance (bits 4–6) and chroma (bits 0–3), 128 in all. The
palette (VICE's `colodore_ted.vpl`) is `palette[(luma << 4) | chroma]`.

### Keyboard

An 8 × 8 matrix: PIO 2 (`$FD30`) drives one row low at a time and the TED
(`$FF08`) returns the eight column lines of every row selected. There is no
RESTORE key (the Plus/4's RESET button is outside the matrix). The four cursor
keys are their own matrix keys, and F1–F7 plus HELP sit on row 0.

### Video

`DEN` off blanks the display. The 25-row mode starts at raster line 4 and ends
at `$CB`; the 24-row mode starts at 8 and ends at `$C7`. The 40-column window
starts at cycle 15 (after `$FB`-style delays) and is 320 pixels wide; the
38-column mode insets it by 7 pixels. The bitmap is fetched in two halves (the
"1fff" trick) and the character pointers come from the video matrix, whose base
is `$FF14` (bits 3–7) × `$400` + `$400`; the character base is `$FF13` (bits
2–7) × `$400`. A bad line steals 88 cycles (43 characters + 3, times two) from
the CPU on the row the `ycounter` matches `YSCROLL`, which is what makes raster
splits possible.

### Sound

Two square-wave voices, each dividing the clock by 8 by `(frequency + 1)`, with
a 10-bit frequency; voice 2 feeds the noise shift register
(`x^8 + x^5 + x^4 + x^1 + 1`). Volume 0–8 (8–15 are the same), either voice
individually, noise on voice 2, and a "D/A" mode that plays the volume register
as a 6-bit sample. Frequencies `$3FE`/`$3FF` are silence (the chip latches the
output high).

### Timers and interrupts

Each timer counts at half the CPU clock and reloads from its latch; a write to
the high byte starts it, a write to the low byte stops it. The raster compare
interrupt fires on the line written to `$FF0B` (plus bit 8 in `$FF0A`), at the
end of the previous line. The IRQ line is `(status & mask & $FE) != 0`.

---

## 2. What already exists

| Need | Existing code | Reusable as-is? |
| --- | --- | --- |
| 6502 core | `src/cores/m6502.ts` | ✅ the 7501 is an HMOS 6510 |
| 6502 debugger / trace / bus cycles | `src/debug/m6502/` | ✅ (family substrate) |
| BASIC 3.5 lister | `src/basic/c128-basic-parser.ts` (V7.0) / `c64-basic-parser.ts` | ◐ BASIC 3.5 shares the 64's layout and most tokens; a 3.5 token table is needed |
| `.prg` / `.t64` parse | `src/media/tape/t64.ts` | ✅ |
| C64 TAP (`C64-TAPE-RAW`) | `src/media/tape/c64-tap.ts` | ✅ header byte 13 is the platform (2 = C16/Plus/4); pulses count in c16 units of the machine clock |
| D64/G64/D71/D81 codecs, 1541/1571/1581 drives, IEC bus, disk and tape services | `src/machines/shared/cbm/` | ✅ (the drives hang off the 7501's port bits) |
| Breadbin keyboard rendering | `src/machines/shared/ui/cbm-keyboard/` | ◐ the caps differ (cursor cross, F-keys on the front, no RESTORE); the Plus/4 gets its own layout over the shared scene |
| On-screen keyboard host mapping | `src/machines/shared/cbm/keyboard.ts` | ✅ with per-machine code-key overrides |
| 5-byte BASIC floats | `src/basic/c64-basic-parser.ts` | ✅ |
| Screen OCR | `src/ocr/c64.ts` (`cbmRomGlyphs`, `cbmMatchGlyph`, `cbmGridText`) | ✅ the character ROM holds the PETSCII glyphs; the TED's matrix and colour registers say where |

The TED is custom silicon (only the Plus/4, C16, C116 and V264), so it lives in
`src/machines/plus4/ted.ts`. So is the 6529B's single-register PIO wiring, but
the 6529B itself is a commodity part: `src/cores/m6529b.ts`. The 6551A ACIA is
commodity silicon too (Apple II Super Serial, many 6502 boards):
`src/cores/mc6551.ts`.

---

## 3. Phases

Each phase ends with `npx tsc --noEmit`, `npx vitest run` and
`npm run depcheck` green.

### Phase 1: the motherboard boots to BASIC

- `src/cores/m6529b.ts`: one 8-bit port with a data-direction register, as the
  6529B is wired (no control lines).
- `src/cores/mc6551.ts`: the 6551A's four registers (data, status, command,
  control) with the status bits the ROM polls; no external line, so the
  transmit/receive state machine is the minimum the KERNAL needs.
- `src/machines/plus4/`: `models.ts` (`plus4`, `c16`), `constants.ts` (both TV
  standards, screen geometry), `palette.ts` (the 128 colours), `memory.ts` (the
  map above, the RAM size per model, the ROM banks, the page the ROMs are
  banked out by), `ted.ts` (registers, timers, IRQ, video modes drawn lazily per
  line like the VIC's, sound), `pio.ts` wiring, `keyboard.ts` (the 8 × 8 matrix
  and the host mapping), `plus4-machine.ts`, `descriptor.ts`, `chip-dump.ts`,
  `screen-text.ts`, `services/`, `snapshots/`.
- Registered in `registry.ts`, `models.ts`, `MachineKind`, the model menu, the
  Save menu (`.plus4state`).

Visible: the real ROMs boot to `READY.` with the memory-size banner.

### Phase 2: sound, input, the on-screen keyboard, programs

TED sound through the mixer and its own snapshot section; joysticks on the TED
register; `.prg`/`.t64` injection (reset, wait for `READY.`, RUN); RAM-size and
ACIA Hardware-pane options; the Plus/4 keyboard pane.

### Phase 3: Datasette, disk drives, cartridges

The Datasette on the 7501 port bits (`$01`: read bit 4, write bit 1, motor bit
3) and PIO 1 bit 2 for PLAY, reusing `CbmTapeService`; the IEC bus bit-banged
on the port (ATN bit 7, CLK bit 6, DATA bit 5 out, and the same two in) with the
shared 1541/1571/1581; `.crt` cartridges (the generic type's four 16K banks).

### Phase 4: tools and polish

TEXT overlay over the TED's own matrix (`src/ocr/plus4.ts`), BASIC 3.5 listing
and variables panes, chip dump, beam log and run-to-beam, the machine sheet.
