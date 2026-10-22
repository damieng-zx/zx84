# SpecDrum support — implementation plan

Branch: `feature/specdrum` (worktree `F:/src/zx/zx84-specdrum`, cut from `dev` @ 80811881).
Status: **P1–P6 implemented, uncommitted** (see §11 for what was built and what was verified).

## 1. What the SpecDrum is

Cheetah Marketing SpecDrum (1985, Alan Pateman / Peter Hennig). An edge-connector
add-on that is, electronically, a **write-only 8-bit DAC** with an op-amp output
stage and a phono socket. All the "drum machine" behaviour (8 voices, 3 channels
of polyphony, sequencing, kit loading) is **Z80 software** mixing samples and
streaming bytes to the DAC; the hardware has no ROM, RAM, timers or interrupts.

Facts established while researching (the emulator work is small *because* of this):

| Fact | Source |
| --- | --- |
| DAC is a Ferranti **ZN428E** (8-bit, unsigned, mono) | MAME `specdrum.cpp` (behaviour reference only — not copied) |
| Output is a single write port decoded on the **low address byte = 0xDF**; high byte is a don't-care | MAME `iorq_w`: `offset & 0x00ff == 0xdf` |
| Mono, centred output | MAME routes to one front-centre speaker |
| Sample-rate is whatever the Z80 loop produces (typically ~5–16 kHz); the kit samples are 8-bit | Wikipedia / Crash 27 |
| Sync pulse via EAR/MIC jacks is *possible* but unused by the shipped software | Wikipedia |

**Still to verify from a primary source before coding** (listed again in §9):
the original SpecDrum manual (ZXDB entry 1000062 PDF) for the exact port decode
(is `A0..A7 = 0xDF` fully decoded, or are some address lines ignored?), and
whether the output has any hardware low-pass or DC offset worth modelling.

## 2. Where it fits in the architecture

SpecDrum is a Spectrum peripheral, so it lives entirely in
`src/machines/spectrum/` alongside `amx-mouse.ts`, `vtx5000.ts`, `beta-disk.ts`.
The DAC itself, however, is commodity silicon: the Ferranti ZN428E also sits in
other add-ons (Cheetah's Amdrum for the CPC is documented as using one; the RAM
Music Machine and similar interfaces *may* too — **not yet verified**, check
before claiming it). So the chip is modelled once as a generic core,
`src/cores/zn428e.ts` (**done** — see §3.1), and each interface wraps it with its
own port decode. The core imports nothing, so `cores-know-nothing` holds.

No port conflicts on the Spectrum (checked against `io.ts`):

- ULA decodes A0=0; 0xDF has A0=1 → no clash.
- AY decode `(port & 0xC002)`: 0xDF has A1=1 → never matches AY select/data.
- Kempston joystick decodes A5–A7=0; 0xDF has A6=A7=1 → no clash.
- AMX mouse button port and Kempston mouse both use 0xDF but **read** only; the
  SpecDrum is **write** only, and `portOutHandler` / `portInHandler` are separate
  chains, so both can be enabled together (as on real hardware).
- Beta Disk, +D, IF1, Multiface use other ports.

## 3. Design

### 3.1 Generic DAC core — `src/cores/zn428e.ts` (implemented)

```
class ZN428E {
  get code(): number             // latched byte, 0..255
  get level(): number            // code / 255, unipolar 0..1 (what the mixer reads)
  write(value): void             // latch the low 8 bits
  reset(): void                  // power-on: code 0
}
export const ZN428E_FULL_SCALE = 255;
```

Scope is deliberately just the chip: a latch with an unsigned, proportional
output. No port, no timing, no filtering, no gain — those belong to the interface
(port decode) and the mixer (time-weighting, DC-blocking, volume). Any future
interface that uses the part (Amdrum on the CPC, a RAM Music Machine model, a
Covox-style board if it proves to use one) instantiates `new ZN428E()` and supplies
its own decode. Tests: `tests/cores/zn428e.test.ts`.

### 3.1b Peripheral class — `peripherals/specdrum.ts`

