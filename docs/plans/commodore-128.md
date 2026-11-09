# Plan: Commodore 128

Status: **decisions settled; Phase 0 (research) and Phase 1 (shared parts) done, the machine itself not started.** Worktree `F:/src/zx/zx84-c128`, branch
`feature/c128`, cut from `dev` and fast-forwarded to 12cdae9d (the VIC-20 merge). When the machine lands, this file
becomes `docs/machines/commodore-128.md`, written to
[`TEMPLATE.md`](../machines/TEMPLATE.md). Follow
[`docs/adding-a-machine.md`](../adding-a-machine.md) for the definition of done.

The 128 is three computers in one case: a C128-mode machine (8502, MMU banking,
BASIC 7.0, two displays), a complete C64 (**GO64**), and a Z80 CP/M machine. It
reuses most of the C64 port: the SID, both CIAs, the tape, the cartridge port,
the drives and the joystick and mouse handling. What is new is the MMU, the
VIC-IIe's extras, the 80-column VDC, the Z80 and the fast serial bus.

Hardware statements below come from memory of the C128 Programmer's Reference
Guide and are **to be confirmed against the documentation and the ROM** (the
way the 1541/1571/1581 work was: disassemble, then model). Anything not yet
confirmed is marked *(confirm)*.

---

## 1. The machine

| | PAL (`c128`, locale `uk`) | NTSC (`c128`, locale `us`) |
| --- | --- | --- |
| CPU | 8502 at 1 or 2 MHz (software-selected), plus a Z80A | same |
| Video | VIC-IIe 8566 (40 columns) and VDC 8563 (80 columns) | VIC-IIe 8564, same VDC |
| Raster | 312 × 63 cycles, as the C64 | 263 × 65 cycles |
| RAM | 128K in two 64K blocks, 16K VDC RAM (64K on the DCR) | same |
| Sound | SID 6581 (8580 on later boards) | same |
| I/O | two CIA 6526s (8521), as the C64 | same |
| Memory manager | MMU 8722 | same |
| ROM | 128K: BASIC 7.0 low/high, screen editor, KERNAL, Z80 BIOS, C64 BASIC and KERNAL, character ROM | same |
| Ports | cassette, serial (IEC, with **fast serial**), user, two control ports, expansion (cartridge), RGBI + composite video | same |

Model ids: start with one, `c128`. The 128D/DCR differences (64K VDC RAM, the
internal 1571, a different KERNAL revision) become Hardware-pane options, as the
C64's drive and SID model are. Add `c128dcr` only if ROM revisions force it.

### What the 128 adds over the 64

| Area | The 128 | Where it lives |
| --- | --- | --- |
| MMU 8722 | Config register `$D500` (mirrored at `$FF00`), four preconfiguration registers `$D501-$D504` (writing `$FF01-$FF04` loads one into the config), mode register `$D505`, RAM configuration `$D506`, page 0 / page 1 relocation `$D507-$D50A`, version `$D50B`. Picks ROM/RAM/I/O per 16K region, the RAM block, the common-RAM areas, which CPU runs, and C64 or C128 mode. *(confirm every bit)* | `c128/mmu.ts`, `c128/memory.ts` |
| VIC-IIe | A VIC-II plus `$D02F` (extra keyboard lines K0-K2) and `$D030` (2 MHz). The 2 MHz mode blanks the 40-column display. *(confirm the exact blanking and clock rules)* | shared VIC-II, `c128/vic-iie.ts` for the delta |
| VDC 8563 | 80×25 text and bitmap, 37 registers behind `$D600` (address) / `$D601` (data, status bit 7 = ready), attributes (reverse, underline, flash, alternate set), hardware scroll, block copy and fill, light pen. The character set is copied into VDC RAM by the KERNAL at boot, so the VDC has no ROM of its own. | `c128/vdc.ts` (single-machine silicon stays in the machine folder) |
| Z80 | Active at reset: it runs the Z80 BIOS, which hands over to the 8502 for a normal boot, or boots CP/M. Only one CPU runs at a time (`$D505`). | existing `src/cores/z80`, wired in `c128/` |
| Keyboard | 8×8 matrix plus 3 more lines: ESC, TAB, ALT, CAPS LOCK, LINE FEED, HELP, NO SCROLL, numeric keypad, four cursor keys. The 40/80 DISPLAY key and CAPS LOCK are read through `$D505` / the 8502 port, not the matrix. *(confirm)* | `c128/keyboard.ts` over the shared CBM keyboard |
| Fast serial | The KERNAL talks to a 1571/1581 in **burst mode**: the CIA 1 shift register clocked over the serial bus, direction set by FSDIR in `$D505`. The 1571 already has its half (CIA at `$4000`). | CIA core + shared serial bus |
| BASIC 7.0 | Text at `$1C01` in bank 0, larger token set including `$CE`/`$FE` prefixed tokens, sprite and graphics commands. | `src/basic/` parser extension |

