# Changelog

## 0.3.0

### Tape & loading

- Tape now auto-stops almost instantly when a loader gives up reading — previously it waited ~500ms before pausing; now it responds within a few hundred microseconds by watching for port-read gaps.
- The tape pane shows which loader is actively reading (e.g. "ROM loader"), making it easier to know what the machine is doing.
- Fixed pilot-tone selection in TAP and TZX files so loaders that rely on flag-byte bit 7 now load correctly.
- TZX nested-loop blocks now expand properly.
- Tape ROM trap edge cases now match the behaviour of Fuse, JSpeccy, and ZEsarUX.

### Debugger

- Step-over now correctly handles block-repeat instructions (LDIR, LDDR, CPIR, CPDR, INIR, INDR, OTIR, OTDR) — previously it would single-step one iteration and stop; it now runs the whole block to completion.
- Step-over and step-out no longer hang or exit early when the stack pointer wraps around 0xFFFF/0x0000.
- The disassembly view always includes the current PC instruction, even when PC falls right at the edge of the display window.
- Fixed disassembler instruction-length calculation at address 0xFFFF.
- Fixed several BASIC parser bugs that could produce wrong output for certain program structures.

### Input & gamepads

- Gamepad buttons no longer stick when you switch to another window while a direction is held — all buttons are now properly released on focus loss.
- Cancelling gamepad configuration no longer leaves stale bindings that block re-use of the same buttons next time.
- Configuring player 2's gamepad with only one controller connected no longer silently remaps player 1's controller instead.
- Fixed Caps Shift leaking into the keyboard state when using cursor-joystick mode.

### Audio

- Fixed a beeper audio glitch where restoring a snapshot or stepping by frame could produce a burst of samples with wrong duty cycle.
- Beeper DC filter is now correctly initialised so audio works even before the sample rate is set.
- AY and beeper gain values are clamped to a safe range — no more accidental phase inversion from out-of-range settings.

### +3 / Floppy

- Fixed floppy drive sound effects: click and seek audio no longer overlap or cut off early due to scheduling races.
- Disk images using Simon Owen's v5 multi-copy weak-sector format now load correctly.

### Snapshots

- SNA saves now correctly record which 128K RAM bank was paged in (read from port 7FFD rather than guessing).
- Fixed `.z80` snapshot single-ED byte encoding to match the World of Spectrum specification.
- Fixed `.z80` ED-ED compressed pair counting (off-by-one that could corrupt saves).
- Fixed SZX 128K detection for Timex and NTSC machine IDs.
- Fixed SP snapshot 48K/128K detection threshold.

### Display & compatibility

- Falls back to the Canvas renderer automatically when WebGL is unavailable, rather than showing a blank screen.
- VTX-5000 Prestel modem now correctly preserves the upper half of the Spectrum ROM when its overlay is active.
- ROM manager recovers gracefully from IndexedDB errors and no longer issues duplicate load requests for the same ROM.
- Model identifier corrected from `+2a` to `+2A` everywhere for consistency.

## 0.2.11

- File open dialogs now use `showOpenFilePicker` (Chromium) with separate `id` values per file type (snapshot, tape, disk, ROM, font), so each picker remembers its own last-used folder independently. Falls back to `<input type="file">` on unsupported browsers.
