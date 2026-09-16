// GLSL ES 3.00 sources.

import { CELL, LAMP_HEIGHT, STREET, lampHeadsLocal } from "./city/generate";

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp sampler2DShadow;
`;

const ATMOSPHERE = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uSunDir;
uniform vec3 uLightDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGroundCol;
uniform float uSunGlow;
uniform float uAmbient;
uniform float uCloudCover;
uniform float uCloudDark;
uniform vec2 uCloudOffset;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogTint;
uniform float uMist;
uniform float uNight;
uniform float uWet;
uniform float uTime;
uniform vec3 uCamPos;

const float CLOUD_H = 1600.0;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * texture(uNoise, p).r;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(0.37, 0.11);
    a *= 0.5;
  }
  return s / 0.875;
}

float cloudBase(vec2 wp) {
  vec2 p = wp * 0.0001 + uCloudOffset;
  float warp = texture(uNoise, p * 0.23).g - 0.5;
  float n = fbm3(p + vec2(warp, -warp) * 0.35);
  float t = mix(0.70, 0.22, uCloudCover);
  return (n - t) / 0.14;
}

float cloudDensity(vec2 wp) {
  vec2 p = wp * 0.0001 + uCloudOffset;
  float det = texture(uNoise, p * 7.3 + uCloudOffset * 2.0).r * 0.6
            + texture(uNoise, p * 17.9 - uCloudOffset * 3.0).r * 0.4;
  float erode = mix(0.9, 0.3, uCloudCover * uCloudCover);
  float d = clamp(cloudBase(wp) + erode * 0.5 - det * erode, 0.0, 1.0);
  return max(d, smoothstep(0.85, 1.0, uCloudCover) * (0.75 + 0.2 * det));
}

vec3 skyBase(vec3 rd) {
  float y = rd.y;
  vec3 col = y >= 0.0
    ? mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.5))
    : mix(uHorizon, uGroundCol, clamp(-y * 5.0, 0.0, 1.0));
  float sd = max(dot(rd, uSunDir), 0.0);
  col += uSunColor * uSunGlow * (0.04 * pow(sd, 3.0) + 0.22 * pow(sd, 40.0));
  col += uSunColor * uSunGlow * 0.10 * sd * sd * exp(-abs(y) * 5.0);
  return col;
}

vec3 fogColor(vec3 rd) {
  vec3 d = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.3 + 0.02, rd.z));
  return mix(skyBase(d), uFogColor, uFogTint);
}

vec4 clouds(vec3 rd) {
  if (rd.y <= 0.005) return vec4(0.0);
  float t = (CLOUD_H - uCamPos.y) / rd.y;
  vec2 wp = uCamPos.xz + rd.xz * t;
  float d = cloudDensity(wp);
  if (d <= 0.001) return vec4(0.0);
  vec2 sdir = normalize(uSunDir.xz + vec2(1e-4));
  float d2 = cloudDensity(wp + sdir * 350.0);
  float d3 = cloudDensity(wp + sdir * 900.0);
  float lit = exp(-2.2 * max(d2 * 0.7 + d3 * 0.5 - d * 0.35, 0.0));
  vec3 amb = mix(uHorizon, uZenith, 0.35) * 0.85 + vec3(0.06) * (1.0 - uNight);
  vec3 col = amb * (1.0 - 0.7 * uCloudDark * d);
  col += uSunColor * lit * (0.75 - 0.6 * uCloudDark);
  float sd = max(dot(rd, uSunDir), 0.0);
  col += uSunColor * pow(sd, 10.0) * (1.0 - d) * 1.2 * (1.0 - uCloudDark * 0.5);
  float fade = smoothstep(0.005, 0.18, rd.y);
  col = mix(skyBase(rd), col, 0.35 + 0.65 * fade);
  return vec4(col, d * mix(0.35, 1.0, fade) * mix(0.9, 1.0, uCloudCover));
}

vec3 skyColor(vec3 rd) {
  vec3 col = skyBase(rd);
  float sd = dot(rd, uSunDir);
  if (rd.y > 0.0) {
    vec2 sp = rd.xz / (rd.y + 0.15) * 3.0;
    float star = step(0.9985, texture(uNoise, sp).a) * texture(uNoise, sp * 0.5 + uTime * 0.02).b;
    col += vec3(star) * uNight * (1.0 - uCloudCover) * 1.5 * smoothstep(0.0, 0.2, rd.y);
  }
  col += uSunColor * smoothstep(0.99955, 0.99975, sd) * 25.0 * step(0.0, rd.y);
  vec4 c = clouds(rd);
  col = mix(col, c.rgb, c.a);
  float skyFog = clamp(uFogDensity * 70.0, 0.0, 1.0) * (1.0 - 0.6 * clamp(rd.y * 2.0, 0.0, 1.0));
  return mix(col, fogColor(rd), skyFog);
}

float cloudShadow(vec3 p) {
  vec3 L = uLightDir;
  vec2 q = p.xz + L.xz / max(L.y, 0.08) * (CLOUD_H - p.y);
  return 1.0 - clamp(cloudBase(q), 0.0, 1.0) * mix(0.5, 0.8, uCloudDark);
}

// Exponential fog plus a dense, low-lying mist that pools in the street canyons.
vec3 applyFog(vec3 color, vec3 p, float dist, vec3 viewDir) {
  float hAvg = max(0.5 * (uCamPos.y + p.y), 0.0);
  float fog = 1.0 - exp(-dist * uFogDensity * exp(-hAvg / 260.0));
  const float H = 9.0;
  float y0 = max(uCamPos.y, 0.0), y1 = max(p.y, 0.0);
  float dy = y1 - y0;
  float integral = abs(dy) < 0.05 ? exp(-y0 / H) : H * (exp(-y0 / H) - exp(-y1 / H)) / dy;
  float mist = 1.0 - exp(-dist * uMist * integral);
  vec3 fc = fogColor(viewDir);
  color = mix(color, fc, fog);
  return mix(color, fc * mix(0.85, 1.0, uFogTint), mist * 0.9);
}
`;