---

## 2. What already exists

| Need | Existing code | Reusable as-is? |
| --- | --- | --- |
| 6502 core | `src/cores/m6502.ts` (NMOS, undocumented opcodes, edge-triggered NMI) | Yes. The 8502 is an NMOS 6502 with the same on-chip port; 2 MHz is a clock matter, not an opcode matter |
| Z80 core | `src/cores/z80/` | Yes, with machine-supplied memory closures as on the Spectrum/CPC/MSX |
| CIA | `src/cores/mos6526.ts` | **Yes, since Phase 1.** It now has a real SP/CNT shift register (transmit clocked by timer A, receive on CNT edges) and CNT-counting timers |
| SID | `src/cores/mos6581.ts` | Yes, including the 8580 option |
| VIC-II | `src/cores/vic-ii.ts` (moved from `machines/c64/` in Phase 1), reading through a `VicBus` and drawing with a palette the machine passes in | **Yes, since Phase 1** for the 40-column display; the VIC-IIe extras are Phase 3 |
| Drives | `shared/cbm/drive/drive-{1541,1571,1581}.ts` with a `CbmSerialBus` | Yes. The 1571 already has the burst-mode CIA and the 2 MHz clock |
| Keyboard | `shared/cbm/keyboard.ts` and `shared/ui/cbm-keyboard/` | Yes, plus the 128's extra keys |
| Tape | `TapeDeck`, `PulseRecorder`, `c64-tap.ts`, `t64.ts` | Yes |
| Cartridge | `c64/cartridge.ts` (.crt boards) | 64 mode yes; 128 mode needs function-ROM handling |
| OCR, screen text | `src/ocr/c64.ts` | 40-column yes; 80-column is a new, simpler engine over VDC RAM |
| BASIC parser | `src/basic/c64-basic-parser.ts` (V2) | Extend for 7.0 |
| ROMs | VICE's C128 folder under `N:/collections/retro/Commodore/64/Emulators/WinVICE-3.1-x64/C128`: `basiclo` 16K, `basichi` 16K, `kernal` 16K, `basic64` 8K, `kernal64` 8K, `chargen` 8K | Staged locally only. Upload to R2 `zx84/roms/c128/` needs your OK, as before |
| Software | `N:/collections/retro/Commodore/128` (TOSEC D64, D81, LNX, PRG, applications, demos) | Test material |

**Dependency (met).** The VIC-20 merge moved the drives, serial bus, keyboard and
tape/drive services into `src/machines/shared/cbm/`, the layer the 128 builds on. The
Drives and Keyboard rows above describe `c64/` as it was; those files now live in
`shared/cbm/` on `dev`.

---

## 3. Decisions for you

