# Plan: Commodore VIC-20

Status: **planning**. Nothing implemented yet. This plan covers what to build,
the order to build it in, and the one decision that has to come first: how
the VIC-20 gets the parts it shares with the C64.

Follow [`docs/adding-a-machine.md`](../adding-a-machine.md) for the
definition of done. When the machine lands, this file becomes
`docs/machines/commodore-vic-20.md`, written to
[`TEMPLATE.md`](../machines/TEMPLATE.md).

---

## 1. The machine

| | PAL (`vic20`, locale `uk`) | NTSC (`vic20`, locale `us`) |
| --- | --- | --- |
| Video chip | MOS 6561 VIC | MOS 6560 VIC |
| CPU | 6502 at 1.108404 MHz (4.433619 MHz ÷ 4) | 6502 at 1.022727 MHz (14.31818 MHz ÷ 14) |
| Raster | 312 lines × 71 cycles = 22,152 cycles, 50.04 Hz | 261 lines × 65 cycles = 16,965 cycles, 60.28 Hz (non-interlaced) |
| KERNAL | 901486-07 | 901486-06 |
| BASIC | 901486-01 (both) | |
| Character ROM | 901460-03 (901460-02 is the Japanese VIC-1001 set) | |

The PAL/NTSC choice uses the locale, as on the C64 and Atari. `romSources(model, locale)`
already receives the locale, so it can fetch the right KERNAL for each.

**Built in:** 5 KB RAM (1 KB at `$0000`, 4 KB at `$1000`), 1 K × 4-bit colour
RAM, two 6522 VIAs, the VIC (video *and* sound: three square-wave voices, noise,
and a 4-bit volume), a Datasette port, a serial (IEC) port, a user port, one
joystick port with a paddle pair, and a cartridge (memory expansion) port.

### Memory map (CPU)

| Range | Block | Contents |
| --- | --- | --- |
| `$0000–$03FF` | — | 1 KB RAM |
| `$0400–$0FFF` | RAM1–3 | 3 KB expansion |
| `$1000–$1FFF` | — | 4 KB RAM (default screen at `$1E00`) |
| `$2000–$3FFF` | BLK1 | 8 KB expansion / cartridge |
| `$4000–$5FFF` | BLK2 | 8 KB expansion / cartridge |
| `$6000–$7FFF` | BLK3 | 8 KB expansion / cartridge |
| `$8000–$8FFF` | — | Character ROM |
| `$9000–$900F` | — | VIC (mirrored to `$90FF`) |
| `$9110–$911F` | — | VIA 1 (selected by A4 within `$9100–$93FF`) |
| `$9120–$912F` | — | VIA 2 (selected by A5; `$9130` selects both) |
| `$9400–$97FF` | — | Colour RAM, low nybble only |
| `$9800–$9BFF` | I/O2 | expansion port |
| `$9C00–$9FFF` | I/O3 | expansion port |
| `$A000–$BFFF` | BLK5 | cartridge ROM (autostart signature `A0CBM` at `$A004`) |
| `$C000–$DFFF` | — | BASIC ROM |
| `$E000–$FFFF` | — | KERNAL ROM |

Unmapped reads, and the high nybble of colour RAM, return what the VIC last
left on the data bus. Some software relies on this, so plan for it from the
start rather than returning `$FF`.

### VIC's view (14-bit address bus)

VIC A13 is CPU A15 inverted. So VIC `$0000–$0FFF` is the character ROM
(`$8000`), VIC `$1000–$1FFF` is CPU `$9000–$9FFF`, and VIC `$2000–$3FFF` is CPU
`$0000–$1FFF`, which is only the internal 5 KB. **The VIC cannot see expansion
RAM.** This is why screen memory moves to `$1000` and BASIC to `$1201` when 8 KB
or more is fitted. Colour RAM reaches the VIC on its own 4-bit bus, at
`$9400` or `$9600` depending on screen-address bit VA9 (`$9002` bit 7).

### VIA wiring

