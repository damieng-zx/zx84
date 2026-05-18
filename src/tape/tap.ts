/**
 * TAP tape image format parser + pulse-level tape playback engine.
 *
 * TAP files contain a sequence of data blocks, each prefixed with a 2-byte
 * little-endian length. Each block's first byte is the flag byte and the last
 * byte is an XOR checksum. The payload is everything between flag and checksum.
 *
 * The playback engine converts blocks to pulse sequences (pilot, sync, data,
 * tone, pulses, direct) and feeds the EAR bit based on T-state timing. This
 * allows both standard ROM loading and custom loaders that read the EAR port
 * directly.
 */

// ── Edge-length flags for surgical loader acceleration ───────────────────
//
// Published to a registered listener whenever the playback engine schedules
// a new pulse. The loader uses these to know whether the upcoming edge is
// a "short" or "long" pulse so it can set the loader's B counter to a
// plausible exit value before popping the CALL return address.
// See docs/edge-loading.md §5.

export type EdgeLengthFlags = 'short' | 'long' | 'unknown';

// ── TapeBlock discriminated union ─────────────────────────────────────────

export interface DataBlock {
  kind: 'data';
  flag: number;
  data: Uint8Array;
  pause: number;              // ms
  pilotPulse: number;         // T-states (0 for pure-data)
  syncPulse1: number;
  syncPulse2: number;
  bit0Pulse: number;
  bit1Pulse: number;
  pilotCount: number;         // 0 = skip pilot/sync (pure-data)
  usedBits: number;           // last byte
  source: 'tap' | 'standard' | 'turbo' | 'pure-data';
}

export interface ToneBlock     { kind: 'tone'; pulseLen: number; count: number; }
export interface PulsesBlock   { kind: 'pulses'; lengths: number[]; }
export interface PauseBlock    { kind: 'pause'; duration: number; }  // 0 = stop tape
export interface DirectBlock   { kind: 'direct'; tStatesPerSample: number; pause: number; usedBits: number; data: Uint8Array; }
export interface SetLevelBlock { kind: 'set-level'; level: number; }
export interface StopIf48KBlock { kind: 'stop-if-48k'; }
export interface GroupStartBlock { kind: 'group-start'; name: string; }
export interface GroupEndBlock { kind: 'group-end'; }
export interface TextBlock     { kind: 'text'; text: string; }
export interface ArchiveInfoBlock { kind: 'archive-info'; entries: { id: number; text: string }[]; }

export type TapeBlock = DataBlock | ToneBlock | PulsesBlock | PauseBlock | DirectBlock
  | SetLevelBlock | StopIf48KBlock | GroupStartBlock | GroupEndBlock | TextBlock | ArchiveInfoBlock;

// ── Standard Spectrum tape timing (T-states per half-cycle) ──────────────

const PILOT_PULSE = 2168;
const PILOT_HEADER = 8063;  // pilot pulses for header blocks (flag=0x00)
const PILOT_DATA = 3223;    // pilot pulses for data blocks (flag=0xFF)
const SYNC_1 = 667;
const SYNC_2 = 735;
const BIT_0 = 855;
const BIT_1 = 1710;
const PAUSE_DEFAULT_MS = 1000;


const enum TapePhase {
  IDLE,
  PILOT,
  SYNC1,
  SYNC2,
  DATA,
  PAUSE,
  TONE,
  PULSES,
  DIRECT,
}

export class TapeDeck {
  blocks: TapeBlock[] = [];
  position = 0;
  paused = false;

  /** Whether the machine is a 48K model (used by stop-if-48k blocks) */
  is48K = false;

  /** CPU clock speed in Hz (affects pause/timing calculations) */
  cpuClock: number;

  constructor(cpuClock: number) {
    this.cpuClock = cpuClock;
  }

  // ── Playback engine state ──────────────────────────────────────────────

  /** Current EAR output bit (0 or 1) */
  earBit = 0;

  /** Whether the tape player is actively running */
  playing = false;