1. **Base branch. Decided and done:** `feature/vic20` is merged into `dev` (PR #68),
   `dev` is pulled, and `feature/c128` is fast-forwarded to it (12cdae9d). The
   `shared/cbm` layer the 128 needs (drives, serial bus, keyboard, tape and disk
   services) is already in the tree, so Phase 1 has no extraction to do.
2. **Two displays.** The 128 has a 40-column composite output and an 80-column
   RGBI output, and a real user looks at one monitor. (a) One canvas with a
   Display menu (40 / 80 / Auto, following the 40/80 key and the last active chip).
   (b) Two canvases side by side. **Decided: (a), Auto by default.** It needs the
   frame size to change at run time, which `frameWidth`/`frameHeight` already allow
   in principle (the Spectrum's change with the border setting), but
   `setCanvas()` builds the renderer once for a fixed size. Expect one small
   generic seam so the shell re-creates the renderer when the machine reports a new
   geometry. That is the only planned edit outside `src/machines/c128/`.
3. **Z80 / CP/M scope.** The Z80 boot path is mandatory (the 128 starts on it).
   Booting a CP/M 3.0 disk is separate: the disks are MFM and need the 1571's
   WD1770, which the drive model does not have. (a) Z80 boot only, CP/M deferred.
   (b) Full CP/M. **Decided: (a)**, with CP/M as its own final phase if wanted.
4. **Machine kind.** (a) A new kind `c128` (an island, sharing through `shared/cbm`
   and `cores/`). (b) A second model of the `c64` kind. **Decided: (a)**: the MMU,
   two displays, two CPUs and their services would swamp `C64Machine`, and the
   registry/descriptor split exists for this.
5. **Debugger with two CPUs.** `descriptor.cpuFamily` is a single value, and the
   MCP and UI debug tools are family-blind through `DebugService`. (a) Report
   `m6502` and make the Z80 invisible to the debugger (the BIOS only runs briefly
   at boot). (b) A `DebugService` that routes to whichever CPU is active.
   **Decided: (a) first**, (b) with the CP/M phase.

---

## 4. Phases

Each phase ends with `npx tsc --noEmit`, `npx vitest run` and `npm run depcheck`
green. Nothing is committed until you ask.

### Phase 0: groundwork *(no emulation yet)*
- Settle decision 1. Create `src/machines/c128/` skeleton, `docs/machines/commodore-128.md`
  stub.
- Stage the six ROM files in `mcp/.cache/` (gitignored). Find where the Z80 BIOS lives
  in the images, how the 8K `chargen` splits between the 64's set and the 128's, and
  record the ROM revisions and md5s. *(confirm)*
- Read the 128 KERNAL/editor boot path to pin down the MMU bits the way the
  1541/1571/1581 hardware facts were derived. Notes go in `mcp/.cache/c128-dev/`.

**Phase 0 findings so far** (the six ROMs are staged in `mcp/.cache/c128-dev/`, gitignored):

| File | Size | md5 |
| --- | --- | --- |
| `basiclo` | 16K | b86ce827c9108fbc7b9e02c690e81a23 |
| `basichi` | 16K | 87bb251707d0a2c915d6e0c69fdb0fed |
| `kernal` | 16K | 01f6903033b90cd506cde7802ec743c3 |
| `basic64` | 8K | 57af4ae21d4b705c2991d98ed5c1f7b8 |
| `kernal64` | 8K | 39065497630802346bce17963f13c092 |
| `chargen` | 8K | 46b3cb2140f244c0ed1150c819e7bdc4 |

- **The Z80 BIOS is inside the 16K `kernal` image at offset `$1000-$1FFF`** (the part the
  8502 sees under the `$D000` I/O window). It begins `3E 3E 32 00 FF C3 3B 00 31 77 3C`:
  `LD A,$3E`, `LD ($FF00),A` (a write to the MMU configuration register), `JP $003B`,
  `LD SP,$3C77`. The Z80 sees `kernal[$1000..$1FFF]` as its `$0000-$0FFF` (confirmed:
  the branch targets and `LD SP` line up only at that base).
- The 8502 side begins at `$E000` of the same image (`A2 FF 78 9A D8`: `LDX #$FF`, `SEI`,
  `TXS`, `CLD`), and `$C000` is the screen editor's jump table (`4C 7B C0 ...`).
- `chargen` is two 4K halves that differ in only 97 bytes: one is the 64's set and the
  other the 128's. Which is which is still to be confirmed (the 64's is expected to match
  `c64/chargen-901225-01.rom`).

**Boot sequence, read from the ROM (disassembled with the repo's own disassemblers, script in
`mcp/.cache/c128-dev/dis.ts`):**

1. Reset: Z80 active, MMU registers 0, RAM bank 0. The Z80 BIOS is visible at `$0000-$0FFF`.
2. `CR := $3E` (via `LD ($FF00),A`), then **`OUT` instructions to `$D02F`/`$D030`** (VIC
   `$FF`, `$FC`) and `$D505` (`$B0`, read back and checked against `$30`: the GAME/EXROM lines
   show a cartridge). So **Z80 `IN`/`OUT` use the full 16-bit port address as the I/O
   area `$D000-$DFFF`**, and work only while CR bit 0 = 0.
3. CIA 1 is set up (`$DC0E/F := $08`, `$DC02/03`) and **column 7 of the keyboard is read
   (`$DC00 := $7F`, test bit 5 of `$DC01`): C= held at reset writes `$D505 := $F1`, i.e.
   C64 mode on the 8502.** Otherwise the BIOS carries on.
4. The BIOS writes eleven MMU registers from a ROM table, `$D50A` down to `$D500`:
   `P1H=$00 P1L=$01 P0H=$00 P0L=$00 RCR=$0B MCR=$B0 PCRD=$7E PCRC=$3E PCRB=$7F PCRA=$3F CR=$3F`.
   RCR `$0B` is common RAM at the **top, 16K**. After `CR=$3F` the Z80's I/O is gone but its
   `$0000-$0FFF` BIOS is still visible, so **the Z80's low 4K is the BIOS whenever the RAM
   bank is 0, independent of CR bit 0** (CR bit 0 only gates its I/O).
5. It copies an 8-byte stub to RAM `$1100` and a 31-byte block to `$FFD0` (common RAM), points
   the vectors at `$FFFA/$FFFC/$FFFE/$FFDD` at `$1100`, and jumps to `$FFE0`: `DI`,
   `CR := $3E`, then `OUT ($D505),$B1`. MCR bit 0 set hands control to the 8502.
6. **The 8502 starts as if reset**: it fetches the vector at `$FFFC` (RAM at that moment,
   `$1100`), runs `LDA #0 / STA $FF00 / JMP ($FFFC)`. CR is now 0, so `$FFFC` reads the
   KERNAL's reset vector `$FF3D` (`LDA #0, STA $FF00, JMP $E000`). `$E000` then starts
   `LDX #$FF / SEI / TXS / CLD` and copies a table into `$D500-$D50A`, then initialises the
   machine.

**MMU facts confirmed or corrected** (from the ROM above, and from VICE's `c128mmu.c` and
`z80mem.c` read as a behaviour reference, not copied):

| Item | Fact |
| --- | --- |
| Registers | 12 at `$D500-$D50B`; CR also at `$FF00`; `$FF01-$FF04` write = load PCRA-D into CR |
| CR | bit 0 `$D000` area (0 = I/O, 1 = ROM/RAM); bit 1 `$4000-$7FFF` (0 = BASIC low ROM, 1 = RAM); bits 3:2 `$8000-$BFFF` (00 = BASIC high ROM, 01 = internal function ROM, 10 = external function ROM, 11 = RAM); bits 5:4 `$C000-$FFFF` (00 = KERNAL, 01 internal, 10 external, 11 RAM); bits 7:6 RAM block |
| MCR (`$D505`) write | stored as `(v & $7F) \| $30`; bit 0 selects the CPU (**1 = 8502, 0 = Z80**); bit 3 FSDIR (fast serial output); bit 6 = C64 mode |
| MCR read | low nybble as stored; bit 4 = GAME inverted, bit 5 = EXROM inverted, **bit 7 = 40/80 key released (1 = 40 columns)**; bit 6 as stored |
| RCR (`$D506`) | bits 1:0 common-RAM size 1K / 4K / 8K / 16K; bit 2 common bottom; bit 3 common top; bits 7:6 the RAM block the VIC-IIe sees |
| P0/P1 | `$D507` P0L, `$D508` P0H, `$D509` P1L, `$D50A` P1H; **the high byte is latched and only takes effect when the low byte is written**; high-byte reads return the top 4 bits set; reset values P0 = page `$00`, P1 = page `$01` |
| Version | `$D50B` reads `$20` |
| Z80 view | I/O from the `$Dxxx` port address only when CR bit 0 = 0; the 8502-only parts (cartridge detection, C64 mode) behave as above |
| 8502 reset | on taking control it reads `$FFFC` from whatever CR then maps |

Two items still *(confirm)*: the shared-RAM window arithmetic for the top-common area (the
size counts down from `$FFFF`), and whether the 8502's own on-chip port has any 128-mode
bit with a meaning (CAPS LOCK sense on port bit 6 is expected).

### Phase 1: shared parts the 128 needs *(done, uncommitted)*
- **VIC-II to `src/cores/vic-ii.ts`.** Done. It reads through `VicBus` (`vicRead(addr14)` and
  `colorRam`, which `C64Memory` already had), takes its timing as `VicTiming` (the C64's
  `C64Timing` satisfies it) and its palette as a constructor argument, and saves state through
  the cores' `StateSink`/`StateSource`. The stream is byte-identical. All C64 tests pass; the only
  test edit is the `new VicII(...)` call in `c64-machine.test.ts`, which now passes timing and
  palette. A boot to READY with the real ROMs draws pixel-identical frames before and after
  (md5 of the frame buffer at frames 150, 200 and 300, dev against this branch).
- **CIA serial port.** Done, in `mos6526.ts`. Transmit: a write to SDR with CRA bit 6 set sends
  the byte MSB first over 16 timer-A underflows (CNT low on odd, high on even; each bit valid
  on the rising edge), SP interrupt on the eighth, a byte written meanwhile goes out after it.
  Receive: `cntEdge(t, sp)` shifts SP in, SP interrupt and SDR after eight. Timers A and B
  can count CNT edges. `onShiftOut(bit, t)` reports each transmitted bit. The legacy snapshot
  stream is unchanged; the new state is in `saveSerial`/`loadSerial`. Tests in
  `tests/c64/mos6526.test.ts` from the data sheet.
- **Fast serial on `CbmSerialBus`.** Done for the 1571: `attachFastSerial(hostCia, hostHz)`
  wires the host CIA's and the drive CIA's shift registers to each other, gated by the two
  direction pins (`fastHostTransmits` for the MMU's FSDIR, `fastTransmitting` read from the
  1571's VIA 1 port A bit 1). Tests in `tests/c64/fast-serial-bus.test.ts`.

Not done, and why (all need the real 128 ROMs running, so they belong to Phase 6):
- Timer mode 3 (count timer A underflows only while CNT is high) is not modelled; nothing on
  these boards drives CNT high between edges.
- Whether the KERNAL also watches the SRQ line through CIA 1's /FLAG pin. Read it from the ROM
  before deciding to model the level.
- The 1581's burst port (its CIA has no direction pin; the sender is the one whose SPMODE is set).
- The 1571's snapshot does not carry the shift-register state yet (it would change the
  existing stream); the C128's own snapshot format will, via `saveSerial`.
- The check "against the real 1571 DOS (its burst commands)" needs a 128 host to issue them.

### Phase 2: C128 mode boots to READY on the 40-column screen
- `c128/mmu.ts` + `c128/memory.ts`: the whole `$D5xx` / `$FF0x` register set, ROM/RAM/I/O
  selection per region, RAM blocks, common RAM, page 0/1 relocation, VIC bank view.
  Tests are written from the Programmer's Reference Guide tables, not from the
  implementation: each region × ROM-select value, common-RAM boundaries at every size,
  relocated page 0 reads and writes, and the `$FF01-$FF04` load-config writes.
- `c128/c128-machine.ts`: reset with the Z80 active, Z80 BIOS runs, hand-off to the
  8502 through `$D505`. 8502 at 1 MHz only, VIC-IIe as a plain VIC-II, no VDC yet.
- Keyboard with the 3 extra lines, CAPS LOCK and the 40/80 key; no on-screen pane yet.
- **Milestone:** headless boot to the BASIC 7.0 banner with `READY.`, typing works,
  `SYS`/`POKE` of an MMU register changes the map. (Tests skip without the staged ROMs,
  like the other real-ROM tests.)

### Phase 3: VIC-IIe extras and 2 MHz
- `$D02F` keyboard-line output and `$D030` bit 0. Model the CPU clock in 2 MHz mode
  and what the VIC-IIe does to the picture while it is on *(confirm: blanking, and
  what the CPU gets on bad lines and in the borders)*.
- Frame timing for fast mode: twice the 8502 cycles per frame, the SID/CIA timers still
  on the 1 MHz base. Cycle-count tests with hand-computed loops at both speeds.
- Check the speed cost; the machine must still hold real time in a desktop browser.

### Phase 4: VDC and the 80-column display
- `c128/vdc.ts`: register file behind `$D600/$D601`, update/data pointers, text and
  bitmap modes, attributes, flash, cursor, scroll, block copy and fill with their
  timing/ready bit, 16K and 64K RAM. Rendered to its own frame buffer.
- Display selection per decision 2 (Auto follows the 40/80 key and whichever chip was
  last programmed). The one generic renderer-resize seam lands here.
- 80-column OCR engine over VDC RAM (screen, attribute and charset), TEXT overlay.
- Tests with hand-computed expectations: indirect addressing, auto-increment of the
  update address, copy with overlapping source and destination, fill, attribute bits.
- **Milestone:** `GRAPHIC`/`COLOR` and the 80-column screen visible; BASIC editor in
  both columns; the programs in `Games - [D64]` marked `[80 Columns Mode]` draw.

### Phase 5: C64 mode (`GO64`)
- `$D505` bit 6 and the 64 ROM pair; the MMU then presents the C64's PLA map (reuse the
  PLA rules from `c64/memory.ts` conceptually; the 128 owns its copy). The VIC-IIe's
  extras are masked as the hardware does. 1 MHz forced.
