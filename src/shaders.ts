// GLSL ES 3.00 sources.

import { CELL } from "./city/generate";
import { PITCH_GLSL, YAW_STEP } from "./city/mesh";
import { Layer, NOISE_SIZE } from "./textures";

const YAW_STEP_GLSL = YAW_STEP.toFixed(9);
const PITCH_BASE_GLSL = PITCH_GLSL.base.toFixed(1);

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
uniform float uGroundRef; // street level near the camera (0 on the grid city)
uniform float uNight;
uniform float uCloudDither; // amplitude of the cloud-shadow dither (0 disables it)
uniform float uWet;
uniform float uTime;
uniform vec3 uCamPos;

const float CLOUD_H = 1600.0;
const float NOISE_TEXELS = ${NOISE_SIZE}.0;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/**
 * The clouds read the noise texture at about one texel per 40 m of ground, and hardware
 * filtering is linear, so value noise creases along every texel edge — then cloudBase
 * multiplies that by seven and the creases become facets. Warping the fractional part of
 * the coordinate by a smoothstep first makes the same single fetch interpolate smoothly.
 */
vec2 smoothNoiseUV(vec2 p) {
  vec2 t = p * NOISE_TEXELS - 0.5;
  vec2 i = floor(t);
  vec2 f = t - i;
  return (i + f * f * (3.0 - 2.0 * f) + 0.5) / NOISE_TEXELS;
}

float fbmOct(vec2 p, int octaves) {
  float s = 0.0, a = 0.5, norm = 0.0;
  for (int i = 0; i < octaves; i++) {
    s += a * texture(uNoise, smoothNoiseUV(p)).r;
    norm += a;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(0.37, 0.11);
    a *= 0.5;
  }
  return s / norm;
}

float fbm3(vec2 p) {
  return fbmOct(p, 3);
}

float cloudBase(vec2 wp) {
  vec2 p = wp * 0.0001 + uCloudOffset;
  float warp = texture(uNoise, smoothNoiseUV(p * 0.23)).g - 0.5;
  float n = fbm3(p + vec2(warp, -warp) * 0.35);
  float t = mix(0.70, 0.22, uCloudCover);
  return (n - t) / 0.14;
}