```
class SpecDrum {
  enabled = false;
  readonly dac = new ZN428E();
  matchPort(port): boolean       // (port & 0xFF) === 0xDF
  writePort(val): void           // dac.write(val); activity counter
  reset(): void                  // dac.reset()
}
```

The Spectrum frame loop reads `specdrum.dac.level`. Reset clears the latch: the real
board has no reset line (the DAC would hold its last code), but the difference is
inaudible behind the DC-blocker and a defined state keeps runs deterministic.

### 3.2 Port wiring — `io.ts` (tier-1 hot path: wiring only)

Add one `if (s.specdrum.enabled && (port & 0xFF) === 0xDF)` to `portOutHandler`,
placed after the Beta/IF1/+D checks and **without an early return** requirement
(no overlapping decode) — but keep the check cheap: `enabled` first so the
disabled case costs one boolean load. No read-side change (open bus is correct:
real hardware does not drive the bus on IN).

### 3.3 Audio — the one genuinely design-sensitive part

The DAC level must reach the speaker. The Z80 plays samples by tight OUT loops, so
the level changes at instruction granularity; the existing per-instruction
`accumulateLevel(level, elapsed)` in the frame loop (`spectrum.ts` ~L963) already
gives time-weighted sampling at that granularity. Per-sample error is ≤ one
instruction (≤ 23 T) against a 79 T output sample at 44.1 kHz — inaudible.

**Options (this is the decision to make — see §8):**

- **A. Fold into the beeper level.** `accumulateLevel(beeperLevel + dac/255 * k, …)`.
  Smallest diff; but shares the beeper's gain slider and DC-blocker, and ZN428E
  output (unsigned, idles at the last value) will produce DC steps on enable/reset.
- **B. Second mixer channel (recommended).** Add `accumulateAux(level, elapsed)` +
  `auxGain` and its own DC-blocking high-pass to `AudioMixer`
  (`machines/shared/audio-mixer.ts`). Called from the Spectrum frame loop only when
  `specdrum.enabled`, so every other machine's hot path is untouched. Gets its own
  volume in the Sound pane. Costs a small shared-file change + mixer tests.
- **C. Pre-mix inside `SpecDrum` and expose a `StereoAudioSource`.** Like AY/Dave.
  Rejected: that interface is pull-per-output-sample, but the DAC is push-per-OUT;
  we'd re-implement the time-weighted accumulator privately.

Turbo: `skipAudio` already bypasses accumulation; zero `auxAccum` alongside
`beeperTStatesAccum` there, exactly as the beeper does, so it stays in sync.

### 3.4 Settings & Hardware pane

- New persisted setting `specdrum` (`'on'|'off'`, default `'off'`) in
  `src/store/settings.ts` (default table, signal pair, `persistSetting` list entry)
  and `src/shell/settings.ts` (`'specdrum': () => settings.specdrumEnabled()`),
  mirroring `vtx5000`.
- Checkbox in `machines/spectrum/ui/hardware-section.tsx`. **No ROM, no reset
  needed**, so it is simpler than VTX/+D: toggle `s.specdrum.enabled` live.
- **Volume slider (decided):** a dedicated "SpecDrum" slider in the Sound pane
  (`SoundPane.tsx`), separate from master Volume and the Beep↔AY "Mixer" slider.
  - Setting `specdrum-volume` (number 0–100, default 100) in the `sound` settings
    group so the pane's reset-to-defaults covers it; pumped through the
    `SettingsView` (`shell/settings.ts`) like `ay-mix`.
  - `Spectrum.applySettings` sets `mixer.auxGain = view.get('specdrum-volume', 100) / 100`.
    This is why the DAC needs its own mixer channel (option B, §3.3).
  - The pane is generic and must not branch on machine kind, so the slider is
    driven by a new static descriptor capability, e.g.
    `soundPeripherals: [{ id: 'specdrum', label: 'SpecDrum', volumeSetting: 'specdrum-volume', enabledSetting: 'specdrum' }]`
    (type added to `MachineUiCapabilities` in `machine.ts`), and shown only while
    that peripheral is switched on — an inert slider for an absent device is the
    thing the existing `psgMixer` comment says to avoid. Exact lookup of the
    enabled/volume signals from a setting-key string is an implementation detail to
    settle in P4 (the store exposes individual signals, so likely a small registry).
  - Default level: scale so a full-scale DAC burst at 100 % is comparable to the
    beeper (which runs at 0.8 duty), then tune by ear against the real software.