export const SKY_VS = HEADER + /* glsl */ `
layout(location = 0) in vec2 aPos;
uniform float uSkyZ; // NDC depth of the far plane
out vec2 vNdc;
void main() {
  vNdc = aPos;
  gl_Position = vec4(aPos, uSkyZ, 1.0);
}
`;

export const SKY_FS = HEADER + ATMOSPHERE + /* glsl */ `
in vec2 vNdc;
uniform vec3 uCamFwd;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec2 uTanHalf;
out vec4 fragColor;
void main() {
  vec3 rd = normalize(uCamFwd + vNdc.x * uTanHalf.x * uCamRight + vNdc.y * uTanHalf.y * uCamUp);
  fragColor = vec4(skyColor(rd), 1.0);
}
`;

export const CITY_VS = HEADER + /* glsl */ `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec2 aSize;
layout(location = 4) in vec3 aTint;
layout(location = 5) in vec3 aInfo;
uniform mat4 uViewProj;
invariant gl_Position;
out vec3 vPos;
out vec3 vNrm;
out vec2 vUV;
out vec3 vTint;
flat out vec2 vSize;
flat out vec3 vInfo;
void main() {
  vPos = aPos;
  vNrm = aNrm;
  vUV = aUV;
  vSize = aSize;
  vTint = aTint;
  vInfo = aInfo;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const VEHICLE_VS = HEADER + /* glsl */ `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec2 aSize;
layout(location = 4) in vec3 aTint;
layout(location = 5) in vec3 aInfo;
layout(location = 6) in vec3 iPos;
layout(location = 7) in vec3 iRot; // yaw, pitch (nose down), roll
layout(location = 8) in vec4 iColor;
uniform mat4 uViewProj;
invariant gl_Position;
out vec3 vPos;
out vec3 vNrm;
out vec2 vUV;
out vec3 vTint;
flat out vec2 vSize;
flat out vec3 vInfo;

mat3 rotation(vec3 r) {
  float cy = cos(r.x), sy = sin(r.x), cp = cos(r.y), sp = sin(r.y), cr = cos(r.z), sr = sin(r.z);
  mat3 ry = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cp, sp, 0.0, -sp, cp);
  mat3 rz = mat3(cr, sr, 0.0, -sr, cr, 0.0, 0.0, 0.0, 1.0);
  return ry * rx * rz;
}