float cloudDensity(vec2 wp) {
  vec2 p = wp * 0.0001 + uCloudOffset;
  float det = texture(uNoise, smoothNoiseUV(p * 7.3 + uCloudOffset * 2.0)).r * 0.6
            + texture(uNoise, smoothNoiseUV(p * 17.9 - uCloudOffset * 3.0)).r * 0.4;
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

/**
 * Ground shadow of the clouds, as written into the shadow map.
 *
 * Deliberately *not* cloudDensity: that function erodes the cloud edge with high-frequency
 * noise, which reads as fine wisps against the sky but, at any frequency this map can hold,
 * becomes large feathery streaks across the ground. So the shadow keeps the smooth shape
 * and takes its extra definition from a fourth octave instead — about 6 m of ground per
 * noise texel, roughly where the map runs out.
 *
 * The dither is off by default; it exists to break up 8-bit contour bands, since the
 * threshold below multiplies the noise by about seven.
 */
float cloudShadow(vec3 p) {
  vec3 L = uLightDir;
  vec2 q = p.xz + L.xz / max(L.y, 0.08) * (CLOUD_H - p.y);
  vec2 n = q * 0.0001 + uCloudOffset;
  float warp = texture(uNoise, smoothNoiseUV(n * 0.23)).g - 0.5;
  float base = fbmOct(n + vec2(warp, -warp) * 0.35, 4);
  float t = mix(0.70, 0.22, uCloudCover);
  float dither = (texture(uNoise, fract(q * 0.02)).a - 0.5) * uCloudDither;
  float d = clamp((base - t) / 0.14 + dither, 0.0, 1.0);
  return 1.0 - d * mix(0.5, 0.8, uCloudDark);
}

// Exponential fog plus a dense, low-lying mist that pools in the street canyons.
vec3 applyFog(vec3 color, vec3 p, float dist, vec3 viewDir) {
  float hAvg = max(0.5 * (uCamPos.y + p.y) - uGroundRef, 0.0);
  float fog = 1.0 - exp(-dist * uFogDensity * exp(-hAvg / 260.0));
  const float H = 9.0;
  float y0 = max(uCamPos.y - uGroundRef, 0.0), y1 = max(p.y - uGroundRef, 0.0);
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

// Unpacking shared by the city and vehicle vertex shaders: the mesh stores a face index,
// a colour packed into one float and material and style packed together.
const VERTEX_UNPACK = /* glsl */ `
const vec3 FACE_NORMALS[6] = vec3[6](
  vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0),
  vec3(0.0, 0.0, -1.0), vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0));

// aFace holds the face index, plus the box's turn about its own vertical axis (see
// YAW_STEPS in mesh.ts) times eight, plus — on the top face of a tilted box, and nowhere
// else — the pitch of that tilt times PITCH_BASE. The corners were already turned on the
// CPU by exactly this angle, so rebuilding it here keeps the normal on the face it belongs
// to; the pitch runs the other way, leaning the normal back off a rising ramp.
vec3 faceNormal(float packed) {
  float pitch = floor(packed / ${PITCH_BASE_GLSL});
  float rest = packed - pitch * ${PITCH_BASE_GLSL};
  float turn = floor(rest * 0.125);
  vec3 n = FACE_NORMALS[int(rest - turn * 8.0)];
  if (pitch > 0.5) {
    float a = (pitch - ${(PITCH_GLSL.max + 1).toFixed(1)}) * ${PITCH_GLSL.step.toFixed(6)};
    float c = cos(a), s = sin(a);
    n = vec3(c * n.x - s * n.y, s * n.x + c * n.y, n.z);
  }
  if (turn == 0.0) return n;
  float a = turn * ${YAW_STEP_GLSL};
  float c = cos(a), s = sin(a);
  return vec3(c * n.x - s * n.z, n.y, s * n.x + c * n.z);
}

vec3 unpackTint(float p) {
  float r = floor(p / 65536.0);
  float g = floor((p - r * 65536.0) / 256.0);
  return vec3(r, g, p - r * 65536.0 - g * 256.0) / 255.0;
}

// aInfo.x holds material + style * 64; aInfo.y is the per-box seed
vec3 unpackInfo(vec2 info) {
  float style = floor(info.x / 64.0);
  return vec3(info.x - style * 64.0, style, info.y);
}
`;

export const CITY_VS = HEADER + VERTEX_UNPACK + /* glsl */ `
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aFace;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec2 aSize;
layout(location = 4) in float aTint;
layout(location = 5) in vec2 aInfo;
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
  vNrm = faceNormal(aFace);
  vUV = aUV;
  vSize = aSize;
  vTint = unpackTint(aTint);
  vInfo = unpackInfo(aInfo);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const VEHICLE_VS = HEADER + VERTEX_UNPACK + /* glsl */ `
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aFace;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec2 aSize;
layout(location = 4) in float aTint;
layout(location = 5) in vec2 aInfo;
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
  vec3 info = unpackInfo(aInfo);
  vPos = iPos + R * aPos;
  vNrm = R * faceNormal(aFace);
  vUV = aUV;
  vSize = aSize;
  // style 1 marks painted parts, which take the instance colour
  vTint = info.y > 0.5 ? iColor.rgb : unpackTint(aTint);
  vInfo = vec3(info.x, 0.0, iColor.a);
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

export const CITY_FS = HEADER + /* glsl */ `
const float CELL = ${CELL.toFixed(1)};
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
uniform float uShadowPixel; // shadow-map UV one screen pixel covers, per metre of distance
uniform sampler2D uCloudTex;
uniform vec2 uCloudCenter;
uniform float uCloudExtent;
uniform float uCloudTexels; // width of the cloud shadow map, for its own filtering
uniform float uDetailDist; // beyond this, surfaces drop to a cheaper shading path
uniform float uCheap; // diagnostic only: strips shading stages to find the real cost
out vec4 fragColor;

const float CLOUD_REF_Y = 25.0;

/** Cloud shadow at a point, from the map built around the camera. */
float cloudShadowTex(vec3 p) {
  vec2 k = uLightDir.xz / max(uLightDir.y, 0.08);
  vec2 q = p.xz - k * (p.y - CLOUD_REF_Y);
  vec2 uv = (q - uCloudCenter) / (2.0 * uCloudExtent) + 0.5;
  // smoothstep-warped, so the map's own ~9 m texels do not crease either
  vec2 t = uv * uCloudTexels - 0.5;
  vec2 i = floor(t);
  vec2 f = t - i;
  return texture(uCloudTex, (i + f * f * (3.0 - 2.0 * f) + 0.5) / uCloudTexels).r;
}

const vec3 LAMP_COL = vec3(1.0, 0.72, 0.42);
const vec3 GLOW_COL = vec3(0.72, 0.84, 1.0);
const float FLOOR_H = 3.4;

/**
 * Sun shadow at a point, filtered to about a pixel and a half across.
 *
 * A shadow texel is nine centimetres and a pixel of road a hundred metres out is a third of
 * a metre, so four taps spread by a fixed count of texels leave an edge that is hard to
 * within a pixel — the staircase down the side of every shadow on the road, which no amount
 * of multisampling touches because it is not a geometry edge. Widening the kernel with the
 * pixel's own footprint keeps the penumbra a constant width on screen instead.
 *
 * The taps stay at least a texel apart, so nothing close up gets softer than it was, and
 * stop at eight, past which the sun would stop reading as a point source at all.
 */
float shadowAt(vec3 p, vec3 n, float dist) {
  float r = clamp(dist * uShadowPixel * 0.6, uShadowTexel, uShadowTexel * 8.0);
  vec4 lp = uLightVP * vec4(p + n * 0.12, 1.0);
  vec3 s = lp.xyz / lp.w * 0.5 + 0.5;
  if (s.x <= 0.0 || s.x >= 1.0 || s.y <= 0.0 || s.y >= 1.0 || s.z >= 1.0) return 1.0;
  float sum = 0.0;
  const vec2 taps[4] = vec2[4](vec2(-0.4, -1.2), vec2(1.2, -0.4), vec2(0.4, 1.2), vec2(-1.2, 0.4));
  for (int i = 0; i < 4; i++)
    sum += texture(uShadow, vec3(s.xy + taps[i] * r, s.z - 0.00015));
  sum *= 0.25;
  float edge = max(abs(s.x - 0.5), abs(s.y - 0.5));
  return mix(sum, 1.0, smoothstep(0.42, 0.5, edge));
}

struct Cell {
  vec2 uv;    // panel coordinates: one unit is one window cell
  vec2 id;    // which cell, for per-window variation
  float band; // 1 where the facade carries windows, 0 on margins and the parapet
};

/**
 * Where a wall pixel falls on the window grid. The columns divide the usable width into
 * whole cells, so no pane is ever cut in half at a corner, and one cell maps to exactly
 * one panel texture tile, which keeps the panel joints off the glass.
 */
Cell facadeCell(vec2 uv, vec2 size, float style, vec2 fwUV) {
  Cell o = Cell(vec2(0.0), vec2(0.0), 0.0);
  float margin = 1.0;
  float usable = size.x - 2.0 * margin;
  if (usable < 1.5 || size.y < 3.0) return o;
  float cwTarget = style < 0.5 ? 3.0 : (style < 1.5 ? 1.5 : (style < 2.5 ? 1.8 : (style < 3.5 ? 2.6 : 2.2)));
  float cw = usable / max(1.0, floor(usable / cwTarget));
  float lu = uv.x - margin;
  o.uv = vec2(lu / cw, uv.y / FLOOR_H);
  o.id = floor(o.uv);
  o.band = smoothstep(-fwUV.x, fwUV.x, lu) * (1.0 - smoothstep(usable - fwUV.x, usable + fwUV.x, lu))
         * (1.0 - smoothstep(size.y - 0.9 - fwUV.y, size.y - 0.9 + fwUV.y, uv.y));
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

uniform vec3 uLampPos[24]; // the nearest street lamp heads

vec3 lampLight(vec3 p, vec3 n) {
  if (uNight < 0.01) return vec3(0.0);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    vec3 toL = uLampPos[i] - p;
    float dist2 = dot(toL, toL);
    if (dist2 > 900.0) continue;
    vec3 l = toL * inversesqrt(dist2);
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
  else if (mat == 2) {
    // concrete finish: board-formed, bush-hammered ribs or plywood-formed
    if (style > 1.5) { layer = 5; tile = 4.8; }
    else if (style > 0.5) { layer = 4; tile = 3.0; }
    else { layer = 0; tile = 4.0; }
  }
  else if (mat == 4) {
    if (style > 3.5) { layer = 5; tile = 4.8; }
    else if (style > 1.5 && style < 2.5) { layer = 4; tile = 3.0; }
  }
  else if (mat == 8) { layer = horizontal ? 3 : 0; tile = 4.0; }
  else if (mat == 13) { layer = horizontal ? 3 : 0; tile = 4.0; }
  bool vehicle = mat >= 10 && mat <= 12;
  vec2 offs = (mat <= 1 || mat == 8)
    ? vec2(0.0)
    : floor(vec2(hash12(vec2(seed * 91.7, 3.1)), hash12(vec2(seed * 17.3, 7.9))) * 4.0) * 0.25;
  // decks use world-anchored UVs so adjacent slabs line up
  // Ground and decks take their texture from where they are in the world, not from the box.
  // The terrain is thousands of small tiles and per-box coordinates restart on every one of
  // them, which tiles the ground with a visible grid of seams.
  vec2 uvM = ((mat == 8 || mat == 0 || mat == 1) && horizontal) ? vPos.xz * vec2(1.0, -1.0) : vUV;
  vec2 tuv = uvM / tile + offs;

  // Walls that carry windows read a facade panel instead: one tile per window cell, with
  // the panel joint on the cell border. Mipmaps average the pattern down at a distance,
  // so nothing here has to fade the detail out by hand.
  bool facadeWall = mat == 4 && !horizontal;
  Cell cell = Cell(vec2(0.0), vec2(0.0), 0.0);
  float panelLayer = 0.0;
  if (facadeWall) {
    cell = facadeCell(vUV, vSize, style, fwUV);
    bool strip = (style > 0.5 && style < 1.5) || (style > 2.5 && style < 3.5);
    panelLayer = strip ? ${Layer.Ribbon}.0 : ${Layer.Punched}.0;
  }

  // Past uDetailDist a surface bump is well under a pixel, so the normal map is dropped:
  // that is one anisotropic array fetch per pixel saved over most of the screen.
  bool detailed = dist < uDetailDist;
  vec4 alb, nt = vec4(0.5, 0.5, 1.0, 0.78); // flat normal, mid roughness
  if (cell.band > 0.999) {
    alb = texture(uAlbedo, vec3(cell.uv, panelLayer));
    if (detailed) nt = texture(uNormal, vec3(cell.uv, panelLayer));
  } else if (cell.band < 0.001) {
    alb = texture(uAlbedo, vec3(tuv, float(layer)));
    if (detailed) nt = texture(uNormal, vec3(tuv, float(layer)));
  } else {
    alb = mix(texture(uAlbedo, vec3(tuv, float(layer))), texture(uAlbedo, vec3(cell.uv, panelLayer)), cell.band);
    if (detailed) nt = mix(texture(uNormal, vec3(tuv, float(layer))), texture(uNormal, vec3(cell.uv, panelLayer)), cell.band);
  }
  // on a panel layer the alpha channel is the glass mask and the cavity is already in the albedo
  bool onPanel = cell.band > 0.5;
  float glass = onPanel ? alb.a : 0.0;
  vec3 albedo = alb.rgb * vTint;
  float cavity = onPanel ? 1.0 : alb.a;
  float rough = detailed ? nt.a : mix(0.78, 0.10, glass); // keep distant glazing glossy
  vec3 tn = nt.xyz * 2.0 - 1.0;
  vec3 T = tangentFor(N);
  vec3 B = bitangentFor(N);
  vec3 Nd = normalize(T * tn.x + B * tn.y + N * tn.z);

  float macro = texture(uNoise, vPos.xz * 0.004 + vPos.y * 0.003).g;
  albedo *= mix(0.86, 1.08, macro);

  // weathering on concrete walls: stains running down from the top edge, splash-back dirt at the
  // foot and a patchy tone per surface. The noise texture has no mipmaps, so these lookups are
  // safe inside the branch, and the fine streaks fade out with distance instead.
  bool concrete = (mat == 2 || mat == 3 || mat == 4 || mat == 8) && glass < 0.5 && detailed;
  if (concrete) {
    float wBlot = texture(uNoise, vUV * 0.06 + seed * 13.0).g;
    albedo *= mix(0.9, 1.06, wBlot);
    if (!horizontal) {
      float wStreak = texture(uNoise, vec2(vUV.x * 0.07 + seed * 37.0, vUV.y * 0.005 + seed * 5.0)).b;
      float wPatch = texture(uNoise, vec2(vUV.x * 0.045 + seed * 11.0, vUV.y * 0.03 - seed * 3.0)).g;
      float near = 1.0 - smoothstep(60.0, 220.0, dist);
      float fromTop = vSize.y - vUV.y;
      float run = exp(-fromTop / mix(2.5, 16.0, wPatch));
      float streak = mix(0.35, smoothstep(0.42, 0.85, wStreak), near) * smoothstep(0.3, 0.75, wPatch);
      float tall = smoothstep(1.5, 4.0, vSize.y);
      albedo *= 1.0 - 0.45 * streak * mix(0.3, 1.0, run) * tall;
      float foot = (1.0 - smoothstep(0.0, 0.8 + 1.8 * wPatch, vUV.y)) * tall;
      albedo *= mix(vec3(1.0), vec3(0.7, 0.72, 0.66), foot * 0.85);
    }
  }

  vec3 emissive = vec3(0.0);
  float specAmt = 0.02;

  if (mat == 0) {
    // Trench repairs, each a shade off the road round it and ringed by a tar seam. They are
    // found on a grid, but sized and placed anywhere within their cell — on the grid itself
    // they would read as a chequerboard from any height.
    vec2 pc = floor(vPos.xz / 9.0);
    float patched = step(0.62, hash12(pc * 1.7));
    vec2 ext = 0.14 + 0.22 * vec2(hash12(pc + 8.3), hash12(pc + 11.7));
    vec2 mid = ext + (1.0 - 2.0 * ext) * vec2(hash12(pc + 2.9), hash12(pc + 5.1));
    vec2 q = abs(fract(vPos.xz / 9.0) - mid) / ext;
    float far = max(q.x, q.y);
    // far counts out from the middle of the patch in units of its own half-width, and this
    // is how much of that a pixel covers. Stepped on instead, the patch edge and the tar seam
    // round it are hard lines a few centimetres wide: fine underfoot, but from the air they
    // are far under a pixel, and every one of them crawls as the camera moves. Widening the
    // transition to the pixel lets them average out into the road instead.
    float fwFar = max(fwXZ.x / ext.x, fwXZ.y / ext.y) / 9.0 + 1e-4;
    float inPatch = patched * (1.0 - smoothstep(1.0 - fwFar, 1.0 + fwFar, far));
    albedo *= mix(1.0, 0.87, inPatch);
    albedo *= mix(1.0, 0.68, inPatch * smoothstep(0.88 - fwFar, 0.88 + fwFar, far));
    // ironwork: covers and gully gratings, darker and smoother than the road round them
    vec2 mc = floor(vPos.xz / 13.0);
    vec2 mp = (mc + vec2(hash12(mc), hash12(mc + 7.3))) * 13.0;
    float fwR = max(fwXZ.x, fwXZ.y);
    float cover = (1.0 - smoothstep(0.56 - fwR, 0.56 + fwR, length(vPos.xz - mp)))
                * step(0.45, hash12(mc + 3.1));
    albedo = mix(albedo, vec3(0.135, 0.13, 0.125), cover);
    specAmt = mix(specAmt, 0.14, cover);
    // grime gathers in the gutters, where the camber takes the water
    vec2 gg = abs(vPos.xz - CELL * floor(vPos.xz / CELL + 0.5));
    albedo *= mix(1.0, 0.84, max(smoothstep(6.0, 8.9, gg.x), smoothstep(6.0, 8.9, gg.y)));
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
  } else if (mat == 15) {
    // River water: dark, glossy, and running. A bay of the surface is turned to the
    // channel, so its own u axis runs downstream and its v across it, and the seed says how
    // far down the river the bay begins — between them one coordinate that follows the
    // river however it bends. Scrolled in world space instead, as it was, every river in the
    // city drifted the same way across the ground whichever way it actually ran.
    //
    // The station wraps every 4096 m, so the scales along it are whole numbers of cycles in
    // that distance and the pattern meets itself where it wraps.
    vec2 flow = vec2(seed + vUV.x, vUV.y);
    vec2 slick = vec2(flow.x * (90.0 / 4096.0) - uTime * 0.075, flow.y * 0.075);
    vec2 chop = vec2(flow.x * (287.0 / 4096.0) - uTime * 0.16, flow.y * 0.11 + uTime * 0.01);
    // Value noise is a lattice, and on open water it is the only pattern there is: sampled
    // straight, its cells came out as a grid of squares under a metre across, square to the
    // channel and holding still while the river ran over them — the floor of a swimming
    // pool. Each lookup is bent by a slow field of its own, which takes the lattice off its
    // own axes; the warp is built from the same wrapping coordinate, so the pattern still
    // meets itself where the station wraps.
    vec2 warp = (texture(uNoise, vec2(flow.x * (23.0 / 4096.0) + 0.21, flow.y * 0.019)).rg - 0.5) * 0.09;
    float w1 = texture(uNoise, slick + warp).r;
    float w2 = texture(uNoise, chop + warp * 1.6).g;
    float w3 = texture(uNoise, chop * 2.0 - vec2(uTime * 0.26, 0.0) + warp * 0.7).b;
    // drawn out along the current: the slow layer is stretched four to one down the channel
    albedo = mix(vec3(0.035, 0.055, 0.062), vec3(0.06, 0.10, 0.11), w1 * 0.65 + w2 * 0.35);
    Nd = normalize(N + vec3((w2 - 0.5) * 0.2 + (w3 - 0.5) * 0.1, 0.0, (w1 - 0.5) * 0.18));
    specAmt = 0.55;
    // Water wears none of the surface maps. The albedo and the normal are replaced here, but
    // cavity and roughness were read further up from whatever layer the material defaulted
    // to — precast panels, on a six-metre tile — and left at that the river carried the
    // joints of that panel as occlusion and as a change in the sheen: square tiles on the
    // floor of a swimming pool. Worst in shade, where the ambient that cavity scales is all
    // the light there is, and only within uDetailDist, which is why it came and went.
    cavity = 1.0;
    rough = mix(0.02, 0.09, w2);
    tn = vec3(0.0, 0.0, 1.0);
  } else if (mat == 14) {
    // one box per aspect; the seed offsets the cycle, so the two axes of a junction disagree
    float ph = fract(uTime / 16.0 + seed);
    float on = style < 0.5 ? step(0.52, ph)
             : style < 1.5 ? step(0.44, ph) * step(ph, 0.52)
             : step(ph, 0.44);
    vec3 col = style < 0.5 ? vec3(1.0, 0.09, 0.05)
             : style < 1.5 ? vec3(1.0, 0.55, 0.05) : vec3(0.22, 1.0, 0.35);
    emissive = col * on * (1.4 + 14.0 * uNight);
    albedo = col * 0.1;
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
  bool emissiveMat = mat == 5 || mat == 7 || mat == 9 || mat == 12 || mat == 14;
  if (!emissiveMat) {
    albedo *= mix(1.0, 0.65, wet);
    Nd = normalize(mix(Nd, N, uWet * puddle));
  }

  // uCheap is a diagnostic ladder for finding what the pass actually costs:
  // 1 drops the fog, 2 also drops the shadows, 3 shows the raw material.
  if (uCheap > 2.5) { fragColor = vec4(albedo, 1.0); return; }
  float sh = uCheap > 1.5 ? 1.0 : shadowAt(vPos, N, dist);
  float NdL = max(dot(Nd, L), 0.0) * smoothstep(-0.02, 0.1, dot(N, L));
  vec3 skyTone = mix(uHorizon, uZenith, 0.55);
  skyTone = mix(vec3(dot(skyTone, vec3(0.3, 0.5, 0.2))), skyTone, 0.5);
  vec3 skyAmb = skyTone * uAmbient * 1.1 + uNight * vec3(0.012, 0.014, 0.022);
  vec3 groundAmb = (uGroundCol * 0.6 + uSunColor * 0.08) * uAmbient + uNight * vec3(0.06, 0.045, 0.03);
  vec3 hemi = mix(groundAmb, skyAmb, Nd.y * 0.5 + 0.5);
  float cs = uCheap > 1.5 ? 1.0 : cloudShadowTex(vPos);
  sh *= cs;
  // sunlight bounced off lit walls and paving: it fills shade from the side away from the sun and from below
  vec3 bounceDir = normalize(vec3(-L.x, -0.35, -L.z));
  vec3 bounce = uSunColor * (0.05 + 0.08 * max(dot(Nd, bounceDir), 0.0) + 0.03 * max(Nd.y, 0.0)) * mix(0.4, 1.0, cs) * (0.3 + 0.7 * L.y);
  hemi += bounce;

  float ao = vehicle ? 1.0 : mix(0.65, 1.0, cavity);
  // darken where tall walls meet the ground, not whole steps and railings
  if (!horizontal && !vehicle) ao *= mix(1.0, mix(0.6, 1.0, smoothstep(0.0, 2.2, vUV.y)), smoothstep(2.5, 5.0, vSize.y));
  ao *= mix(0.8, 1.0, smoothstep(0.0, 30.0, vPos.y - uGroundRef));
  if (N.y < -0.5) ao *= 0.8;

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

  // Glazing. The frame, reveal and sill come from the panel texture; what stays here is
  // what has to differ from window to window: reflection, blinds and who left a light on.
  if (glass > 0.001) {
    float h = hash12(cell.id + seed * 113.0);
    float h2 = hash12(cell.id.yx * 1.7 + seed * 57.0);
    vec3 gN = normalize(N + (vec3(h, 0.0, h2) - 0.5) * 0.04);
    vec3 R = reflect(-V, gN);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(gN, V), 0.0), 5.0);
    vec3 refl = skyBase(vec3(R.x, abs(R.y) * 0.3, R.z)) * (R.y < 0.0 ? 0.45 : 0.8) * (0.5 + 0.6 * h2);
    vec3 glassCol = albedo * (0.5 + h) + refl * mix(0.04, 0.75, fres);
    // blinds hang from the head of the window, pulled down to a different height in each
    float drop = step(0.45, h2) * (0.35 + 0.45 * h);
    float blind = smoothstep(0.0, 0.02, fract(cell.uv.y) - (0.92 - drop));
    vec3 blindCol = vec3(0.42, 0.41, 0.38) * (hemi * 0.8 + uSunColor * NdL * sh * 0.12);
    glassCol = mix(glassCol, blindCol, blind * 0.88);
    float lit = step(h, 0.02 + 0.24 * uNight);
    vec3 warm = mix(vec3(1.0, 0.62, 0.32), vec3(0.75, 0.88, 1.0), step(0.8, h2));
    glassCol += lit * warm * (0.08 + 1.5 * uNight) * (0.5 + 0.5 * h2) * mix(1.0, 0.45, blind);
    glassCol += uSunColor * pow(max(dot(gN, H), 0.0), 200.0) * sh * 2.0;
    color = mix(color, glassCol, glass);
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
  fragColor = vec4(uCheap > 0.5 ? color : applyFog(color, vPos, dist, -V), 1.0);
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
uniform vec2 uSceneSize; // the scene texture, which the adaptive scale can make smaller than the canvas
uniform float uFxaa;
out vec4 fragColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// Luma of an HDR sample, compressed the way the tonemap will compress it, so that
// edge detection works on the contrast the eye ends up seeing.
float fxaaLuma(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return sqrt(l / (1.0 + l));
}

// FXAA (the classic corner-tap form), used in place of MSAA: it costs one texture
// tap per corner in flat areas and a short blend along the edge elsewhere.
vec3 fxaa(vec2 uv, vec2 texel) {
  vec3 mid = texture(uScene, uv).rgb;
  float lM = fxaaLuma(mid);
  float lNW = fxaaLuma(texture(uScene, uv + vec2(-1.0, -1.0) * texel).rgb);
  float lNE = fxaaLuma(texture(uScene, uv + vec2(1.0, -1.0) * texel).rgb);
  float lSW = fxaaLuma(texture(uScene, uv + vec2(-1.0, 1.0) * texel).rgb);
  float lSE = fxaaLuma(texture(uScene, uv + vec2(1.0, 1.0) * texel).rgb);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.045, lMax * 0.125)) return mid;

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * texel;

  vec3 inner = 0.5 * (texture(uScene, uv + dir * (1.0 / 3.0 - 0.5)).rgb
                    + texture(uScene, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 outer = inner * 0.5 + 0.25 * (texture(uScene, uv - dir * 0.5).rgb
                                   + texture(uScene, uv + dir * 0.5).rgb);
  float lOuter = fxaaLuma(outer);
  return (lOuter < lMin || lOuter > lMax) ? inner : outer;
}

void main() {
  vec2 uv = vUV;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  float ca = (0.0005 + 0.004 * uSpeed) * r2 * 4.0;
  vec3 col;
  if (uFxaa > 0.5) {
    col = fxaa(uv, 1.0 / uSceneSize);
    // the fringe is under a pixel wide until the camera moves fast; skip it then
    vec2 off = c * ca;
    if (length(off * uSceneSize) > 0.75) {
      col.r = texture(uScene, uv - off).r;
      col.b = texture(uScene, uv + off).b;
    }
  } else {
    col = vec3(
      texture(uScene, uv - c * ca).r,
      texture(uScene, uv).g,
      texture(uScene, uv + c * ca).b);
  }

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