| | VIA 1 (`$9110`) → **NMI** | VIA 2 (`$9120`) → **IRQ** |
| --- | --- | --- |
| Port A | PA0 serial CLK in, PA1 serial DATA in, PA2 joy up, PA3 joy down, PA4 joy left / paddle X fire, PA5 fire / light pen, PA6 cassette sense, PA7 serial ATN out | Keyboard rows (input) |
| Port B | User port | Keyboard columns (output); PB3 cassette write; PB7 joy right / paddle Y fire |
| CA1 | RESTORE key | Cassette read |
| CA2 | Cassette motor (PCR output) | Serial CLK out (PCR output) |
| CB1 / CB2 | User port | Serial SRQ in / serial DATA out (PCR output) |

The 60 Hz jiffy IRQ comes from VIA 2's timer 1. The serial bus is driven entirely
by bit-banging the VIA port pins and PCR outputs. The VIC-20 has no CIA and no
serial shift register.

---

## 2. What already exists, and where it lives

| Need | Existing code | Reusable as-is? |
| --- | --- | --- |
| 6502 CPU | `src/cores/m6502.ts` | ✅ |
| 6522 VIA | `src/cores/m6522.ts` | ◐ (see §4) |
| 6502 debugger / trace / bus cycles | `src/debug/m6502/` | ✅ (family substrate) |
| BASIC V2 lister | `src/basic/c64-basic-parser.ts` | ✅ same tokens and zero-page pointers (TXTTAB `$2B`, VARTAB, …) |
| `.prg` / `.t64` parse | `src/media/tape/t64.ts` | ✅ |
| C64 TAP (`C64-TAPE-RAW`) | `src/media/tape/c64-tap.ts` | ✅ header byte 13 is the platform (1 = VIC-20). Pulses are in 8-cycle units of the *VIC-20's* clock |
| D64/G64/D71/D81 codecs | `src/media/floppy/c64-disk.ts`, `c64-d81.ts` | ✅ |
| 1541/1571/1581 drives + `C64DriveUnit` | `src/machines/c64/drive/` | ✗ **island**: the VIC-20 can't import it |
| Disk service, tape service | `src/machines/c64/services/{disks,tape}.ts` | ✗ island |
| On-screen breadbin keyboard | `src/machines/c64/ui/keyboard/` | ✗ island. The VIC-20 has the same caps but a different matrix |
| Screen OCR | `src/ocr/c64.ts` | ◐ same screen codes and character ROM, but 22 × 23 with a movable screen base |
| Paddles | `src/machines/shared/analog-stick.ts` | ✅ probably |

The VIC chip itself is custom silicon used only in this machine, so it goes in
`src/machines/vic20/vic.ts`, not `src/cores/`.

---

## 3. Decision needed first: sharing the Commodore parts

The 1541 is the main reason to share. It is ~1,200 lines of drive-level
emulation (a 6502, two VIAs, GCR under the head), and the VIC-20 uses the same
drive on the same IEC bus. The island rule (`machines-are-islands` in
`.dependency-cruiser.cjs`) means `src/machines/vic20/` can import
`src/machines/shared/` but not `src/machines/c64/`.

**Option A (recommended): lift the Commodore parts into `src/machines/shared/cbm/`.**

- Move `c64/drive/*` → `shared/cbm/drive/`. Rename `C64DriveUnit` → `CbmDriveUnit`,
  rename `setC64Lines` → `setHostLines`, and leave the C64-named ROM-source paths as they are.
- Move the drive-list `DiskService` (`c64/services/disks.ts`) and the Datasette
  `TapeService` (`c64/services/tape.ts`) into `shared/cbm/`. Wherever they
  reach into `C64Machine`, give them a small host interface instead.
- Move a small IEC bus helper (open-collector ATN/CLK/DATA, combining the
  lines of N drives, catching drives up to the host clock) out of `c64-machine.ts`.
  Both machines currently need exactly this.
- Optionally move the breadbin keyboard *rendering* to `shared/cbm/ui/`, with
  each machine passing its own matrix map. (`machines-no-ui` already exempts
  `src/machines/*/ui/`, and `shared` matches that glob.)
- This lands as a **pure refactor PR before any VIC-20 code**. The C64 behaves
  identically, all of `tests/c64/` stays green, and `npm run depcheck` stays at 0.

