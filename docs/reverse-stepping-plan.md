# Reverse Stepping (Time-Travel Debugging) — Future Plan

## Overview

Add the ability to step backwards through Z80 instructions in the debugger,
reversing CPU state, memory, T-states, and peripheral state.

## Total State Surface

- **~200 KB** core emulation state (memory dominates at 196 KB)
- CPU registers (~128 bytes), ULA (~32 bytes), AY (~128 bytes), FDC (~512 bytes),
  tape (~512 bytes), keyboard (8 bytes)
- Pixel buffer is a rendering artifact — doesn't need reversing

## Recommended Strategy: Frame Snapshots + Intra-Frame Deltas

Take a full ~220 KB snapshot at each frame boundary, then log only deltas
(memory writes + old values, register changes) within the frame.

- **Step back within a frame:** undo deltas in reverse order.
- **Step back across a frame boundary:** restore the previous frame snapshot,
  then replay forward to the desired instruction.

### Memory cost: ~1–10 MB per minute of recording
### Runtime overhead: ~5–15% when recording is active

## Alternative Strategies Considered

| Strategy | Memory Cost | Complexity | Notes |
|----------|-----------|-----------|-------|
| Full snapshot per instruction | ~660 MB/min | Low code | Only viable for short traces |
| Undo log (deltas only) | ~5–15 MB/min | Medium | No frame-boundary anchor; rewinding far is slow |
| **Frame snapshots + deltas** | **~1–10 MB/min** | **Medium** | **Best balance — recommended** |

## Hard Parts

### 1. Instrumenting `cpu.step()`
Currently doesn't expose which addresses it wrote or pre-contention T-states.
Need to add write logging — either:
- Wrap `memory.write()` / `memory.contendedWrite()` with an undo hook
- Or add a recording layer in the memory subsystem itself

This is the biggest refactor. Every memory write during instruction execution
must capture `(address, oldValue)` into the undo log.

### 2. FDC Disk Mutations
`WRITE_DATA` overwrites sector data in-place (`track.sectors[idx].data`).
Options:
- Shadow copy of modified sectors (copy-on-write)
- Per-sector undo entries in the delta log
- Snapshot entire disk state at frame boundaries (expensive for large DSKs)

### 3. AY Noise LFSR
The 17-bit LFSR is mathematically reversible (linear recurrence — shift right
and extract feedback bit). Needs careful implementation but is tractable.

### 4. Contention Timing
Contention delays are non-invertible: can't subtract the delay without knowing
the pre-contention T-state. Solution: save `tStates` before and after each
instruction in the delta log.

## Easy Parts

- **Registers:** trivial to snapshot/restore (~128 bytes)
- **Memory banking:** save port values (0x7FFD, 0x1FFD)
- **Keyboard:** 8-byte register, no side effects
- **ULA:** borderColor, flashCounter, flashState — all small integers
- **Tape position:** block index + phase + counters — complex state machine but
  fully deterministic given a complete snapshot
- **Rendering:** just re-render from restored state, no reversal needed
- **Audio:** accept that samples already sent to Web Audio are gone (cosmetic)

## Implementation Sketch

### New types

```typescript
interface InstructionDelta {
  pc: number;              // PC before instruction
  tsBefore: number;        // tStates before
  tsAfter: number;         // tStates after
  regsBefore: Uint16Array; // snapshot of changed registers
  memWrites: Array<{ addr: number; oldVal: number }>;
  // Optional: port writes, AY state, etc.
}

interface FrameSnapshot {
  frameNumber: number;
  cpu: CpuState;           // all registers, flags, interrupt state
  memory: Uint8Array;      // full 64KB flat snapshot (or bank-aware)
  bankState: BankState;    // port7FFD, port1FFD, etc.
  ula: UlaState;           // border, flash, beeper
  ay?: AyState;            // registers, counters, LFSR
  tape?: TapeState;        // position, phase, counters
  fdc?: FdcState;          // phase, buffers, drive state
}
```

### Recording flow

1. At frame start: push `FrameSnapshot` onto a ring buffer (capped at N frames)
2. Before each `cpu.step()`: begin recording deltas
3. Memory write hook: push `{ addr, oldVal }` into current delta
4. After `cpu.step()`: finalize delta with tsAfter, push onto frame's delta list

### Reverse-step flow

1. Pop the most recent `InstructionDelta`
2. Restore `pc` and `tStates` from delta
3. Reverse all `memWrites` (write `oldVal` back)
4. Restore registers from `regsBefore`
5. If no more deltas in current frame and user steps back again:
   restore previous `FrameSnapshot` and replay forward to last instruction

## Estimated Effort

- **500–1500 lines** of new code
- Key files affected: `Z80.ts`, `memory.ts`, `spectrum.ts`, MCP server / harness
- Possibly a new `src/debug/undo.ts` or `src/debug/time-travel.ts` module