  /**
   * Optional listener for edge-length flags. Called every time the playback
   * engine schedules a new pulse — i.e. whenever pulseLen changes. Used by
   * EdgeLoader to know the category (short/long/unknown) of the upcoming
   * edge for surgical loader acceleration. See docs/edge-loading.md §5.
   */
  onEdgeScheduled: ((flags: EdgeLengthFlags, fromAcceleration: boolean) => void) | null = null;

  /** Set to true by EdgeLoader before calling advance() during an acceleration
   *  step, so onEdgeScheduled callbacks can flag the resulting edge as
   *  "manufactured" rather than naturally scheduled. */
  inAcceleration = false;

  /** Optional listener for tape play-state transitions (start/stop). Used
   *  by EdgeLoader to reset its successive-reads counter and acceleration
   *  mode on any play boundary. §6 of docs/edge-loading.md. */
  onPlayStateChange: (() => void) | null = null;

  private phase: TapePhase = TapePhase.IDLE;
  private playbackIdx = -1;

  /** Pilot tone pulses remaining */
  private pilotRemaining = 0;

  /** Current pulse length in T-states */
  private pulseLen = 0;

  /** T-states accumulated within the current pulse */
  private tInPulse = 0;

  /** Reconstructed raw block data (flag + payload + checksum) for data blocks */
  private rawData: Uint8Array | null = null;

  /** Data phase position */
  private byteIdx = 0;
  private bitIdx = 0;       // 7 down to 0 (MSB first)
  private pulseHalf = 0;    // 0 or 1 (two half-cycles per data bit)

  /** Number of used bits in the last byte (default 8) */
  private usedBitsLast = 8;

  /** Pause remaining in T-states */
  private pauseRemaining = 0;

  /** T-states until the mid-pause EAR flip. Per TZX spec, when a data block
   *  ends with a pause, the tape holds the last edge level for ~1ms then
   *  flips to the OPPOSITE level for the remainder of the pause. Loaders
   *  like Speedlock 7 rely on this flip as the "end of block" signal. -1
   *  means no pending flip. */
  private pauseFlipAt = -1;

  /** Per-block timing (from DataBlock) */
  private bPilot = PILOT_PULSE;
  private bSync1 = SYNC_1;
  private bSync2 = SYNC_2;
  private bBit0 = BIT_0;
  private bBit1 = BIT_1;

  /** Tone block: pulses remaining */
  private toneRemaining = 0;

  /** Pulses block: current index into lengths array */
  private pulsesIdx = 0;
  private pulsesLengths: number[] = [];

  /** Direct block state */
  private directData: Uint8Array | null = null;
  private directTStatesPerSample = 0;
  private directByteIdx = 0;
  private directBitIdx = 0;
  private directUsedBitsLast = 8;
  private directPauseMs = 0;


  // ── TAP parser ─────────────────────────────────────────────────────────

  /** Parse a TAP file and return blocks without modifying deck state */
  parseTAP(fileData: Uint8Array): TapeBlock[] {
    const blocks: TapeBlock[] = [];
    let offset = 0;
    while (offset + 2 <= fileData.length) {
      const blockLen = fileData[offset] | (fileData[offset + 1] << 8);
      offset += 2;

      if (blockLen < 2 || offset + blockLen > fileData.length) break;

      const flag = fileData[offset];
      // Payload is everything between flag and checksum
      const data = fileData.slice(offset + 1, offset + blockLen - 1);

      blocks.push({
        kind: 'data',
        flag,
        data,
        pause: PAUSE_DEFAULT_MS,
        pilotPulse: PILOT_PULSE,
        syncPulse1: SYNC_1,
        syncPulse2: SYNC_2,
        bit0Pulse: BIT_0,
        bit1Pulse: BIT_1,
        // Per ZX Spectrum ROM SAVE-BYTES: pilot length is selected by the
        // high bit of the flag byte — flag < 0x80 emits the long header
        // pilot (8063 pulses), flag >= 0x80 emits the short data pilot
        // (3223 pulses). Only the high bit matters, not equality with 0x00.
        pilotCount: flag < 0x80 ? PILOT_HEADER : PILOT_DATA,
        usedBits: 8,
        source: 'tap',
      });
      offset += blockLen;
    }
    return blocks;
  }