**Option B: duplicate the drive code into `vic20/`.** This is fast to start
with, but it forks ~2,000 lines that would then have to be fixed twice. Not recommended.

**Option C: VIC-20 without disk at first.** Ship tape, cartridges and PRG
injection, and defer the drive until Option A is done. This is a reasonable
staging if the refactor should wait, and it doesn't conflict with A.

Recommendation: **A, done as Phase 0**, with C's ordering as the fallback.

---

## 4. Core gaps to check (`src/cores/m6522.ts`)

The VIC-20 uses more of the 6522 than the BBC Micro, the 1541 or the Mockingboard do:

- **CA2/CB2 manual output (PCR modes 6/7).** These drive the cassette motor and serial CLK/DATA
  out. The core has no output-level getter, but the level can be derived from
  `via.pcr` in the machine, as `drive-1541.ts` already does for CB2. So no core
  change is required. `ca2Out`/`cb2Out` getters would be a small, additive core
  change that could tidy up both machines later.
- **Timer exactness.** For example, the extra half cycle on a T1 free-run reload, and the
  interrupt flag landing on the right cycle. Demo raster splits are timed off
  VIA 2 T1. Write tests against the datasheet before touching this.
- **T2 pulse counting on PB6, port B latching (ACR bit 1), shift register.**
  The KERNAL doesn't need these, but some games and RS-232 code do. They are
  low priority. Note them, and add them when a title needs one.

Any change to a core is a separate commit with its own spec-derived tests.

---

## 5. Phases

Each phase ends with all gates green (`npx tsc --noEmit`, `npx vitest run`,
`npm run depcheck`) and something visible to try.

### Phase 0: Commodore shared parts (refactor, no VIC-20 yet)
Do §3 Option A. C64 behaviour is unchanged.

### Phase 1: boot to the READY prompt
- `src/models.ts`: `Vic20Model = 'vic20'`, the union member and `isVic20Model`.
  `machine.ts`: add `'vic20'` to `MachineKind`. `registry.ts`: one entry.
  `model-menu.ts`: label `Commodore VIC-20`, locales `['uk', 'us']`.
- `vic20/models.ts`, `constants.ts` (both timing tables), `descriptor.ts`
  (`cpuFamily: 'm6502'`, `memoryMappedIo: true`, honest `ui` flags).
- `vic20/memory.ts`: the CPU map above, with expansion blocks as switchable RAM
  (none fitted yet), open-bus reads and the VIC-side address translation.
- `vic20/vic.ts` (the 6561/6560):
  - registers `$9000–$900F`; screen and character base from `$9002`/`$9005`;
    origin, columns and rows; 8×8 / 8×16 cells; hi-res and multicolour chars;
    reverse mode (`$900F` bit 3); border, background and auxiliary colours;
    raster `$9004` + `$9003` bit 7.
  - **Drawn lazily, cycle by cycle, as the C64's VIC-II is.** At 4 pixels per
    CPU cycle, one character takes two fetches (matrix + colour, then pattern), and
    the VIC fetches on φ1. **There is no cycle stealing**: the CPU never stalls,
    which makes this much simpler than the VIC-II. Mid-line register writes have
    to land on their cycle for raster splits.
  - The 16-colour palette (`palette.ts`). Border and character colours use the
    first 8 only.
- `vic20/keyboard.ts`: the 8 × 8 matrix (VIA 2 PB out, PA in). RESTORE is
  VIA 1 CA1 → NMI, not part of the matrix.
- `vic20-machine.ts`: extends `BaseMachine`. `runFrame()` steps the CPU,
  advances both VIAs, catches the VIC up, polls VIA 2 → IRQ and VIA 1 → NMI
  (edge).
- `services/`: `roms` (three sockets: BASIC, KERNAL, character ROM), `input`,
  `probe`, `debug` via `M6502DebugService`, `snapshots` via `NativeSnapshotService`.
- ROM host: upload `vic20/basic-901486-01.rom`, `vic20/kernal-901486-07.rom`,
  `vic20/kernal-901486-06.rom` and `vic20/characters-901460-03.rom` to
  `zx84files.bitsparse.com/roms/`. This is a manual step for the maintainer.