- Re-run the C64 machine's own program/tape/disk scenarios against the 128 in 64 mode
  (the same `.prg`, `.t64`, `.tap`, `.crt` fixtures), plus a "boot with the C= key held"
  case.

### Phase 6: drives and fast serial
- 1571 as the default drive (it is the 128's own), 1541 and 1581 selectable, up to four
  as on the 64. Burst-mode reads and writes through CIA 1 SP/CNT and FSDIR, tested with
  the real 1571 and 1581 DOS: `DIRECTORY`, `DLOAD`, `DSAVE`, `HEADER`, `COPY` in BASIC 7.0.
- `.d71` / `.d81` / `.d64` / `.g64` mounting and saving come with the shared drive services.

### Phase 7: media, services and UI
- Descriptor, services (`media`, `roms`, `tape`, `disks`, `snapshots`, `debug`, `input`,
  `probe`), registry and `models.ts` entries, the ROM pane sockets (BASIC lo, BASIC hi,
  KERNAL, 64 BASIC, 64 KERNAL, character ROM), the PRG/T64 injection with BASIC 7's
  pointers (text start `$1C01`, and the 64's `$0801` in 64 mode).
- Tape: Datasette on the 8502 port; auto-PLAY as on the 64.
- Cartridges: 64 mode as today, 128 mode as the internal/external function ROM.
- Hardware pane: VDC RAM 16K/64K, SID model, drives, 2 MHz indicator. Status LEDs.
- Snapshots: native `.c128state` with MMU, VDC, both CIAs and the CPU in play.
- BASIC pane: BASIC 7.0 token table and variable layout.
- MCP: `chip_state` gains `mmu` and `vdc`; machine-specific tool only if needed.
- Joystick, 1351 mouse, SID options carry over from the 64. On-screen keyboard with the
  extra keys.

### Phase 8: Z80 and CP/M *(only if wanted, decision 3)*
- Z80 memory and I/O through the MMU, the Z80 clock/wait-state model, the
  CP/M boot sector check from the BIOS.
- MFM in the 1571 (WD1770 on the 1571's second controller), then a CP/M 3.0 system disk
  boots to `A>`. Debugger routing per decision 5(b).

### Phase 9: documentation and release
- `docs/machines/commodore-128.md` from the template, README machine table and model id,
  `docs/developer-tools.md`, `ChangelogPane` entry. Run the capability test
  (`tests/machine-capabilities.test.ts`); every `descriptor.ui` flag must be kept.
- Upload the ROMs to R2 with your OK, md5-verify, then flip the feature live.

---

## 5. Risks and unknowns

- **MMU and 2 MHz are the accuracy-critical parts.** The wrong clock rules in fast mode
  show up as slow or fast software, not as a crash; the tests need hardware-documented
  numbers, not our own output.
- **Frame cost.** Two video chips, two displays and a 2 MHz CPU. The VDC only needs to
  render when it is the visible display, which keeps the cost close to the 64's. Measure
  in Phase 3 and 4.
- **Burst mode** depends on the CIA shift-register rework; a mistake there would also
  affect the 64's CIA tests, so that change stays behind the existing `mos6526` suite.
- **Z80 coverage.** Boot needs a handful of instructions; CP/M needs the full core and
  its timing. The core is shared with five other machines, so any change there needs
  those machines' suites green.
- **ROM provenance.** The files are VICE's; confirm revisions (318020-05 KERNAL etc.)
  before hosting.

## 6. Out of scope for the first release

REU/GeoRAM and the 1750/1764 RAM expanders, Commodore 128 printer and RS-232 userport
modems, the 1902/1084 monitor emulation details, the C128's internal function-ROM
sockets as a user feature, and the 2 MHz PAL-specific line-skipping subtleties until
Phase 3 shows they matter.