- No `romFailed` signal, no `aux-roms.ts` or R2 hosting work.

### 3.5 Model scope

Available on **every Spectrum model** (48K → +3, all clones): the expansion bus is
common and the port is free everywhere. Not offered on non-Spectrum machines
(CPC has the unrelated Amdrum on port 0xFFxx — out of scope; see §10).

### 3.6 Status / probe

- `activity.specdrumWrites` counter (reset per frame like `ayWrites`).
- Frame-probe: light the existing `beep` LED (or `chip` where present) when the
  counter is non-zero so the indicator shows DAC activity. No new LED id unless
  you want one (see §8).

### 3.7 Persistence of machine state

- Reset: `specdrum.reset()` in `Spectrum.reset()` next to `amxMouse.reset()`;
  mixer `reset()` also clears the aux accumulator/filter.
- Snapshots: **verify** whether the SZX spec defines a SpecDrum chunk and whether
  `snapshots/szx.ts` should read/write it. The DAC has no state worth restoring
  beyond `level`, and a 1-byte loss is inaudible, so the minimum is: *ignore*
  an unknown chunk safely and do not write one. Decide after reading the SZX spec.
  `.z80` has no field for it.

### 3.8 MCP

Extend `mcp/tools/peripherals.ts` with a `specdrum` tool
(`on|off|status`; status reports `enabled`, last `level`, write count) and add it to
`mcp/README.md`. This is what lets the headless verification in §6 run.

## 4. File-by-file change list

| File | Change |
| --- | --- |
| `src/cores/zn428e.ts` | **new, done** — generic ZN428E DAC core |
| `tests/cores/zn428e.test.ts` | **new, done** — core unit tests |
| `src/machines/spectrum/peripherals/specdrum.ts` | **new** — SpecDrum interface (port decode + wraps the core) |
| `src/machines/spectrum/spectrum.ts` | field `specdrum`; `reset()`; frame-loop aux accumulate + turbo zeroing; apply gain in `applySettings` |
| `src/machines/spectrum/io.ts` | one `portOutHandler` branch |
| `src/machines/spectrum/activity.ts` | `specdrumWrites` counter + reset |
| `src/machines/spectrum/services/frame-probe.ts` | LED mapping |
| `src/machines/shared/audio-mixer.ts` | aux channel (option B) |
| `src/store/settings.ts`, `src/shell/settings.ts` | `specdrum` + `specdrum-volume` setting plumbing (`sound` reset group) |
| `src/machines/machine.ts` | `soundPeripherals` UI capability type |
| `src/machines/spectrum/descriptor.ts` | declare the SpecDrum sound peripheral |
| `src/ui/panes/SoundPane.tsx` | generic per-peripheral volume slider |
| `src/machines/spectrum/ui/hardware-section.tsx` | checkbox |
| `mcp/tools/peripherals.ts`, `mcp/README.md` | `specdrum` tool |
| `docs/machines/zx-spectrum.md`, `README.md` | document the peripheral |
| `src/ui/panes/ChangelogPane.tsx` | entry (at release time only) |

`npm run depcheck` should stay green: the new file imports only `@/machines/spectrum/*`
and shared types.

## 5. Test plan (derive expectations from the spec, not from the code)

`tests/cores/zn428e.test.ts` — **written**: power-on 0; 0x00→0 and 0xFF→exactly 1;
unsigned (0x80 ≈ 0.502, not 0); monotonic with uniform 1/255 step over all 256
codes; only the low 8 bits latch (0x100→0, −1→0xFF); holds without decay; reset;
instance independence.

`tests/peripherals/specdrum.test.ts`
- `matchPort` true for low byte 0xDF with **any** high byte (0x00DF, 0xFFDF, 0x7FDF);
  false for 0xDE, 0xDD, 0xFF, 0x1F, 0xE7 and for 0xDF-with-other-low-byte (0xDF00).