- Tests: the memory map and VIC address translation (including that the VIC
  can't see BLK1–3), the colour RAM high nybble, and VIA chip selects including the
  `$9130` double select. The keyboard matrix, checked against the KERNAL's
  decode table. Boots to `**** CBM BASIC V2 ****` / `3583 BYTES FREE` (PAL,
  unexpanded).

### Phase 2: sound, input, RAM expansion, programs
- VIC sound: three square voices, each clocked an octave apart, the noise voice, and
  4-bit master volume, through `AudioMixer`.
- Joystick (split across the two VIAs), paddles (`$9008`/`$9009` + fire lines).
- Hardware pane: **RAM expansion**: none / 3K / 8K / 16K / 24K / 32K (+3K)
  plus BLK5 RAM. Changing it is a power cycle.
- `.prg` drop: inject and autostart. **Pick the expansion from the load
  address** (`$1001` unexpanded, `$0401` 3K, `$1201` 8K+), and offer to switch
  when it doesn't match.
- `ui/keyboard`: the breadbin pane with the VIC-20 legends.
- Tests: voice frequency formula vs. the documented divider, and BASIC memory
  size per expansion (3583 / 6655 / 11775 / … bytes free).

### Phase 3: Datasette
- Shared CBM TAP service from Phase 0. Read on VIA 2 CA1, sense on VIA 1 PA6,
  motor on VIA 1 CA2, write on VIA 2 PB3. Recording to `.tap` on SAVE.
- TAP pulse units are scaled to the VIC-20 clock, using the platform byte when present.
- A generated KERNAL tape for `.prg`/`.t64`, as on the C64.
- Tests: load a known PAL VIC-20 TAP to the READY prompt with the right bytes in RAM.

### Phase 4: disk drive and cartridges
- 1541 (and 1581/1571-as-1541) on the serial bus through the shared IEC
  helper: ATN out VIA 1 PA7, CLK/DATA out via VIA 2 CA2/CB2, CLK/DATA in
  VIA 1 PA0/PA1. Devices 8–11, the Drives pane exactly as on the C64.
- Cartridges: raw 4K/8K/16K images, `.prg`-style images with a load address
  (`$A000`, `$6000`, `$2000`, …), and VICE `.crt` with the VIC-20 header.
  BLK5 autostart via `A0CBM`. Multi-block images (e.g. `$2000` + `$A000`) map
  into each block.
- Tests: `LOAD"$",8` lists a D64 directory; an 8K `$A000` cart autostarts.

### Phase 5: tools and polish
- OCR (22 × 23, screen base from `$9002`/`$9005`), BASIC listing pane, chip
  dump for the debugger (VIC + both VIAs), beam log / run-to-beam, MCP
  `type`/`ocr`/`screenshot` work generically through services.
- Save menu: snapshot, `.tap`, screenshot, RAM dump.
- `docs/machines/commodore-vic-20.md` from the template, plus a changelog entry.
- Later and optional: Super Expander (3K + ROM), light pen, VIC-1001 Japanese
  character ROM, NTSC interlace, user-port RS-232, Mega-Cart / Final Expansion.

---

## 6. Risks and open questions

- **VIC 6561/6560 timing detail.** The exact fetch cycle at which the matrix,
  colour and pattern are read relative to the horizontal origin, the first visible
  line, and the visible window for PAL vs NTSC. Derive these from datasheets and
  published analyses (we may learn from other emulators but not copy code).
  Pin the numbers with raster-split test programs.
- **Display geometry.** What area to show as "border" for each standard. The
  descriptor needs fixed `screen` dimensions, so pick a window that covers what
  a real TV showed.
- **The 1541 with the VIC-20.** The 1541's DOS (901229-05) supports the VIC-20.
  The VIC-20's KERNAL serial routines are slower than the C64's but use the same
  protocol, so this should just work once the IEC helper is shared.
- **Expansion RAM UI vs snapshots.** Snapshots must record the expansion layout
  and refuse to load into a different one, as C64 snapshots do for PAL vs NTSC.
- **ROM rights.** The same arrangement as the C64's ROMs on the ROM host.