void main() {
  mat3 R = rotation(iRot);
  vPos = iPos + R * aPos;
  vNrm = R * aNrm;
  vUV = aUV;
  vSize = aSize;
  // style 1 marks painted parts, which take the instance colour
  vTint = aInfo.y > 0.5 ? iColor.rgb : aTint;
  vInfo = vec3(aInfo.x, 0.0, iColor.a);
  gl_Position = uViewProj * vec4(vPos, 1.0);
}
`;

export const SHADOW_VS = HEADER + /* glsl */ `
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
invariant gl_Position;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }
`;

export const SHADOW_FS = HEADER + /* glsl */ `
void main() {}
`;

const lamps = lampHeadsLocal().map(([x, z]) => `vec2(${x.toFixed(3)}, ${z.toFixed(3)})`).join(", ");

export const CITY_FS = HEADER + /* glsl */ `
const float CELL = ${CELL.toFixed(1)};
const float STREET = ${STREET.toFixed(1)};
const float LAMP_H = ${LAMP_HEIGHT.toFixed(2)};
const vec2 LAMPS[8] = vec2[8](${lamps});
` + ATMOSPHERE + /* glsl */ `
in vec3 vPos;
in vec3 vNrm;
in vec2 vUV;
in vec3 vTint;
flat in vec2 vSize;
flat in vec3 vInfo;

uniform sampler2DArray uAlbedo;
uniform sampler2DArray uNormal;
uniform sampler2DShadow uShadow;
uniform mat4 uLightVP;
uniform float uShadowTexel;
uniform sampler2D uCloudTex;
uniform vec2 uCloudCenter;
uniform float uCloudExtent;
out vec4 fragColor;

const float CLOUD_REF_Y = 25.0;

float cloudShadowTex(vec3 p) {
  vec2 k = uLightDir.xz / max(uLightDir.y, 0.08);
  vec2 q = p.xz - k * (p.y - CLOUD_REF_Y);
  return texture(uCloudTex, (q - uCloudCenter) / (2.0 * uCloudExtent) + 0.5).r;
}

const vec3 LAMP_COL = vec3(1.0, 0.72, 0.42);
const vec3 GLOW_COL = vec3(0.72, 0.84, 1.0);
const float FLOOR_H = 3.4;

float shadowAt(vec3 p, vec3 n) {
  vec4 lp = uLightVP * vec4(p + n * 0.12, 1.0);
  vec3 s = lp.xyz / lp.w * 0.5 + 0.5;
  if (s.x <= 0.0 || s.x >= 1.0 || s.y <= 0.0 || s.y >= 1.0 || s.z >= 1.0) return 1.0;
  float sum = 0.0;
  const vec2 taps[4] = vec2[4](vec2(-0.4, -1.2), vec2(1.2, -0.4), vec2(0.4, 1.2), vec2(-1.2, 0.4));
  for (int i = 0; i < 4; i++)
    sum += texture(uShadow, vec3(s.xy + taps[i] * uShadowTexel, s.z - 0.00015));
  float edge = max(abs(s.x - 0.5), abs(s.y - 0.5));
  return mix(sum / 4.0, 1.0, smoothstep(0.42, 0.5, edge));
}

// Anti-aliased coverage of the rectangle [lo, hi] at f, given a pixel footprint fw.
float rectCoverage(vec2 f, vec2 lo, vec2 hi, vec2 fw) {
  vec2 a = smoothstep(lo - fw, lo + fw, f);
  vec2 b = 1.0 - smoothstep(hi - fw, hi + fw, f);
  return a.x * a.y * b.x * b.y;
}

struct Facade {
  float glass;   // 0..1 glass coverage
  float frame;   // 0..1 dark frame coverage
  float inner;   // recess shading
  vec2 cell;
};