- `writePort` reaches the DAC (code 0x00 and 0xFF extremes); the activity counter ticks.
- `reset()` clears the DAC.

`tests/io-ports.test.ts` (extend)
- OUT (0xDF) while enabled updates `level`; while **disabled** does not.
- IN (0xDF) with SpecDrum enabled does **not** return the DAC level (write-only).
- SpecDrum + Kempston mouse + AMX all enabled: Kempston/AMX reads at 0xDF are
  unchanged (regression for the read/write split).
- OUT 0xDF never touches AY registers, banking, or the ULA border/beeper.

`tests/peripherals/audio-mixer.test.ts` (extend, option B)
- A constant DAC level of 0 then 255 produces a step that the DC blocker decays
  towards 0 (hard-coded expected decay from α = 1 − 2π·20/fs).
- Time-weighted duty: half a sample window at 0 and half at 255 → ~0.5 amplitude.
- Aux gain 0 ⇒ silence regardless of level; aux disabled leaves beeper-only
  output bit-identical to today (golden comparison of existing test fixtures).
- Turbo path zeroes the aux accumulator.

`tests/store/settings.test.ts` — `specdrum` default `'off'`, `specdrum-volume`
default 100; both round-trip; `resetSettingsGroup('sound')` restores the volume.

Volume wiring: with `auxGain` 0 the DAC is silent while `specdrumWrites` still
counts; 50 % yields half the amplitude of 100 % for the same code stream; master
Volume still scales it (it lives downstream in `Audio`).

## 6. Real-software verification (oracle, per project practice)

Hardware truth beats self-consistency. Test media supplied by the user (kept
outside the repo; do not commit):

- `C:\Users\damie\Desktop\Spec Drum - Side 1.tzx` (36,943 bytes, valid `ZXTape!` v1.10)
- `C:\Users\damie\Desktop\Spec Drum - Side 2.tzx` (13,709 bytes, valid `ZXTape!` v1.10)

Which side holds the program vs. the kit samples is not yet known — inspect the
block list first (BASIC loader header names, data block sizes: a drum kit is
~8 samples of a few KB each).

1. Boot a 48K, enable SpecDrum, load the program with the `load` MCP tool.
2. Use `port_watchpoint` on 0xDF to confirm the software writes the DAC port at a
   plausible rate when a drum is triggered (and **not** before a trigger).
3. Capture mixer output across a triggered bass drum and confirm a decaying
   waveform of the right length/amplitude (not clipped, no DC runaway).
4. Confirm the program's own detection/"is a SpecDrum fitted?" behaviour, if any,
   is satisfied — this is the only way to catch a wrong port decode.
5. Repeat on a 128K model to confirm AY + SpecDrum mix without gain clipping.

## 7. Phasing / commit boundaries

1. **P1 – core**: ZN428E core + tests (**done**, uncommitted), then the SpecDrum peripheral class + tests (no behaviour change).
2. **P2 – wiring**: `io.ts`, `spectrum.ts` field/reset, activity counter, tests.
3. **P3 – audio**: mixer aux channel + frame-loop hook + tests.
4. **P4 – UI & settings**: setting, Hardware checkbox, probe LED.
5. **P5 – MCP + docs**: `specdrum` tool, README/docs.
6. **P6 – oracle**: real-software verification (§6), fix anything it uncovers.

Each phase ends with `npx tsc --noEmit`, `npm run depcheck`, `npx vitest run`
green. Nothing is committed until you ask.

## 8. Decisions for you

1. **Mixing approach** — A (fold into beeper), **B (own mixer channel, recommended)**, or C.
   *The volume slider below effectively settles this in favour of B* (A cannot
   give the DAC an independent gain).
2. **UI** — **decided:** Hardware-pane checkbox **plus** a Sound-pane "SpecDrum"
   volume slider (§3.4).
3. **Status LED** — reuse `beep`/`chip`, or add a dedicated `dac` LED.
4. **Snapshots** — ignore the SZX chunk (recommended minimum) or read/write it
   once the SZX spec is checked.

