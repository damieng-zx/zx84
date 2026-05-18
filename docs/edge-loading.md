# Edge-Loading and Loader Detection — Implementation Plan

This document specifies how "edge loading" (tape acceleration by skipping the
edge-finding loop in the Z80 loader) and automatic loader detection work in a
mature reference implementation. It is meant as an independent spec we can
implement in our own emulator.

The design has three cooperating pieces:

1. **Auto-play / auto-stop detection** — sniffs the cadence of `IN A,(0xFE)`
   reads to decide when to start or stop the tape automatically.
2. **Loader fingerprinting** — when an `IN A,(0xFE)` happens, scan the bytes
   around it to recognise one of a handful of well-known edge-finding loops
   and classify the loader as *increasing-B* or *decreasing-B*.
3. **Edge acceleration** — when the next tape edge length is known, skip the
   busy loop entirely: simulate its `RET`, set B/C/F to plausible exit values,
   and advance the tape to the next edge immediately.

The whole thing is opt-in via two independent settings:
`detect_loader` (auto play/stop) and `accelerate_loader` (edge skipping).

---

## 1. Trigger point

All of the logic is driven from a single hook: every read of the ULA port
(`IN A,(0xFE)` and friends). In our codebase that is `ULA.readPort()` /
`io-ports.ts`. The hook is called *before* the byte is returned to the CPU, so
the detector sees the current `PC`, `BC`, `AF`, and the current cycle count.

State retained across calls:

```
last_tstates_read    : signed T-state of the previous IN A,(0xFE)  (init: -∞)
last_b_read          : value of B at the previous IN                (init: 0)
successive_reads     : number of consecutive "loader-shaped" reads (init: 0)
acceleration_mode    : NONE | INCREASING | DECREASING               (init: NONE)
acceleration_pc      : PC of the IN we are currently accelerating
length_known1/2      : flags – next/prev tape edge length is known
length_long1/2       : flags – that edge is a "long" pulse
```

`last_tstates_read` is stored in the same cycle counter that the CPU uses, so
it must be decremented by `frame_length` at the end of every frame to stop it
overflowing or being misinterpreted after a frame reset. We expose a
`loader.frame(frameTstates)` call for that.

When the tape stops or starts, `successive_reads` and `acceleration_mode` are
both reset.

---

## 2. Auto-play / auto-stop heuristic

Run this block first on every IN-FE, regardless of acceleration.

```
tstates_diff = tstates - last_tstates_read
b_diff       = (B - last_b_read) & 0xFF
last_tstates_read = tstates
last_b_read       = B

if (tape is playing) {
    /* Looking for the loader to have stopped polling */
    if (tstates_diff > 1000
        || (b_diff != 0 && b_diff != 1 && b_diff != 0xFF)) {
        successive_reads++;
        if (successive_reads >= 2) tape.stop();
    } else {
        successive_reads = 0;
    }
} else {
    /* Looking for the loader to have started polling */
    if (tstates_diff <= 500 && (b_diff == 1 || b_diff == 0xFF)) {
        successive_reads++;
        if (successive_reads >= 10) tape.play(/*autoplay*/ true);
    } else {
        successive_reads = 0;
    }
}
```

The two thresholds (`1000` and `500` T-states between reads) reflect the fact
that a real ROM-style edge-finding loop hits the IN once every ~30–60 T,
whereas user code only touches `0xFE` sporadically. The `b_diff` check
captures the canonical loader shape — B is either being incremented (search
for next edge) or decremented (Digital Integration), so the legal diffs are
`+0`, `+1`, `-1`.

Auto-stop fires after just **2** out-of-shape reads — the reference treats
this very aggressively so the tape stops as soon as the program leaves the
loader. Auto-start needs **10** consecutive in-shape reads, to avoid
mis-starting on incidental reads during normal play.

---

## 3. Fingerprinting the loader

If `accelerate_loader` is enabled and the tape is playing, after the auto
play/stop logic we check whether we should accelerate the current IN.

```
if (acceleration_mode != NONE && PC != acceleration_pc) {
    acceleration_mode = NONE;          /* loader changed — re-detect */
}
if (acceleration_mode == NONE) {
    acceleration_mode = detect(PC - 6);
    acceleration_pc   = PC;
}
if (acceleration_mode != NONE) accelerate();
```

The detector walks bytes forward from `PC - 6` (i.e. six bytes before the
instruction that *follows* the `IN`). This is the byte at the very start of
the canonical edge-loop body, where almost every well-known loader puts an
`INC B` / `DEC B` / data byte that makes a useful first discriminator. The
detector is a small handwritten state machine — opcode bytes are matched
exactly and the immediate operands are anchored to known values.

### 3.1 Patterns the detector recognises

All sequences are read by the detector via direct memory reads (no contention,
no breakpoints, no M1). They are matched **byte-exactly** unless noted.

**A. Classic ROM-style "increasing B" loaders** (`INC B / RET Z / LD A,n /
IN A,(0xFE) / RRA / ... / XOR C / AND 0x20 / JR NZ,-N / JR Z,-M`):

