/**
 * Minimal RIFF/WAVE reader for cassette audio.
 *
 * Apple II tapes are recordings of the machine's FSK output, so the tape
 * decoder needs the raw samples rather than any pulse model. Only the common
 * uncompressed layouts are handled (8-bit unsigned, 16-bit signed, 32-bit
 * float, PCM or IEEE float); multi-channel audio is averaged down to mono.
 */

export interface WavAudio {
  readonly sampleRate: number;
  /** Mono samples in -1..1. */
  readonly samples: Float32Array;
}

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
}

export function isWav(data: Uint8Array): boolean {
  return data.length > 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46  // RIFF
    && data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45; // WAVE
}

export function parseWav(data: Uint8Array): WavAudio {
  if (!isWav(data)) throw new Error('Not a RIFF/WAVE file');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= data.length) {
    const id = fourCC(view, pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, data.length - body);
    }
    pos = body + size + (size & 1);
  }

  if (dataOffset < 0 || channels === 0 || sampleRate === 0) {
    throw new Error('WAVE file has no usable audio data');
  }

  const bytesPerSample = bits >> 3;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataLength / frameBytes);
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const at = dataOffset + i * frameBytes + c * bytesPerSample;
      acc += readSample(view, at, format, bits);
    }
    out[i] = acc / channels;
  }
  return { sampleRate, samples: out };
}

function readSample(view: DataView, at: number, format: number, bits: number): number {
  if (format === 3) return view.getFloat32(at, true);   // IEEE float
  switch (bits) {
    case 8: return (view.getUint8(at) - 128) / 128;
    case 16: return view.getInt16(at, true) / 32768;
    case 24: {
      const b0 = view.getUint8(at);
      const b1 = view.getUint8(at + 1);
      const b2 = view.getUint8(at + 2);
      let v = b0 | (b1 << 8) | (b2 << 16);
      if (v & 0x800000) v |= ~0xFFFFFF;
      return v / 8388608;
    }
    case 32: return view.getInt32(at, true) / 2147483648;
    default: throw new Error(`Unsupported WAVE sample size: ${bits} bits`);
  }
}