## 9. Open questions / risks

- **Exact port decode** (fully decoded 0xDF vs partial). Mitigation: read the
  original manual; test with real software (§6.4).
- **DC behaviour**: ZN428E is unsigned; the DAC idling at a non-zero value must not
  produce an audible thump on enable/reset. The aux DC blocker covers it; add a
  one-shot "prime" so the first write after enable doesn't pop.
- **Aliasing**: software plays 8–16 kHz samples; mixing at 44.1/48 kHz with
  box-averaged duty is adequate, but a very high-rate sample loop (>20 kHz)
  could alias — measure with the oracle.
- **Mixer is shared** by every machine: keep the aux path behind a flag so other
  machines' audio is bit-identical (the golden-fixture test in §5 guards this).
- **Sync via EAR/MIC**: out of scope; nothing in the shipped software needs it.

## 10. Non-goals

- A built-in SpecDrum sequencer/UI or drum-pad panel (the original software runs).
- Cheetah Sound Sampler / MD8, Amdrum (CPC), RAM Music Machine, Covox/SoundRider —
  other interfaces. They can reuse the ZN428E core but are separate pieces of work.
- Sample import/export tooling. (The kit tapes load through the normal tape path.)

## 11. Implementation status and findings

Built exactly as §3–§5, with the decisions in §8 resolved as: own mixer channel (B),
Hardware-pane checkbox **plus** a Sound-pane slider, writes light the existing `beep`
LED, snapshots untouched (no SZX chunk is read or written; the 1-byte DAC latch is not
restored, which is inaudible).

| Phase | Result |
| --- | --- |
| P1 core + peripheral class | `cores/zn428e.ts`, `peripherals/specdrum.ts` + tests |
| P2 wiring | `io.ts` OUT branch, `Spectrum.specdrum`, reset, `activity.specdrumWrites` |
| P3 audio | `AudioMixer` aux channel (`accumulateAux` / `auxGain` / `discardAux`), frame-loop hook, turbo handling |
| P4 settings/UI | `specdrum` + `specdrum-volume` settings, Hardware checkbox, `soundPeripherals` descriptor capability, generic Sound-pane slider (shown only while fitted) |
| P5 MCP + docs | `specdrum` MCP tool, `mcp/README.md`, `docs/machines/zx-spectrum.md` |
| P6 real software | see below |

Gates at the end of the work: `tsc --noEmit` clean, depcheck clean, full suite 6242
passed / 0 failed.

### P6 — what the real Cheetah software showed (48K, `Spec Drum - Side 1/2.tzx`)

Verified headlessly (script: `mcp/.cache/specdrum-check.ts`, git-ignored):

- **Side 1 is the program** (7 blocks; loads to the SPECDRUM main menu). **Side 2 is
  song data** (36 name+data pairs, ~46–933 bytes each, repeated), *not* drum samples —
  the eight voices (KICK, SNARE, MID TOM, LOW TOM, COWBELL, HIHAT C, HIHAT O, CLAPS) come
  with the program.
- On start the program writes **0x80 to port 0xDF** — the unsigned DAC's mid-scale idle.
  That confirms the port number and means the output idles at 0.502 of full scale, so
  the mixer's DC-blocker is not optional.
- The sample players are `OUT (0xDF),A`, 25 sites at 0xFA39–0xFE65. That form puts the
  sample on A8–A15 as well, which is why the decode must ignore the high byte.
- In DRUM PLAY (pattern screen → D, "DRUMS ON Press space to Stop") it streams
  ~403 writes per 50 Hz frame (≈ 20.1 kHz) around 0x80. (An early idle-only probe saw
  codes 112–149; real song playback, measured later in §12, swings 38–212.)

**Not verified:** audible correctness against real hardware, and the amplitude. Drum
hits only swing ±18 codes around 0x80 (≈ 11 % of full scale after the blocker). Either
the player deliberately attenuates to leave headroom for three-voice mixing, or the
drum keys are not triggering the full-range samples. The 20 kHz stream and the
per-key differences suggest the former, but this needs listening / a second reference.
The synthetic square-wave test (`specdrum-wiring.test.ts`) covers the DAC→mixer path
independently of the software. Default slider level (100 %) may want tuning by ear.