// Procedural recessed windows; fwUV is fwidth(vUV) in metres.
Facade facade(vec2 uv, vec2 size, float style, vec2 fwUV) {
  Facade o = Facade(0.0, 0.0, 1.0, vec2(0.0));
  float margin = 1.0;
  float usable = size.x - 2.0 * margin;
  if (usable < 1.5 || size.y < 3.0) return o;
  float cwTarget = style < 0.5 ? 3.0 : (style < 1.5 ? 1.5 : (style < 2.5 ? 1.8 : 2.6));
  float cw = usable / max(1.0, floor(usable / cwTarget));
  float lu = uv.x - margin;
  vec2 f = vec2(lu / cw, uv.y / FLOOR_H);
  o.cell = floor(f);
  vec2 lf = fract(f);
  vec2 fw = fwUV / vec2(cw, FLOOR_H);

  vec2 lo, hi;
  float depth;
  if (style < 0.5)      { lo = vec2(0.20, 0.28); hi = vec2(0.80, 0.80); depth = 0.45; }
  else if (style < 1.5) { lo = vec2(-1.0, 0.30); hi = vec2(2.0, 0.74); depth = 0.35; }
  else if (style < 2.5) { lo = vec2(0.40, 0.10); hi = vec2(0.60, 0.92); depth = 0.6; }
  else                  { lo = vec2(0.09, 0.10); hi = vec2(0.91, 0.90); depth = 1.1; }

  // band of facade that carries windows (margins and the parapet stay solid)
  float band = smoothstep(-fwUV.x, fwUV.x, lu) * (1.0 - smoothstep(usable - fwUV.x, usable + fwUV.x, lu))
             * (1.0 - smoothstep(size.y - 0.9 - fwUV.y, size.y - 0.9 + fwUV.y, uv.y));

  float outer = rectCoverage(lf, lo, hi, fw);
  // shrink by the frame width for the pane
  vec2 fr = vec2(0.06 / cw, 0.06 / FLOOR_H);
  float pane = rectCoverage(lf, lo + fr, hi - fr, fw);
  float mull = 0.0;
  if (style > 0.5 && style < 1.5) {
    float m = min(lf.x, 1.0 - lf.x) * cw;
    mull = 1.0 - smoothstep(0.045 - fwUV.x, 0.045 + fwUV.x, m);
  }
  pane *= 1.0 - mull;

  // at a distance the pattern averages out instead of shimmering
  float far = smoothstep(0.25, 0.7, max(fw.x, fw.y));
  vec2 area = clamp(hi, 0.0, 1.0) - clamp(lo, 0.0, 1.0);
  float avg = area.x * area.y;
  o.glass = mix(pane, avg * 0.85, far) * band;
  o.frame = mix(max(outer - pane, 0.0), avg * 0.15, far) * band;

  float dTop = (hi.y - lf.y) * FLOOR_H;
  float dLeft = (lf.x - lo.x) * cw;
  o.inner = mix(smoothstep(0.0, depth * 0.9, dTop) * mix(0.55, 1.0, smoothstep(0.0, depth * 0.5, dLeft)), 0.75, far);
  return o;
}

vec3 tangentFor(vec3 n) {
  if (abs(n.y) > 0.5) return vec3(sign(n.y), 0.0, 0.0);
  return cross(vec3(0.0, 1.0, 0.0), n);
}

vec3 bitangentFor(vec3 n) {
  if (abs(n.y) > 0.5) return vec3(0.0, 0.0, -1.0);
  return vec3(0.0, 1.0, 0.0);
}

vec3 lampLight(vec3 p, vec3 n) {
  if (uNight < 0.01 || p.y > 14.0) return vec3(0.0);
  vec2 local = p.xz - CELL * floor(p.xz / CELL);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    vec2 d = LAMPS[i] - local;
    d -= CELL * floor(d / CELL + 0.5);
    vec3 toL = vec3(d.x, LAMP_H - p.y, d.y);
    float dist2 = dot(toL, toL);
    vec3 l = toL / sqrt(dist2);
    float cone = smoothstep(0.35, 0.8, l.y);
    acc += max(dot(n, l), 0.0) * cone * 60.0 / (dist2 + 4.0);
  }
  return acc * LAMP_COL * uNight;
}

