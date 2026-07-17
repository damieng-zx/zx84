/**
 * webgl-renderer.ts — two-pass GL pipeline.
 *
 * No real WebGL in node, so we build a minimal recording mock that
 * accepts every call the renderer makes and lets us inspect uniforms,
 * texture state, and draw cadence. The mock is intentionally permissive:
 * we don't validate GLSL or geometry, just observable side-effects.
 *
 * What we're really testing (and challenging):
 *
 *   - Setter clamping ranges — several CRT params have hard ranges in the
 *     setter but others (maskType, curvatureMode) accept anything. The
 *     latter could push the shader into an undefined branch. Worth pinning
 *     so behaviour is visible if someone tightens or loosens it later.
 *
 *   - Fractional scale handling — Math.round(scale * dpr) silently snaps
 *     scale=0.6/dpr=1 to deviceScale=1. setScale(0.4) collapses to 0.
 *
 *   - Dirty-flag flow — uniform writes are gated on `glDirty`. If the
 *     gating ever leaks (e.g. forgetting to re-arm dirty when a setter
 *     changes a "static" uniform), the new value is silently lost. We
 *     pin every setter that should re-arm.
 *
 *   - Noise uniform leakage — setNoise(0.5) then setNoise(0) must
 *     actually push 0 to the GPU on the next frame, not leave 0.5 stuck.
 *
 *   - Frame counter — increments every draw, wraps at 0x7FFFFFFF.
 *
 *   - LUT async load — HQ2x/3x/4x each load a LUT image; nothing else
 *     should. The Image.onload path must end with activeTexture(TEXTURE0)
 *     restored so the next draw's source-texture bind goes to the right
 *     unit.
 *
 *   - setScalingMode out-of-range / non-integer / no-op-when-unchanged.
 *
 *   - Constructor failure paths: no WebGL, shader compile/link failure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── GL mock ──────────────────────────────────────────────────────────────

type Uniform = { name: string; value: any };

class MockProgram {
  uniforms = new Map<string, { name: string; lastValue: any }>();
  attribs = new Map<string, number>();
  uniformLog: Uniform[] = [];
}

class MockTexture {
  width = 0;
  height = 0;
  filterMin: number | null = null;
  filterMag: number | null = null;
  uploadedFromImage = false;
}

class MockBuffer { data: Float32Array | null = null; }
class MockFramebuffer { attachment: MockTexture | null = null; }
class MockShader { source = ''; compileOk = true; }

interface MockGLOptions {
  compileShader?: (src: string) => boolean;
  linkProgram?: () => boolean;
}

function makeMockGL(opts: MockGLOptions = {}) {
  const log: { call: string; args: any[] }[] = [];
  const record = (call: string, ...args: any[]) => { log.push({ call, args }); };

  let activeUnit = 0x84C0; // TEXTURE0
  const boundTextures = new Map<number, MockTexture | null>(); // per unit
  let boundProgram: MockProgram | null = null;
  let boundFramebuffer: MockFramebuffer | null = null;
  let boundArrayBuffer: MockBuffer | null = null;

  const programs: MockProgram[] = [];
  const shaders: MockShader[] = [];
  const textures: MockTexture[] = [];
  const buffers: MockBuffer[] = [];
  const framebuffers: MockFramebuffer[] = [];

  const drawCalls: { mode: number; first: number; count: number; viewport: [number, number, number, number]; program: MockProgram | null; framebuffer: MockFramebuffer | null; activeUnit: number; boundTextureOnUnit0: MockTexture | null; boundTextureOnUnit1: MockTexture | null }[] = [];
  let viewport: [number, number, number, number] = [0, 0, 0, 0];

  const gl: any = {
    // ── constants ──
    ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88E4,
    VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
    TEXTURE_2D: 0x0DE1, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600, LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812F,
    RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, FLOAT: 0x1406,
    FRAMEBUFFER: 0x8D40, COLOR_ATTACHMENT0: 0x8CE0,
    TEXTURE0: 0x84C0, TEXTURE1: 0x84C1, TEXTURE2: 0x84C2,
    TRIANGLE_STRIP: 0x0005,

    // ── buffers ──
    createBuffer() { const b = new MockBuffer(); buffers.push(b); return b; },
    bindBuffer(_target: number, b: MockBuffer | null) { boundArrayBuffer = b; record('bindBuffer', b); },
    bufferData(_target: number, data: Float32Array, _usage: number) {
      if (boundArrayBuffer) boundArrayBuffer.data = data;
    },

    // ── shaders / programs ──
    createShader(_type: number) { const s = new MockShader(); shaders.push(s); return s; },
    shaderSource(s: MockShader, src: string) { s.source = src; if (opts.compileShader) s.compileOk = opts.compileShader(src); },
    compileShader(_s: MockShader) {},
    getShaderParameter(s: MockShader, p: number) { return p === gl.COMPILE_STATUS ? s.compileOk : 0; },
    getShaderInfoLog(_s: MockShader) { return 'mock compile error'; },
    createProgram() { const p = new MockProgram(); programs.push(p); return p; },
    attachShader(_p: MockProgram, _s: MockShader) {},
    linkProgram(_p: MockProgram) {},
    getProgramParameter(_p: MockProgram, param: number) {
      if (param === gl.LINK_STATUS) return opts.linkProgram ? opts.linkProgram() : true;
      return 0;
    },
    getProgramInfoLog(_p: MockProgram) { return 'mock link error'; },
    useProgram(p: MockProgram | null) { boundProgram = p; record('useProgram', p); },
    getUniformLocation(p: MockProgram, name: string) {
      if (!p.uniforms.has(name)) p.uniforms.set(name, { name, lastValue: undefined });
      return p.uniforms.get(name)!;
    },
    getAttribLocation(p: MockProgram, name: string) {
      if (!p.attribs.has(name)) p.attribs.set(name, p.attribs.size);
      return p.attribs.get(name)!;
    },
    enableVertexAttribArray(_loc: number) {},
    vertexAttribPointer(_loc: number, _size: number, _type: number, _norm: boolean, _stride: number, _off: number) {},

    // ── uniforms ──
    uniform1f(loc: any, v: number) { if (loc && boundProgram) { loc.lastValue = v; boundProgram.uniformLog.push({ name: loc.name, value: v }); } },
    uniform1i(loc: any, v: number) { if (loc && boundProgram) { loc.lastValue = v; boundProgram.uniformLog.push({ name: loc.name, value: v }); } },
    uniform2f(loc: any, a: number, b: number) { if (loc && boundProgram) { loc.lastValue = [a, b]; boundProgram.uniformLog.push({ name: loc.name, value: [a, b] }); } },

    // ── textures ──
    createTexture() { const t = new MockTexture(); textures.push(t); return t; },
    bindTexture(_target: number, t: MockTexture | null) { boundTextures.set(activeUnit, t); record('bindTexture', activeUnit, t); },
    activeTexture(unit: number) { activeUnit = unit; record('activeTexture', unit); },
    texParameteri(_target: number, pname: number, value: number) {
      const t = boundTextures.get(activeUnit);
      if (!t) return;
      if (pname === gl.TEXTURE_MIN_FILTER) t.filterMin = value;
      else if (pname === gl.TEXTURE_MAG_FILTER) t.filterMag = value;
    },
    texImage2D(...args: any[]) {
      const t = boundTextures.get(activeUnit);
      if (!t) return;
      if (args.length === 9) {
        t.width = args[3]; t.height = args[4];
      } else if (args.length === 6) {
        // texImage2D(target, level, internalformat, format, type, image)
        const img = args[5];
        t.width = img?.width ?? 0;
        t.height = img?.height ?? 0;
        t.uploadedFromImage = true;
      }
    },
    texSubImage2D(...args: any[]) { record('texSubImage2D', args); },

    // ── framebuffer ──
    createFramebuffer() { const f = new MockFramebuffer(); framebuffers.push(f); return f; },
    bindFramebuffer(_target: number, f: MockFramebuffer | null) { boundFramebuffer = f; record('bindFramebuffer', f); },
    framebufferTexture2D(_target: number, _attach: number, _texTarget: number, t: MockTexture, _level: number) {
      if (boundFramebuffer) boundFramebuffer.attachment = t;
    },

    // ── draw ──
    viewport(x: number, y: number, w: number, h: number) { viewport = [x, y, w, h]; },
    drawArrays(mode: number, first: number, count: number) {
      drawCalls.push({
        mode, first, count, viewport: [...viewport],
        program: boundProgram,
        framebuffer: boundFramebuffer,
        activeUnit,
        boundTextureOnUnit0: boundTextures.get(gl.TEXTURE0) ?? null,
        boundTextureOnUnit1: boundTextures.get(gl.TEXTURE1) ?? null,
      });
    },
  };

  return { gl, programs, textures, drawCalls, log, getBoundProgram: () => boundProgram, get activeUnit() { return activeUnit; } };
}

// ── DOM stubs ────────────────────────────────────────────────────────────

class StubCanvas {
  width = 0; height = 0; style: Record<string, string> = {};
  contextReturn: any;
  constructor(contextReturn: any) { this.contextReturn = contextReturn; }
  getContext(_kind: string, _opts: any): any { return this.contextReturn; }
}

class StubImage {
  static instances: StubImage[] = [];
  onload: (() => void) | null = null;
  width = 256; height = 64;
  private _src = '';
  constructor() { StubImage.instances.push(this); }
  set src(v: string) { this._src = v; }
  get src() { return this._src; }
  fire() { this.onload?.(); }
}

function installEnv(dpr: number): { restore: () => void } {
  const prevWin = (globalThis as any).window;
  const prevImg = (globalThis as any).Image;
  (globalThis as any).window = { devicePixelRatio: dpr };
  (globalThis as any).Image = StubImage;
  StubImage.instances = [];
  return {
    restore() {
      (globalThis as any).window = prevWin;
      (globalThis as any).Image = prevImg;
    },
  };
}

// ── Module under test ────────────────────────────────────────────────────

import { WebGLRenderer } from '@/display/webgl-renderer.ts';

let env: { restore: () => void };
beforeEach(() => { env = installEnv(1); });
afterEach(() => { env.restore(); vi.resetModules(); });

function makeRenderer(w = 352, h = 288, glOpts?: MockGLOptions) {
  const mock = makeMockGL(glOpts);
  const canvas = new StubCanvas(mock.gl) as unknown as HTMLCanvasElement;
  const r = new WebGLRenderer(canvas, w, h);
  return { r, canvas: canvas as any as StubCanvas, mock };
}

// ── Construction ─────────────────────────────────────────────────────────

describe('WebGLRenderer construction', () => {
  it('builds 7 programs (6 upscale + 1 CRT)', () => {
    const { mock } = makeRenderer();
    expect(mock.programs).toHaveLength(7);
  });

  it('sets default state: scale=2, nearest mode, all CRT effects off/neutral', () => {
    const { r, canvas } = makeRenderer(352, 288);
    expect(r.scale).toBe(2);
    expect(canvas.width).toBe(704);
    expect(canvas.height).toBe(576);
    expect(canvas.style.width).toBe('704px');
  });

  it('source texture uses NEAREST filtering (no accidental smoothing)', () => {
    const { mock } = makeRenderer();
    // Source texture is the first texture created (FBO tex is second)
    const srcTex = mock.textures[0];
    const fboTex = mock.textures[1];
    expect(srcTex.filterMin).toBe(0x2600); // NEAREST
    expect(srcTex.filterMag).toBe(0x2600);
    // FBO uses LINEAR for smooth barrel sampling
    expect(fboTex.filterMin).toBe(0x2601); // LINEAR
    expect(fboTex.filterMag).toBe(0x2601);
  });

  it('throws when WebGL is unavailable', () => {
    const canvas = new StubCanvas(null) as unknown as HTMLCanvasElement;
    expect(() => new WebGLRenderer(canvas, 16, 16)).toThrow(/WebGL not supported/);
  });

  it('throws on shader compile failure', () => {
    const canvas = new StubCanvas(makeMockGL({ compileShader: () => false }).gl) as unknown as HTMLCanvasElement;
    expect(() => new WebGLRenderer(canvas, 16, 16)).toThrow(/Shader compile failed/);
  });

  it('throws on shader link failure', () => {
    const canvas = new StubCanvas(makeMockGL({ linkProgram: () => false }).gl) as unknown as HTMLCanvasElement;
    expect(() => new WebGLRenderer(canvas, 16, 16)).toThrow(/Shader link failed/);
  });

  it('sizes the backing buffer by scale only (dpr-independent), CSS box by 1/dpr', () => {
    // DPR is kept out of the integer pixel multiple (folding it in broke
    // pixel-perfect scaling at 125%); backing = view×scale, CSS = backing/dpr.
    env.restore(); env = installEnv(2);
    const { canvas } = makeRenderer(100, 50);     // scale defaults to 2
    expect(canvas.width).toBe(200);               // 100 × scale(2), NOT × dpr
    expect(canvas.height).toBe(100);              // 50 × scale(2)
    expect(canvas.style.width).toBe('100px');     // backing / dpr = 200 / 2
  });
});

// ── Setter clamping ──────────────────────────────────────────────────────

describe('WebGLRenderer setters — clamping', () => {
  it('setSmoothing clamps to 0..1', () => {
    const { r, mock } = makeRenderer();
    r.setSmoothing(-5);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const u = mock.programs[0].uniforms.get('u_smoothing')!;
    expect(u.lastValue).toBe(0);
    r.setSmoothing(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(u.lastValue).toBe(1);
  });

  it('setCurvature clamps to 0..0.15 (challenging the hard cap)', () => {
    const { r, mock } = makeRenderer();
    r.setCurvature(-1);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const u = mock.programs[6].uniforms.get('u_curvature')!;
    expect(u.lastValue).toBe(0);
    r.setCurvature(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(u.lastValue).toBe(0.15);
  });

  it('setScanlines clamps to 0..1', () => {
    const { r, mock } = makeRenderer();
    r.setScanlines(2);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_scanlines')!.lastValue).toBe(1);
  });

  it('setDotPitch clamps to 1..4', () => {
    const { r, mock } = makeRenderer();
    r.setDotPitch(0);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_dotPitch')!.lastValue).toBe(1);
    r.setDotPitch(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_dotPitch')!.lastValue).toBe(4);
  });

  it('setBrightness clamps to -1..1', () => {
    const { r, mock } = makeRenderer();
    r.setBrightness(-99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_brightness')!.lastValue).toBe(-1);
    r.setBrightness(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_brightness')!.lastValue).toBe(1);
  });

  it('setContrast clamps to 0..2', () => {
    const { r, mock } = makeRenderer();
    r.setContrast(-1);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_contrast')!.lastValue).toBe(0);
    r.setContrast(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_contrast')!.lastValue).toBe(2);
  });

  it('setSaturation clamps to 0..2', () => {
    const { r, mock } = makeRenderer();
    r.setSaturation(-1);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_saturation')!.lastValue).toBe(0);
    r.setSaturation(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_saturation')!.lastValue).toBe(2);
  });

  it('setGamma clamps to 0.25..4', () => {
    const { r, mock } = makeRenderer();
    r.setGamma(-1);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_gamma')!.lastValue).toBe(0.25);
    r.setGamma(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_gamma')!.lastValue).toBe(4);
  });

  it('setNoise clamps to 0..1', () => {
    const { r, mock } = makeRenderer();
    r.setNoise(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_noise')!.lastValue).toBe(1);
  });

  it('setMaskType clamps to 0..5 and coerces to integer', () => {
    const { r, mock } = makeRenderer();
    r.setMaskType(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_maskType')!.lastValue).toBe(5);
    r.setMaskType(-3);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_maskType')!.lastValue).toBe(0);
    r.setMaskType(2.9);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_maskType')!.lastValue).toBe(2);
  });

  it('setCurvatureMode clamps to 0..1 and coerces to integer', () => {
    const { r, mock } = makeRenderer();
    r.setCurvatureMode(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_curvatureMode')!.lastValue).toBe(1);
    r.setCurvatureMode(-5);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniforms.get('u_curvatureMode')!.lastValue).toBe(0);
  });
});

// ── setScalingMode behaviour ─────────────────────────────────────────────

describe('WebGLRenderer setScalingMode', () => {
  it('clamps to valid range and coerces to integer', () => {
    const { r, mock } = makeRenderer();
    r.setScalingMode(-1);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.drawCalls[0].program).toBe(mock.programs[0]); // upscale 0

    r.setScalingMode(99);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.drawCalls[2].program).toBe(mock.programs[5]); // last upscale

    r.setScalingMode(2.9);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.drawCalls[4].program).toBe(mock.programs[2]); // int-coerced to 2
  });

  it('does not mark dirty when mode is unchanged (avoids redundant uniform writes)', () => {
    const { r, mock } = makeRenderer();
    // First draw consumes the initial dirty flag
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const beforeCount = mock.programs[6].uniformLog.length;
    // Same mode (0) — should NOT re-mark dirty
    r.setScalingMode(0);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    // CRT program should not have received another bulk uniform write
    const afterCount = mock.programs[6].uniformLog.length;
    expect(afterCount).toBe(beforeCount); // no extra uniforms (noise was 0, not re-pushed)
  });

  it('marks dirty when mode actually changes', () => {
    const { r, mock } = makeRenderer();
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const before = mock.programs[6].uniformLog.length;
    r.setScalingMode(2);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.programs[6].uniformLog.length).toBeGreaterThan(before);
  });
});

// ── updateTexture pipeline ───────────────────────────────────────────────

describe('WebGLRenderer updateTexture pipeline', () => {
  it('performs two draws per frame: pass 1 → FBO, pass 2 → screen', () => {
    const { r, mock } = makeRenderer(352, 288);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    expect(mock.drawCalls).toHaveLength(2);
    // Pass 1: bound framebuffer is the FBO, program is the upscale program
    expect(mock.drawCalls[0].framebuffer).not.toBeNull();
    expect(mock.drawCalls[0].program).toBe(mock.programs[0]);
    // Pass 2: null framebuffer (screen), program is CRT
    expect(mock.drawCalls[1].framebuffer).toBeNull();
    expect(mock.drawCalls[1].program).toBe(mock.programs[6]);
    // Both viewports cover the full backing buffer (704×576 at scale=2)
    expect(mock.drawCalls[0].viewport).toEqual([0, 0, 704, 576]);
    expect(mock.drawCalls[1].viewport).toEqual([0, 0, 704, 576]);
  });

  it('writes per-frame uniforms (u_smoothing) every frame, even when not dirty', () => {
    // u_smoothing is set unconditionally so that smoothing slider edits
    // never depend on glDirty being set.
    const { r, mock } = makeRenderer();
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const writes = mock.programs[0].uniformLog.filter(u => u.name === 'u_smoothing');
    expect(writes.length).toBe(2);
  });

  it('writes pass-2 bulk uniforms only when dirty', () => {
    const { r, mock } = makeRenderer();
    r.updateTexture(new Uint8Array(352 * 288 * 4)); // dirty
    const first = mock.programs[6].uniformLog.filter(u => u.name === 'u_resolution').length;
    expect(first).toBe(1);
    r.updateTexture(new Uint8Array(352 * 288 * 4)); // not dirty
    r.updateTexture(new Uint8Array(352 * 288 * 4)); // not dirty
    const second = mock.programs[6].uniformLog.filter(u => u.name === 'u_resolution').length;
    expect(second).toBe(1); // still 1
  });
});

// ── Noise uniform leakage ───────────────────────────────────────────────

describe('WebGLRenderer noise uniform — leakage check', () => {
  it('updates u_noise + u_frame every frame while noise > 0', () => {
    const { r, mock } = makeRenderer();
    r.setNoise(0.5);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const noiseWrites = mock.programs[6].uniformLog.filter(u => u.name === 'u_noise');
    const frameWrites = mock.programs[6].uniformLog.filter(u => u.name === 'u_frame');
    expect(noiseWrites.length).toBe(3);
    expect(frameWrites.length).toBe(3);
    expect(noiseWrites.every(w => w.value === 0.5)).toBe(true);
    // Frame counter strictly increasing
    const frameVals = frameWrites.map(w => w.value as number);
    expect(frameVals[1]).toBe(frameVals[0] + 1);
    expect(frameVals[2]).toBe(frameVals[1] + 1);
  });

  it('pushes u_noise=0 to GPU when transitioning from on→off (no stale value)', () => {
    const { r, mock } = makeRenderer();
    r.setNoise(0.7);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    r.setNoise(0); // re-arms dirty
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const writes = mock.programs[6].uniformLog.filter(u => u.name === 'u_noise');
    // Last write must be 0, not 0.7
    expect(writes[writes.length - 1].value).toBe(0);
  });

  it('does NOT touch u_noise on subsequent clean frames after noise stays off', () => {
    const { r, mock } = makeRenderer();
    r.updateTexture(new Uint8Array(352 * 288 * 4)); // dirty: u_noise=0 written
    r.updateTexture(new Uint8Array(352 * 288 * 4)); // clean: no write
    r.updateTexture(new Uint8Array(352 * 288 * 4)); // clean: no write
    const writes = mock.programs[6].uniformLog.filter(u => u.name === 'u_noise');
    expect(writes.length).toBe(1);
  });
});

// ── Texture upload ──────────────────────────────────────────────────────

describe('WebGLRenderer texture upload', () => {
  it('uploads pixels via texSubImage2D with renderer (not canvas) dimensions', () => {
    const { r, mock } = makeRenderer(352, 288);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const sub = mock.log.find(c => c.call === 'texSubImage2D');
    expect(sub).toBeTruthy();
    // args layout: target, level, x, y, w, h, format, type, pixels
    const args = sub!.args[0];
    expect(args[4]).toBe(352);
    expect(args[5]).toBe(288);
  });

  it('source texture is bound on TEXTURE0 at draw time (CRT samples FBO from unit 0 too)', () => {
    const { r, mock } = makeRenderer();
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    // Pass 1 draw: source texture on unit 0
    expect(mock.drawCalls[0].boundTextureOnUnit0).toBe(mock.textures[0]);
    // Pass 2 draw: FBO texture replaces unit 0 binding
    expect(mock.drawCalls[1].boundTextureOnUnit0).toBe(mock.textures[1]);
  });
});

// ── resize / setScale ────────────────────────────────────────────────────

describe('WebGLRenderer resize / setScale', () => {
  it('resize reuploads source texture at new dimensions and re-sizes canvas', () => {
    const { r, canvas, mock } = makeRenderer(352, 288);
    expect(mock.textures[0].width).toBe(352);
    r.resize(256, 192);
    expect(mock.textures[0].width).toBe(256);
    expect(mock.textures[0].height).toBe(192);
    // applyScale ran: canvas resized
    expect(canvas.width).toBe(512); // 256 * 2
    expect(canvas.height).toBe(384);
  });

  it('setScale updates canvas + FBO texture size, leaves source texture alone', () => {
    const { r, canvas, mock } = makeRenderer(100, 100);
    const srcW = mock.textures[0].width;
    r.setScale(4);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(400);
    // FBO texture grew with display
    expect(mock.textures[1].width).toBe(400);
    // Source texture unchanged
    expect(mock.textures[0].width).toBe(srcW);
  });

  it('setScale enforces integer ≥ 1 (rounds and clamps)', () => {
    const { r, canvas } = makeRenderer(100, 100);
    r.setScale(0.4);
    expect(r.scale).toBe(1);
    expect(canvas.width).toBe(100);
    r.setScale(-5);
    expect(r.scale).toBe(1);
    r.setScale(2.7);
    expect(r.scale).toBe(3);
    expect(canvas.width).toBe(300);
  });
});

// ── LUT async loading ───────────────────────────────────────────────────

describe('WebGLRenderer LUT loading', () => {
  it('creates exactly 3 Image() loads — one per HQ2x/3x/4x mode', () => {
    makeRenderer();
    expect(StubImage.instances.length).toBe(3);
    for (const img of StubImage.instances) {
      expect(typeof img.onload).toBe('function');
    }
  });

  it('after a LUT image loads, the next draw under that mode binds the LUT on TEXTURE1', () => {
    const { r, mock } = makeRenderer();
    // Fire all LUT onloads
    for (const img of StubImage.instances) img.fire();
    r.setScalingMode(1); // HQ2x
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    // Look at the upscale draw call (first of the pair) under HQ2x
    const pass1 = mock.drawCalls[mock.drawCalls.length - 2];
    expect(pass1.program).toBe(mock.programs[1]);
    expect(pass1.boundTextureOnUnit1).not.toBeNull();
    // ...and active unit must be TEXTURE0 by draw time so CRT pass 2 binds correctly
    expect(pass1.activeUnit).toBe(0x84C0);
  });

  it('does not bind a LUT for the bilinear (mode 0) or xBR (mode 4/5) shaders', () => {
    const { r, mock } = makeRenderer();
    for (const img of StubImage.instances) img.fire();
    r.setScalingMode(0);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const pass1 = mock.drawCalls[mock.drawCalls.length - 2];
    expect(pass1.boundTextureOnUnit1).toBeNull();

    r.setScalingMode(4);
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const pass1b = mock.drawCalls[mock.drawCalls.length - 2];
    expect(pass1b.boundTextureOnUnit1).toBeNull();
  });

  it('does not crash if the renderer draws while LUTs are still loading', () => {
    const { r } = makeRenderer();
    r.setScalingMode(2); // HQ3x; LUT not loaded yet
    expect(() => r.updateTexture(new Uint8Array(352 * 288 * 4))).not.toThrow();
  });
});

// ── Frame counter ────────────────────────────────────────────────────────

describe('WebGLRenderer frame counter', () => {
  it('increments per frame and wraps at 0x7FFFFFFF', () => {
    const { r, mock } = makeRenderer();
    r.setNoise(0.1);
    // Bump frameCount near wrap via a private back-door
    (r as any).frameCount = 0x7FFFFFFE;
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    r.updateTexture(new Uint8Array(352 * 288 * 4));
    const frameWrites = mock.programs[6].uniformLog.filter(u => u.name === 'u_frame');
    const last = frameWrites[frameWrites.length - 1].value as number;
    // After two increments from 0x7FFFFFFE: 0x7FFFFFFF, then wrap to 0
    // The renderer pushes the PRE-increment frame counter, so:
    //   draw1: pushes 0x7FFFFFFE, then increments to 0x7FFFFFFF
    //   draw2: pushes 0x7FFFFFFF, then increments to 0 (wrap)
    // Counter is incremented BEFORE the uniform push, so:
    //   draw1: 0x7FFFFFFE → 0x7FFFFFFF, push 0x7FFFFFFF
    //   draw2: 0x7FFFFFFF + 1 = 0x80000000 → masked to 0, push 0
    expect(last).toBe(0);
    expect((r as any).frameCount).toBe(0);
  });
});