## 12. Audio review follow-up (muffled / clicky report)

An independent review of the demo snapshot (`zx84-zx48k.szx`: the SpecDrum program
playing its "Demo" song, ~402 DAC writes per frame plus a 1 ms MIC tick every 3
frames) measured the output against an exact T-state-resolution reference. Findings and
what was done:

| Finding | Fix |
| --- | --- |
| DC thumps ~2× a drum peak: first write after load/reset (latch reset to 0, not 0x80), toggle on/off, `mixer.reset()` | `SpecDrum.IDLE_CODE = 0x80` (constructor and reset). The mixer takes the DAC as a **signed level centred on idle** (`SpecDrum.signedLevel = (code - 128) / 128`, -1..+127/128), so idle is exactly 0 and fitting, removing or resetting it at idle cannot step the output — no priming, seeding or fade-out needed for the aux channel (the 20 Hz high-pass still removes a DC level if software parks the DAC off-centre). The *beeper* filter is primed on its first sample after construction/reset (shared). `Spectrum.setSpecdrumFitted()` is the one entry point (Hardware pane, settings, MCP) |
| Quiet (−28 dBFS rms) and gain capped at 1, so the MIC tick out-shouted the drums | aux amplitude 0.8 at a signed level of ±1 (a full DAC swing now spans 1.6, twice the beeper's; it was 0.8 before); `auxGain` 0..2; the Sound-pane slider runs 0–200 % |
| Instruction straddling an output-sample boundary was averaged into both samples (smear, worst at 8–16 kHz) | the mixer cuts the straddling accumulate call at the boundary (exact for the single-call case; proportional spreading kept for catch-up). Shared by every machine |
| Turbo zeroed `beeperTStatesAccum` but not the duty, so the first sample after turbo could exceed 1 and clip | `discardPending()` (beeper + aux) used by the Spectrum and Jupiter Ace turbo paths |
| 1–2 dB high-frequency droop (boxcar at the output rate); alias excess near Nyquist | **Not changed.** Inherent to the shared design; a band-limited (blip-style) step would be a separate, all-machine change |
| MIC tick (0.1 of EAR) is prominent | **Not changed.** It is the measured Issue 3 ULA voltage mapping (`ULA_SPEAKER_LEVEL`), a deliberate hardware-accurate value; the drums are now ~2× louder relative to it. A mute-MIC option remains a possible follow-up |
| OUT's level applied for the whole instruction (~10 T lead) | **Not changed.** Inaudible (fixed 2.9 µs delay) |

Re-measured on the same demo after the fixes: SpecDrum-off step 0.444 → 0.000, SpecDrum-on
step 0.081 → 0.000, turbo-release (`mixer.reset()`) step now equals only the instantaneous
signal value (0.07) instead of a fixed DC offset (0.41). Steady-state peak rose from
~0.21–0.29 to 0.356.

Tests added: filter priming, exact straddle split (checked against a T-by-T integration
of the same event stream), `discardPending`, aux priming/seeding/release/re-enable,
and machine-level fit/remove/reset transients.

### Revision: signed, centred DAC (matches the reference emulator's approach)

A first pass fixed the thumps by priming the DAC's DC-blocker on activation, seeding the
accumulator when fitted mid-window, and fading the channel out on removal (`releaseAux`).
That was replaced by the simpler convention the `Release\src` reference uses: centre the
DAC on its idle code (-128..+127 around 0x80) so idle is zero by construction. Removed:
`releaseAux`, the aux priming/seeding/release state. Kept: the DC-blocker (for a DAC parked
off-centre), the shared sample-boundary split, `discardPending`, the beeper priming.

Consequence: removing the SpecDrum while a drum is mid-sample steps the output by at most
the waveform's own value (a drum cut short), never by a fixed DC offset. Re-measured with the
real SpecDrum program streaming DRUM PLAY audio (the earlier demo snapshot was no longer
available): reset, OFF and ON all step by 0.000–0.002.