float padPaint(vec2 uv, vec2 size, vec2 fw) {
  vec2 q = uv - size * 0.5;
  float w = max(fw.x, fw.y);
  float ring = 1.0 - smoothstep(0.09 - w, 0.09 + w, abs(length(q) - 1.75));
  float border = 1.0 - smoothstep(0.07 - w, 0.07 + w, abs(max(abs(q.x), abs(q.y)) - 2.35));
  float bars = step(abs(q.y), 0.95) * (1.0 - smoothstep(0.1 - w, 0.1 + w, abs(abs(q.x) - 0.65)));
  float cross_ = step(abs(q.x), 0.65) * (1.0 - smoothstep(0.08 - w, 0.08 + w, abs(q.y)));
  return clamp(ring + border + bars + cross_, 0.0, 1.0);
}

float roadPaint(vec3 p, vec2 fw) {
  vec2 g = p.xz - CELL * floor(p.xz / CELL + 0.5);
  vec2 a = abs(g);
  float half_ = STREET * 0.5;
  float inX = 1.0 - step(half_, a.x);
  float inZ = 1.0 - step(half_, a.y);
  float paint = 0.0;
  float dashZ = smoothstep(0.5 - fw.y / 6.0, 0.5 + fw.y / 6.0, 1.0 - fract(p.z / 6.0));
  float dashX = smoothstep(0.5 - fw.x / 6.0, 0.5 + fw.x / 6.0, 1.0 - fract(p.x / 6.0));
  float lineW = 0.09;
  if (inX > 0.5 && inZ < 0.5) {
    paint += (1.0 - smoothstep(lineW - fw.x, lineW + fw.x, a.x)) * dashZ;
    paint += 1.0 - smoothstep(0.07 - fw.x, 0.07 + fw.x, abs(a.x - (half_ - 1.0)));
    if (a.y > half_ + 0.6 && a.y < half_ + 3.6 && a.x < half_ - 1.4) {
      float s = fract(g.x / 1.1);
      paint = smoothstep(0.5 + fw.x, 0.5 - fw.x, s) * smoothstep(0.0, fw.x + 0.01, s);
    }
  }
  if (inZ > 0.5 && inX < 0.5) {
    paint += (1.0 - smoothstep(lineW - fw.y, lineW + fw.y, a.y)) * dashX;
    paint += 1.0 - smoothstep(0.07 - fw.y, 0.07 + fw.y, abs(a.y - (half_ - 1.0)));
    if (a.x > half_ + 0.6 && a.x < half_ + 3.6 && a.y < half_ - 1.4) {
      float s = fract(g.y / 1.1);
      paint = smoothstep(0.5 + fw.y, 0.5 - fw.y, s) * smoothstep(0.0, fw.y + 0.01, s);
    }
  }
  float wear = smoothstep(0.35, 0.6, texture(uNoise, p.xz * 0.05).r * 0.6 + texture(uNoise, p.xz * 0.4).b * 0.4);
  return clamp(paint, 0.0, 1.0) * wear;
}