  /** Parse a TAP file into blocks (legacy — sets deck state) */
  load(fileData: Uint8Array): void {
    this.blocks = this.parseTAP(fileData);
    this.position = 0;
    this.paused = false;
    this.stopPlayback();
  }

  /**
   * Look at the next ROM-loadable data block WITHOUT consuming it.
   * Only returns standard/turbo/tap DataBlocks — never pure-data, tone,
   * pulses, or direct blocks (those are for EAR-reading custom loaders).
   *
   * Side-effects are limited to advancing past cosmetic blocks (text,
   * archive-info, group markers, non-zero pause) and triggering a
   * tape-stop on duration=0 pause or 48K-stop blocks. The data block
   * itself is left in place so a caller that decides not to commit
   * (e.g. ROM trap rejecting on length mismatch) can fall through to
   * real-time tape playback without the block disappearing.
   */
  peekDataBlock(): DataBlock | null {
    while (this.position < this.blocks.length) {
      const block = this.blocks[this.position];

      if (block.kind === 'data') {
        if (block.source === 'pure-data') {
          // Pure data is for custom loaders reading EAR, not the ROM trap
          return null;
        }
        return block;
      }

      // Custom loader blocks — stop here, don't scan past them
      if (block.kind === 'tone' || block.kind === 'pulses' || block.kind === 'direct') {
        return null;
      }

      // Pause: duration=0 means "stop tape"
      if (block.kind === 'pause') {
        if (block.duration === 0) {
          this.paused = true;
          this.position++;
          return null;
        }
        // Non-zero pause: skip (ROM trap bypasses inter-block gaps)
        this.position++;
        continue;
      }

      // Stop if 48K
      if (block.kind === 'stop-if-48k') {
        if (this.is48K) {
          this.paused = true;
          this.position++;
          return null;
        }
        this.position++;
        continue;
      }

      // Cosmetic / control blocks: skip
      this.position++;
    }
    return null;
  }

  /**
   * Return the next ROM-loadable data block AND advance past it.
   * Equivalent to peek + commit. Used after a ROM trap successfully
   * loads the block; the caller should follow with skipBlock() to
   * restart playback at the new position.
   */
  nextDataBlock(): DataBlock | null {
    const block = this.peekDataBlock();
    if (block) this.position++;
    return block;
  }

  /**
   * Peek ahead: returns true if there's a ROM-loadable DataBlock before any
   * custom loader blocks. Used to decide whether the ROM trap should fire
   * (prevents busy-loop retries when only custom blocks remain).
   */
  hasRomBlock(): boolean {
    for (let i = this.position; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (block.kind === 'data') return block.source !== 'pure-data';
      if (block.kind === 'tone' || block.kind === 'pulses' || block.kind === 'direct') return false;
      if (block.kind === 'pause' && block.duration === 0) return false;
      if (block.kind === 'stop-if-48k' && this.is48K) return false;
      // cosmetic/pause blocks: continue scanning
    }
    return false;
  }

  /** Reset playback to the beginning */
  rewind(): void {
    this.position = 0;
    if (this.playing) {
      this.beginBlock(0);
    }
  }

  get loaded(): boolean {
    return this.blocks.length > 0;
  }

  get finished(): boolean {
    return this.position >= this.blocks.length;
  }

  // ── Playback control ──────────────────────────────────────────────────

  /** Start pulse-level playback from the current position */
  startPlayback(): void {
    this.playing = true;
    this.earBit = 0;
    this.beginBlock(this.position);
    if (this.onPlayStateChange) this.onPlayStateChange();
  }

  /** Stop playback */
  stopPlayback(): void {
    this.playing = false;
    this.phase = TapePhase.IDLE;
    this.earBit = 0;
    this.rawData = null;
    this.directData = null;
    if (this.onPlayStateChange) this.onPlayStateChange();
  }

  /**
   * Skip the current block (called after ROM trap instant-loads it).
   * Advances the player to start playing the next block.
   */
  skipBlock(): void {
    if (!this.playing) {
      this.playing = true;
      this.earBit = 0;
    }
    // position was already advanced by nextDataBlock()
    this.beginBlock(this.position);
  }

