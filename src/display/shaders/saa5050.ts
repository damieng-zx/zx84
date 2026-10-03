// ── SAA5050 character-rounding upscaler ──
//
// The Mullard SAA5050 teletext chip draws each glyph row as two half-lines and
// rounds diagonals: for the half-line nearer a neighbouring row, a pixel is
// filled when the pixel beside it is lit, the neighbouring row is lit directly
// beyond the empty pixel, and its own neighbour is not (see
// `Saa5050.characterRounding`). Here that rule runs on any source image:
//
//   for the half-line facing row b (above for the top half, below for the
//   bottom half) of source pixel A with horizontal neighbour N (left or right)
//   and the matching pixels B (in b, under A) and BN (in b, under N):
//   A becomes N when N == B, BN == A, N != A and N is the "ink" (brighter).
//
// Ink is taken to be the brighter of the two colours. The chip knows which dots
// are lit; an arbitrary image does not. Colour equality is exact (the source is
// sampled NEAREST), so it works for any machine's palette.
//
// Output pixels covering both halves of a source line (1x) blend them by
// coverage, which gives the anti-aliased look at 1:1; from 2x each half-line is
// its own output row.

import { UPSCALE_HEAD } from '@/display/shaders/upscale-head.ts';

export const FRAG_SAA5050 = UPSCALE_HEAD + `
  uniform float u_rowsPerPx;     // source rows covered by one output pixel

  vec4 T(vec2 p) { return texture2D(u_tex, (floor(p) + 0.5) / u_texSize); }
  bool same(vec4 a, vec4 b) { return all(equal(a, b)); }
  float lum(vec4 c) { return dot(c.rgb, vec3(0.299, 0.587, 0.114)); }

  // The pixel A as the half-line facing the row dy (-1 above, +1 below) draws it.
  vec4 half_line(vec2 ip, float dy) {
    vec4 a = T(ip);
    vec4 r = T(ip + vec2(1.0, 0.0));
    vec4 l = T(ip + vec2(-1.0, 0.0));
    vec4 b = T(ip + vec2(0.0, dy));
    vec4 br = T(ip + vec2(1.0, dy));
    vec4 bl = T(ip + vec2(-1.0, dy));
    if (!same(r, a) && same(r, b) && same(br, a) && lum(r) > lum(a)) return r;
    if (!same(l, a) && same(l, b) && same(bl, a) && lum(l) > lum(a)) return l;
    return a;
  }

  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 ip = floor(pos);
    float fy = pos.y - ip.y;                 // 0 at the top of the source line
    float h2 = 0.5 * u_rowsPerPx;
    // How much of this output pixel lies in the top half-line.
    float top = clamp((0.5 - (fy - h2)) / (2.0 * h2), 0.0, 1.0);
    vec4 c = half_line(ip, -1.0);
    if (top < 1.0) c = mix(half_line(ip, 1.0), c, top);
    gl_FragColor = c;
  }
`;