void main() {
  int mat = int(vInfo.x + 0.5);
  float style = vInfo.y;
  float seed = vInfo.z;
  vec3 N = normalize(vNrm);
  vec3 V = uCamPos - vPos;
  float dist = length(V);
  V /= dist;
  vec3 L = uLightDir;
  // derivatives up front (undefined inside non-uniform control flow)
  vec2 fwUV = fwidth(vUV);
  vec2 fwXZ = fwidth(vPos.xz);

  int layer = 1;
  float tile = 6.0;
  bool horizontal = abs(N.y) > 0.5;
  if (mat == 0) { layer = 2; tile = 8.0; }
  else if (mat == 1) { layer = 3; tile = 4.0; }
  else if (mat == 2) { layer = 0; tile = 4.0; }
  else if (mat == 8) { layer = horizontal ? 3 : 0; tile = 4.0; }
  else if (mat == 13) { layer = horizontal ? 3 : 0; tile = 4.0; }
  bool vehicle = mat >= 10 && mat <= 12;
  vec2 offs = (mat <= 1 || mat == 8)
    ? vec2(0.0)
    : floor(vec2(hash12(vec2(seed * 91.7, 3.1)), hash12(vec2(seed * 17.3, 7.9))) * 4.0) * 0.25;
  // decks use world-anchored UVs so adjacent slabs line up
  vec2 uvM = (mat == 8 && horizontal) ? vPos.xz * vec2(1.0, -1.0) : vUV;
  vec2 tuv = uvM / tile + offs;

  vec4 alb = texture(uAlbedo, vec3(tuv, float(layer)));
  vec4 nt = texture(uNormal, vec3(tuv, float(layer)));
  vec3 albedo = alb.rgb * vTint;
  float cavity = alb.a;
  float rough = nt.a;
  vec3 tn = nt.xyz * 2.0 - 1.0;
  vec3 T = tangentFor(N);
  vec3 B = bitangentFor(N);
  vec3 Nd = normalize(T * tn.x + B * tn.y + N * tn.z);

  float macro = texture(uNoise, vPos.xz * 0.004 + vPos.y * 0.003).g;
  albedo *= mix(0.86, 1.08, macro);

  vec3 emissive = vec3(0.0);
  float specAmt = 0.02;

  if (mat == 0) {
    albedo = mix(albedo, vec3(0.62, 0.61, 0.56), roadPaint(vPos, fwXZ) * 0.85);
  } else if (mat == 5) {
    emissive = LAMP_COL * (0.6 + 30.0 * uNight);
    albedo = vec3(0.4);
  } else if (mat == 6) {
    albedo = vec3(0.045, 0.047, 0.05) * mix(0.8, 1.2, alb.r);
    specAmt = 0.25;
  } else if (mat == 7) {
    float ph = fract(uTime * 0.5 + seed * 7.0);
    float blink = step(0.5, ph) * smoothstep(0.0, 0.2, ph - 0.5);
    emissive = vec3(1.0, 0.08, 0.04) * (1.0 + 40.0 * blink * (0.25 + uNight));
    albedo = vec3(0.1);
  } else if (mat == 9) {
    emissive = GLOW_COL * (0.25 + 6.0 * uNight);
    albedo = vec3(0.3);
  } else if (mat == 10) {
    albedo = vTint;
    Nd = N;
    specAmt = 0.4;
  } else if (mat == 11) {
    albedo = vec3(0.02);
    Nd = N;
    specAmt = 0.6;
  } else if (mat == 12) {
    emissive = vec3(1.0, 0.05, 0.03) * (0.6 + 5.0 * uNight);
    albedo = vec3(0.2, 0.02, 0.02);
  } else if (mat == 13 && horizontal) {
    float paint = padPaint(vUV, vSize, fwUV);
    albedo = mix(albedo * 0.7, vec3(0.78, 0.6, 0.16), paint * 0.9);
    emissive = vec3(1.0, 0.75, 0.3) * paint * uNight * 0.6;
  }

  // wetness
  float up = step(0.5, N.y);
  float puddle = 0.0;
  if (uWet > 0.01) puddle = up * smoothstep(0.45, 0.62, texture(uNoise, vPos.xz * 0.02).r * 0.7 + (1.0 - cavity) * 0.6);
  float wet = uWet * mix(0.35, 1.0, up);
  bool emissiveMat = mat == 5 || mat == 7 || mat == 9 || mat == 12;
  if (!emissiveMat) {
    albedo *= mix(1.0, 0.65, wet);
    Nd = normalize(mix(Nd, N, uWet * puddle));
  }

  float sh = shadowAt(vPos, N) * cloudShadowTex(vPos);
  float NdL = max(dot(Nd, L), 0.0) * smoothstep(-0.02, 0.1, dot(N, L));
  vec3 skyTone = mix(uHorizon, uZenith, 0.55);
  skyTone = mix(vec3(dot(skyTone, vec3(0.3, 0.5, 0.2))), skyTone, 0.5);
  vec3 skyAmb = skyTone * uAmbient * 1.1 + uNight * vec3(0.012, 0.014, 0.022);
  vec3 groundAmb = (uGroundCol * 0.6 + uSunColor * 0.08) * uAmbient + uNight * vec3(0.06, 0.045, 0.03);
  vec3 hemi = mix(groundAmb, skyAmb, Nd.y * 0.5 + 0.5);

  float ao = vehicle ? 1.0 : mix(0.55, 1.0, cavity);
  if (!horizontal && !vehicle) ao *= mix(0.55, 1.0, smoothstep(0.0, 2.2, vUV.y));
  ao *= mix(0.75, 1.0, smoothstep(0.0, 30.0, vPos.y));
  if (N.y < -0.5) ao *= 0.7;

  vec3 H = normalize(L + V);
  float gloss = mix(12.0, 180.0, clamp(1.0 - rough + wet * puddle * 0.9 + specAmt, 0.0, 1.0));
  float spec = pow(max(dot(Nd, H), 0.0), gloss) * (specAmt + wet * 0.6) * (gloss / 40.0);

  vec3 color = albedo * (uSunColor * NdL * sh + hemi * ao + lampLight(vPos, Nd) * ao);
  color += uSunColor * spec * sh;

  if (up > 0.5 && uWet > 0.01 && !emissiveMat) {
    vec3 R = reflect(-V, normalize(N + (tn.x * T + tn.y * B) * 0.05 * (1.0 - puddle)));
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    color += skyBase(R) * fres * uWet * mix(0.25, 1.0, puddle) * ao;
  }

  if (mat == 4 && !horizontal) {
    Facade fa = facade(vUV, vSize, style, fwUV);
    if (fa.glass + fa.frame > 0.001) {
      float h = hash12(fa.cell + seed * 113.0);
      float h2 = hash12(fa.cell.yx * 1.7 + seed * 57.0);
      vec3 gN = normalize(N + (vec3(h, 0.0, h2) - 0.5) * 0.04);
      vec3 R = reflect(-V, gN);
      float fres = 0.04 + 0.96 * pow(1.0 - max(dot(gN, V), 0.0), 5.0);
      vec3 refl = skyBase(vec3(R.x, abs(R.y) * 0.3, R.z)) * (R.y < 0.0 ? 0.45 : 0.8) * (0.5 + 0.6 * h2);
      vec3 interior = vec3(0.008, 0.009, 0.011) * (0.4 + h) * (1.0 + uAmbient);
      float lit = step(h, 0.02 + 0.24 * uNight);
      vec3 warm = mix(vec3(1.0, 0.62, 0.32), vec3(0.75, 0.88, 1.0), step(0.8, h2));
      vec3 glassCol = (interior + refl * mix(0.04, 0.75, fres)) * fa.inner;
      glassCol += lit * warm * (0.08 + 1.5 * uNight) * fa.inner * (0.5 + 0.5 * h2);
      glassCol += uSunColor * pow(max(dot(gN, H), 0.0), 200.0) * sh * 2.0;
      vec3 frameCol = vec3(0.035, 0.037, 0.04) * (uSunColor * NdL * sh + hemi);
      color = mix(color, frameCol, fa.frame);
      color = mix(color, glassCol, fa.glass);
    }
  }

  if (mat == 10 || mat == 11) {
    vec3 R = reflect(-V, N);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 refl = skyBase(vec3(R.x, abs(R.y), R.z)) * (R.y < 0.0 ? 0.3 : 1.0);
    float glint = pow(max(dot(N, H), 0.0), 150.0) * sh;
    if (mat == 10) color += refl * mix(0.03, 0.5, fres) + uSunColor * glint * 0.6;
    else color = vec3(0.006) + refl * mix(0.12, 0.85, fres) + uSunColor * glint * 1.5;
  }

  color += emissive;
  fragColor = vec4(applyFog(color, vPos, dist, -V), 1.0);
}
`;

export const RAIN_VS = HEADER + /* glsl */ `
layout(location = 0) in vec3 aSeed;
layout(location = 1) in float aEnd;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec2 uWindVec;
uniform vec3 uCamVel;
out float vAlpha;
const vec3 BOX = vec3(44.0, 28.0, 44.0);
void main() {
  float speed = 16.0 + 6.0 * fract(aSeed.x * 91.0);
  vec3 p = aSeed * BOX;
  p.y -= uTime * speed;
  p.xz += uWindVec * uTime;
  vec3 rel = mod(p - uCamPos + BOX * 0.5, BOX) - BOX * 0.5;
  vec3 world = uCamPos + rel;
  vec3 vel = vec3(uWindVec.x, -speed, uWindVec.y) - uCamVel;
  world += vel * aEnd * 0.035;
  float edge = 1.0 - smoothstep(0.35, 0.5, max(abs(rel.x) / BOX.x, abs(rel.z) / BOX.z));
  vAlpha = edge * (1.0 - smoothstep(0.3, 0.5, abs(rel.y) / BOX.y)) * mix(1.0, 0.3, aEnd);
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const RAIN_FS = HEADER + /* glsl */ `
in float vAlpha;
uniform float uRain;
uniform vec3 uRainColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(uRainColor, vAlpha * uRain * 0.3);
}
`;

export const POST_VS = HEADER + /* glsl */ `
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const POST_FS = HEADER + /* glsl */ `
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloomTex;
uniform sampler2D uNoiseTex;
uniform float uExposure;
uniform float uTime;
uniform float uSpeed;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uGrade;
uniform float uBloom;
uniform float uFade;
uniform float uBloomLod;
uniform vec2 uResolution;
out vec4 fragColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 uv = vUV;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  float ca = (0.0005 + 0.004 * uSpeed) * r2 * 4.0;
  vec3 col = vec3(
    texture(uScene, uv - c * ca).r,
    texture(uScene, uv).g,
    texture(uScene, uv + c * ca).b);

  if (uSpeed > 0.05) {
    vec3 acc = col;
    for (int i = 1; i <= 4; i++) acc += texture(uScene, uv - c * float(i) * 0.012 * uSpeed * r2 * 4.0).rgb;
    col = acc / 5.0;
  }

  vec3 bloom = textureLod(uBloomTex, uv, uBloomLod).rgb * 0.4
             + textureLod(uBloomTex, uv, uBloomLod + 2.0).rgb * 0.35
             + textureLod(uBloomTex, uv, uBloomLod + 4.0).rgb * 0.25;
  col += max(bloom - 0.9, 0.0) * uBloom + bloom * 0.03 * uBloom;

  col = aces(col * uExposure);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uSaturation) * uGrade;
  col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);

  float vig = smoothstep(0.95, 0.25, length(c * vec2(uResolution.x / uResolution.y, 1.0)) * 0.9);
  col *= mix(0.55, 1.0, vig);
  col = pow(col, vec3(1.0 / 2.2));
  vec2 nuv = uv * uResolution / 256.0 + vec2(fract(uTime * 13.7), fract(uTime * 7.3)) * 256.0;
  col += (texture(uNoiseTex, nuv).a - 0.5) * 0.03;
  fragColor = vec4(col * uFade, 1.0);
}
`;

// Cloud shadow map: cloud coverage over the ground around the camera, one texel per ~9 m.
export const CLOUD_FS = HEADER + ATMOSPHERE + /* glsl */ `
in vec2 vUV;
uniform vec2 uCloudCenter;
uniform float uCloudExtent;
out vec4 fragColor;
void main() {
  vec2 xz = uCloudCenter + (vUV - 0.5) * 2.0 * uCloudExtent;
  fragColor = vec4(cloudShadow(vec3(xz.x, 25.0, xz.y)), 0.0, 0.0, 1.0);
}
`;

// Camera-facing particles (fire, sparks, smoke).
export const PARTICLE_VS = HEADER + /* glsl */ `
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iPosSize;
layout(location = 2) in vec4 iColor;
uniform mat4 uViewProj;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamPos;
uniform float uFogDensity;
out vec2 vCorner;
out vec4 vColor;
void main() {
  vec3 p = iPosSize.xyz + (uCamRight * aCorner.x + uCamUp * aCorner.y) * iPosSize.w;
  vCorner = aCorner;
  float fog = exp(-length(iPosSize.xyz - uCamPos) * uFogDensity);
  vColor = vec4(iColor.rgb, iColor.a * fog);
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const PARTICLE_FS = HEADER + /* glsl */ `
in vec2 vCorner;
in vec4 vColor;
uniform int uSmoke;
uniform vec3 uSmokeLight;
out vec4 fragColor;
void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;
  if (uSmoke == 1) {
    float f = smoothstep(1.0, 0.15, sqrt(r2));
    fragColor = vec4(vColor.rgb * uSmokeLight, vColor.a * f);
  } else {
    float f = exp(-r2 * 4.0);
    fragColor = vec4(vColor.rgb * vColor.a * f, 0.0);
  }
}
`;