  /**
   * Return the number of T-states until the next EAR transition, given how
   * many T-states have already been accumulated within the current pulse,
   * or null if the tape is idle/paused/in a phase without scheduled edges.
   *
   * Used by surgical loader acceleration: when a custom loader is spinning
   * on IN A,($FE) waiting for an edge, we can compute the exact moment
   * the next edge arrives and jump CPU state forward instead of running
   * thousands of polling iterations.
   *
   * Returns 0 if an edge is overdue (advance() should fire it immediately).
   * Pulse/data phases only — DIRECT and PAUSE phases return null because
   * their semantics are different (DIRECT toggles on sample boundaries
   * absolutely, PAUSE has no edges).
   */
  tStatesToNextEdge(): number | null {
    if (!this.playing || this.paused || this.phase === TapePhase.IDLE) return null;
    if (this.phase === TapePhase.PAUSE || this.phase === TapePhase.DIRECT) return null;
    const remaining = this.pulseLen - this.tInPulse;
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Advance playback by the given number of T-states.
   * Toggles earBit at pulse boundaries.
   */
  advance(tStates: number): void {
    if (!this.playing || this.paused || this.phase === TapePhase.IDLE) return;

    if (this.phase === TapePhase.PAUSE) {
      // Per TZX 1.20 §3.5: when a data block ends with a pause, the tape
      // holds the last edge level briefly, then drops to low (level 0)
      // for the remainder. Loaders like Speedlock 7 rely on this drop as
      // the "block done" signal — without it the loader times out into
      // an error path or mis-syncs against the next block. pauseFlipAt
      // is the T-states until the drop; -1 means no drop pending (e.g.
      // for standalone PauseBlock entries from TZX 0x20).
      this.pauseRemaining -= tStates;
      if (this.pauseFlipAt > 0) {
        this.pauseFlipAt -= tStates;
        if (this.pauseFlipAt <= 0) {
          this.earBit = 0;
          this.pauseFlipAt = -1;
        }
      }
      if (this.pauseRemaining <= 0) {
        this.beginBlock(this.playbackIdx + 1);
      }
      return;
    }

    if (this.phase === TapePhase.DIRECT) {
      this.advanceDirect(tStates);
      return;
    }

    this.tInPulse += tStates;
    while (this.tInPulse >= this.pulseLen &&
           (this.phase as number) !== TapePhase.IDLE &&
           (this.phase as number) !== TapePhase.PAUSE &&
           (this.phase as number) !== TapePhase.DIRECT) {
      this.tInPulse -= this.pulseLen;
      this.earBit ^= 1;
      this.advancePulse();
    }
  }

  // ── Internal playback mechanics ───────────────────────────────────────

  /**
   * Categorise the currently-pending pulse (i.e. the one defined by phase
   * + pulseLen + rawData) for the surgical loader accelerator. Pilot is
   * 'long' (≈2168T half-cycle, well above the 855T data-short threshold);
   * sync pulses are 'short'; data bits are short or long depending on the
   * bit being emitted. Tone/pulses/direct/pause/idle are 'unknown'.
   */
  private currentEdgeFlags(): EdgeLengthFlags {
    switch (this.phase) {
      case TapePhase.PILOT: return 'long';
      case TapePhase.SYNC1:
      case TapePhase.SYNC2: return 'short';
      case TapePhase.DATA: {
        const byte = this.rawData![this.byteIdx];
        const bit = (byte >> this.bitIdx) & 1;
        return bit ? 'long' : 'short';
      }
      default: return 'unknown';
    }
  }

  /** Publish the current edge flags to a registered listener (if any). */
  private publishEdgeFlags(): void {
    if (this.onEdgeScheduled) {
      this.onEdgeScheduled(this.currentEdgeFlags(), this.inAcceleration);
    }
  }

  private beginBlock(idx: number): void {
    while (idx < this.blocks.length) {
      this.playbackIdx = idx;
      this.tInPulse = 0;
      const block = this.blocks[idx];

      switch (block.kind) {
        case 'data':
          this.beginDataBlock(block);
          return;

        case 'tone':
          this.phase = TapePhase.TONE;
          this.toneRemaining = block.count;
          this.pulseLen = block.pulseLen;
          this.publishEdgeFlags();
          return;

        case 'pulses':
          if (block.lengths.length === 0) {
            this.position = idx + 1;
            idx++;
            continue;
          }
          this.phase = TapePhase.PULSES;
          this.pulsesLengths = block.lengths;
          this.pulsesIdx = 0;
          this.pulseLen = block.lengths[0];
          this.publishEdgeFlags();
          return;

        case 'pause':
          if (block.duration === 0) {
            this.paused = true;
            this.position = idx + 1;
            this.phase = TapePhase.IDLE;
            this.publishEdgeFlags();
            return;
          }
          this.position = idx + 1;
          this.phase = TapePhase.PAUSE;
          this.earBit = 0;
          this.pauseRemaining = Math.round(block.duration * this.cpuClock / 1000);
          this.publishEdgeFlags();
          return;

        case 'direct':
          if (block.data.length === 0) {
            this.position = idx + 1;
            idx++;
            continue;
          }
          this.beginDirectBlock(block);
          this.publishEdgeFlags();
          return;

        case 'set-level':
          this.earBit = block.level;
          this.position = idx + 1;
          idx++;
          continue;

        case 'stop-if-48k':
          this.position = idx + 1;
          if (this.is48K) {
            this.paused = true;
            this.phase = TapePhase.IDLE;
            return;
          }
          idx++;
          continue;

        case 'group-start':
        case 'group-end':
        case 'text':
        case 'archive-info':
          this.position = idx + 1;
          idx++;
          continue;
      }
    }

    this.phase = TapePhase.IDLE;
    this.playing = false;
    this.rawData = null;
    this.directData = null;
  }

  private beginDataBlock(block: DataBlock): void {
    // Pure data blocks store raw bytes directly (not TAP flag+payload+checksum format)
    this.rawData = block.source === 'pure-data' ? block.data : this.buildRawData(block);

    this.bPilot = block.pilotPulse;
    this.bSync1 = block.syncPulse1;
    this.bSync2 = block.syncPulse2;
    this.bBit0 = block.bit0Pulse;
    this.bBit1 = block.bit1Pulse;
    this.usedBitsLast = Math.max(1, block.usedBits);
    this.pauseRemaining = Math.round(block.pause * this.cpuClock / 1000);

    if (block.pilotCount === 0) {
      // Pure data blocks: no pilot or sync, straight to data
      this.phase = TapePhase.DATA;
      this.byteIdx = 0;
      this.bitIdx = 7;
      this.pulseHalf = 0;
      this.setDataPulseLen();
    } else {
      // Standard / turbo: pilot → sync → data
      this.phase = TapePhase.PILOT;
      this.pilotRemaining = block.pilotCount;
      this.pulseLen = this.bPilot;
    }
    this.publishEdgeFlags();
  }

  private beginDirectBlock(block: DirectBlock): void {
    this.phase = TapePhase.DIRECT;
    this.directData = block.data;
    this.directTStatesPerSample = block.tStatesPerSample;
    this.directByteIdx = 0;
    this.directBitIdx = 7;
    this.directUsedBitsLast = Math.max(1, block.usedBits);
    this.directPauseMs = block.pause;
    this.tInPulse = 0;
    this.earBit = (block.data[0] >> 7) & 1;
  }

  private advanceDirect(tStates: number): void {
    this.tInPulse += tStates;
    while (this.tInPulse >= this.directTStatesPerSample) {
      this.tInPulse -= this.directTStatesPerSample;

      this.directBitIdx--;

      // Check if we've finished the last used bit of the last byte
      const isLastByte = this.directByteIdx === this.directData!.length - 1;
      if (isLastByte && this.directBitIdx < (8 - this.directUsedBitsLast)) {
        // End of direct block — enter pause
        this.position = this.playbackIdx + 1;
        if (this.directPauseMs > 0) {
          this.phase = TapePhase.PAUSE;
          this.earBit = 0;
          this.pauseRemaining = Math.round(this.directPauseMs * this.cpuClock / 1000);
        } else {
          this.beginBlock(this.playbackIdx + 1);
        }
        this.directData = null;
        return;
      }

      if (this.directBitIdx < 0) {
        // Wrap to next byte. The "byteIdx >= length" guard is unreachable:
        // when bitIdx reaches -1 on the last byte, the isLastByte branch
        // above always fires first (since usedBitsLast ∈ [1,8] makes
        // 8 - usedBitsLast ∈ [0,7] and -1 < x always holds).
        this.directByteIdx++;
        this.directBitIdx = 7;
      }

      // Set EAR absolutely (not toggle)
      this.earBit = (this.directData![this.directByteIdx] >> this.directBitIdx) & 1;
    }
  }

  private advancePulse(): void {
    switch (this.phase) {
      case TapePhase.PILOT:
        this.pilotRemaining--;
        if (this.pilotRemaining <= 0) {
          this.phase = TapePhase.SYNC1;
          this.pulseLen = this.bSync1;
        }
        // else pulseLen stays as bPilot
        break;

      case TapePhase.SYNC1:
        this.phase = TapePhase.SYNC2;
        this.pulseLen = this.bSync2;
        break;

      case TapePhase.SYNC2:
        this.phase = TapePhase.DATA;
        this.byteIdx = 0;
        this.bitIdx = 7;
        this.pulseHalf = 0;
        this.setDataPulseLen();
        break;

      case TapePhase.DATA:
        this.pulseHalf++;
        if (this.pulseHalf >= 2) {
          this.pulseHalf = 0;
          this.bitIdx--;

          // Check if we've finished the last used bit of the last byte
          const isLastByte = this.byteIdx === this.rawData!.length - 1;
          if (isLastByte && this.bitIdx < (8 - this.usedBitsLast)) {
            this.enterPause();
            return;
          }

          if (this.bitIdx < 0) {
            // Wrap to next byte. The "byteIdx >= length" guard is unreachable:
            // see advanceDirect for the same dead-code analysis.
            this.byteIdx++;
            this.bitIdx = 7;
          }

          this.setDataPulseLen();
        }
        // else pulseLen stays same (second half-cycle of same bit)
        break;

      case TapePhase.TONE:
        this.toneRemaining--;
        if (this.toneRemaining <= 0) {
          this.position = this.playbackIdx + 1;
          this.beginBlock(this.playbackIdx + 1);
          return; // beginBlock publishes its own flags
        }
        break;

      case TapePhase.PULSES:
        this.pulsesIdx++;
        if (this.pulsesIdx >= this.pulsesLengths.length) {
          this.position = this.playbackIdx + 1;
          this.beginBlock(this.playbackIdx + 1);
          return; // beginBlock publishes its own flags
        } else {
          this.pulseLen = this.pulsesLengths[this.pulsesIdx];
        }
        break;
    }
    this.publishEdgeFlags();
  }

  private setDataPulseLen(): void {
    const byte = this.rawData![this.byteIdx];
    const bit = (byte >> this.bitIdx) & 1;
    this.pulseLen = bit ? this.bBit1 : this.bBit0;
  }

  private enterPause(): void {
    this.phase = TapePhase.PAUSE;
    this.position = this.playbackIdx + 1;
    // pauseRemaining was set by beginDataBlock from block.pause (ms→T).
    // Schedule the mid-pause EAR flip per TZX §3.5: hold for ~1ms then
    // flip to opposite level. The 945T figure matches FUSE — about a
    // quarter of a frame, long enough that real loaders see the last
    // edge before the level changes, short enough that the flip arrives
    // well within any reasonable pause. We only schedule a flip if there
    // actually is a pause (pauseRemaining > 945T) — for zero-pause block
    // transitions the flip would land after the next block has begun.
    this.pauseFlipAt = this.pauseRemaining > 945 ? 945 : -1;
    this.publishEdgeFlags(); // 'unknown' — next edge length not known
  }

  /** Reconstruct raw block bytes: flag + payload + XOR checksum */
  private buildRawData(block: DataBlock): Uint8Array {
    const raw = new Uint8Array(block.data.length + 2);
    raw[0] = block.flag;
    raw.set(block.data, 1);
    let checksum = block.flag;
    for (let i = 0; i < block.data.length; i++) checksum ^= block.data[i];
    raw[raw.length - 1] = checksum;
    return raw;
  }
}