```
04          INC B
C8          RET Z
3E xx       LD A, 0x00 | 0x7F | 0xFF   ; 0x00 = "Search Loader",
                                       ; 0x7F = ROM loader + variants,
                                       ; 0xFF = Dinaload
DB FE       IN A,(0xFE)
1F          RRA
xx          one of:
               00  NOP        (Bleepload)
               A7  AND A      (Microsphere)
               C8  RET Z      (Paul Owens)
               D0  RET NC     (ROM loader)
               A9  XOR C      (Speedlock — folds directly into XOR C)
[A9]        XOR C            (skipped if previous byte was A9 already)
E6 20       AND 0x20
28 xx       JR Z, -count     ; final byte must equal 0x100 - count,
                             ; i.e. a backward jump to the start of the
                             ; matched window. This is the anchor check.
```

When matched, classify as **INCREASING**.

**B. Search Loader variant** (uses `XOR C / AND 0x40 / RET C / NOP`):

```
04 C8 3E 00 DB FE A9 E6 40 (28 ..) | (D8 00 28 ..)
```

Same final anchor (`28 xx`, xx = 0x100 - count). Classify as **INCREASING**.

**C. Digital Integration "decreasing B" loader**:

```
05          DEC B
C8          RET Z
DB FE       IN A,(0xFE)
A9          XOR C
E6 40       AND 0x40
CA lo hi    JP Z, <self>      ; lo/hi must equal PC-4
```

(Note: the detector enters this branch via state 13/14, so the first byte at
`PC-6` is a wildcard — only the *second* byte is required to be `0x05`.) When
matched, classify as **DECREASING**.

**D. Alkatraz loader**:

```
03          (data byte of a JR NZ that lands here)
C3 lo hi    JP nnnn           ; target wildcard
DB FE       IN A,(0xFE)
1F          RRA
C8          RET Z
A9          XOR C
E6 20       AND 0x20
28 xx       JR Z, ..
F1 | F3     final data byte (0xF1 normal, 0xF3 variant)
```

Classify as **INCREASING**.

**E. "Variant" Alkatraz** (entry from state 1 via `0x20`, `0x01`, `0xC9`):

```
04 20 01 C9    INC B / JR NZ +1 / .. / RET     (then same Alkatraz tail)
```

Classify as **INCREASING**.

### 3.2 Important properties of the detector

- It is purely structural: it never executes code, never traps, never patches
  ROM. It just looks at memory.
- It is anchored: the final `JR` operand or `JP` operand must agree with the
  matched window length / current PC, which eliminates almost all
  false-positives.
- It is paging-aware *only* in the sense that it reads through the current
  Z80 memory map — if the ROM is paged out, the bytes that get tested are
  whatever is currently in slot 0.
- Recognising a loader does not change emulator state. The actual
  acceleration step does.

---

## 4. The acceleration step

Edge acceleration only fires if `length_known1` — i.e. we know how long the
*next* tape edge is. The way we learn that is described in §5.

When a recognised IN is encountered and the next edge length is known:

```
function accelerate() {
    if (!length_known1) goto rotate;

    /* 1. Force B to a value the loader will treat as a finished edge.
          B is the loader's pulse-length counter; making it 0xFE means
          "very long edge", 0x00 means "very short edge". Which we want
          depends on whether the loader counts up or down and on whether
          the upcoming pulse is long or short. */
    bool set_b_high = length_long1;
    if (acceleration_mode == DECREASING) set_b_high = !set_b_high;
    B = set_b_high ? 0xFE : 0x00;

    /* 2. Bit 5 of C carries the current EAR/MIC level in many loaders.
          Reflect the current tape input there. */
    C = (C & ~0x20) | (tape_microphone ? 0x00 : 0x20);

    /* 3. Set CF so the conditional that exits the inner loop fires. */
    F |= 0x01;

    /* 4. Skip the rest of the loop by popping the return address. The
          edge-finder is always entered via CALL, so SP currently points
          at the return address. Pop it into PC and bump SP by 2. */
    PC_lo = readByte(SP); SP++;
    PC_hi = readByte(SP); SP++;

    /* 5. Cancel the currently-scheduled tape edge and immediately ask the
          tape engine for the next one, as if "now" were exactly the moment
          that next edge should fire. This is the actual time-skip — the
          tape advances to the edge boundary in one step instead of running
          the Z80 through hundreds of polling iterations. */
    event_remove(TAPE_EDGE);
    tape.nextEdge(currentTstates, /*from_acceleration*/ true);

    successive_reads = 0;

rotate:
    /* Rotate the two-slot length pipeline: edge2 becomes edge1. */
    length_known1 = length_known2;
    length_long1  = length_long2;
}
```

Three subtleties:

- **The `RET` simulation must read through whatever is currently in slot 0**
  (i.e. the live memory map). Don't bypass paging.
- **`from_acceleration=true`** is critical (see §5).
- The length pipeline only rotates if there *was* a known length to apply;
  otherwise nothing is consumed.

The IN itself still returns its normal byte to the CPU — the acceleration
hijacks `PC` and the registers, so the loader exits its loop as soon as the
IN completes.

---

## 5. Knowing the next edge length

The tape engine yields one edge at a time and reports flags for each edge.
Two of those flags are relevant here:

```
TAPE_FLAGS_LENGTH_SHORT     /* this edge is a "short" pulse  */
TAPE_FLAGS_LENGTH_LONG      /* this edge is a "long" pulse   */
```

These are set on **pure-tone** and **data** pulses where the engine knows the
nominal length category. They are not set on pauses, mic-only edges, or
arbitrary TZX pulse arrays.

Every time the tape engine schedules the next edge, it must call back into
the loader with these flags:

```
function tape_set_acceleration_flags(flags, from_acceleration) {
    if (flags & LENGTH_SHORT) { length_known2 = 1; length_long2 = 0; }
    else if (flags & LENGTH_LONG)  { length_known2 = 1; length_long2 = 1; }
    else                           { length_known2 = 0; }

    /* If the edge that *just* fired was a normal, scheduled edge (not one
       we manufactured during acceleration) then invalidate the *previous*
       length entry so the next IN can't accelerate. Without this, the
       loader misses one edge after the auto-detector first re-locks. */
    if (!from_acceleration) length_known1 = 0;
}
```

So the pipeline carries two slots:

- `length_known2/long2` — the edge the tape engine just scheduled.
- `length_known1/long1` — the edge before that, which is the one the
  loader is currently inside.

`accelerate()` consumes slot 1 and then promotes slot 2 into slot 1.

The `from_acceleration` flag is the fix for an off-by-one bug that
otherwise drops one edge whenever the detector first kicks in.

---

## 6. Lifecycle and integration points

| Hook | What it does |
|------|--------------|
| ULA reads port 0xFE | call `loader.onULARead()` — runs §2 then §3/§4 |
| Tape `play()` starts | reset `successive_reads`, `acceleration_mode` |
| Tape `stop()` | same |
| Tape engine schedules next edge | call `loader.setAccelerationFlags(flags, fromAcceleration)` |
| End of frame | call `loader.frame(frameTstates)` to slide `last_tstates_read` |

Conditions under which everything is skipped:

- `detect_loader = false` — auto play/stop disabled; just reset
  `successive_reads` on each IN.
- `accelerate_loader = false` or the tape is not playing — skip §3/§4.
- RZX recording in progress — skip §3/§4 (acceleration would desync the
  recorded input stream).

---

## 7. What this does *not* try to do

- It does not patch the ROM or insert traps. It is a pure observer-plus-edge
  shortcut.
- It does not understand TZX custom-loader blocks beyond the
  short/long/unknown classification the tape engine already exposes.
- It does not attempt to defeat heavily-encrypted loaders (Speedlock 7+,
  Alkatraz tape variants past the simple onion shell). For those the only
  reliable acceleration path is full-speed-emulation while the loader runs.
- It does not interact with the +3 disk system at all.

---

## 8. Suggested mapping into our codebase

- New file `src/tape/edge-loader.ts` holding the state machine, the detector
  and the accelerator. Pure functions plus a small mutable state object;
  exported singleton.
- `src/io-ports.ts` calls `edgeLoader.onULARead(z80, tape, tstates)` on every
  read of port `0xFE`. Existing loader-signature detection in
  `src/tape/loader-detect.ts` / `loader-signature.ts` should be reviewed for
  overlap — the structural detector here probably subsumes the
  signature-based one for the loaders it covers, but the existing detector
  may catch ones this scheme doesn't.
- `src/spectrum.ts` calls `edgeLoader.endFrame(frameTstates)` once per frame
  (right where the frame-bridge runs).
- `src/tape/tape-loader.ts` (or wherever edges are scheduled) calls
  `edgeLoader.setAccelerationFlags(flags, fromAcceleration)` after
  computing the next edge.
- `src/tape/tap.ts` and `src/tape/tzx.ts` need to emit
  SHORT/LONG length flags on pure-tone and data pulses. This is the
  single most invasive part of the change — without those flags
  acceleration cannot fire.
- Settings: two booleans in the existing settings store
  (`detectLoader`, `accelerateLoader`), defaulting to on.

Recommended order of work:

1. Plumb the SHORT/LONG flags through the tape pipeline first; verify with
   logging that they fire on real TAPs.
2. Add the state object + the auto play/stop heuristic (§2). Test against a
   handful of TAPs — tape should start/stop on its own at the right moments.
3. Add the structural detector (§3). Log matches; verify against ROM loader,
   Speedlock, Bleepload, Digital Integration, Alkatraz.
4. Add the accelerator (§4). Measure: a 3-minute TAP should now load in
   well under a second of wall-clock time at uncapped frame rate.
5. Wire the `from_acceleration` flag and confirm the "first edge after lock"
   is not dropped (§5).
