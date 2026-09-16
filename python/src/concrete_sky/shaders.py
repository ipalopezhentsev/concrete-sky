"""GLSL sources."""

from .city import CELL, LAMP_HEIGHT, STREET, lamp_heads_local

HEADER = "#version 330 core\n"

ATMOSPHERE = """
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
    vec2 p = wp * 0.00010 + uCloudOffset;
    float warp = texture(uNoise, p * 0.23).g - 0.5;
    float n = fbm3(p + vec2(warp, -warp) * 0.35);
    float t = mix(0.70, 0.22, uCloudCover);
    return (n - t) / 0.14;
}

// full detail, for the sky
float cloudDensity(vec2 wp) {
    vec2 p = wp * 0.00010 + uCloudOffset;
    float det = texture(uNoise, p * 7.3 + uCloudOffset * 2.0).r * 0.6
              + texture(uNoise, p * 17.9 - uCloudOffset * 3.0).r * 0.4;
    float erode = mix(0.9, 0.3, uCloudCover * uCloudCover);
    float d = clamp(cloudBase(wp) + erode * 0.5 - det * erode, 0.0, 1.0);
    return max(d, smoothstep(0.85, 1.0, uCloudCover) * (0.75 + 0.2 * det));
}

vec3 skyBase(vec3 rd) {
    float y = rd.y;
    vec3 col;
    if (y >= 0.0) {
        col = mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.5));
    } else {
        col = mix(uHorizon, uGroundCol, clamp(-y * 5.0, 0.0, 1.0));
    }
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
    float disk = smoothstep(0.99955, 0.99975, sd);
    col += uSunColor * disk * 25.0 * step(0.0, rd.y);
    vec4 c = clouds(rd);
    col = mix(col, c.rgb, c.a);
    float skyFog = clamp(uFogDensity * 70.0, 0.0, 1.0) * (1.0 - 0.6 * clamp(rd.y * 2.0, 0.0, 1.0));
    col = mix(col, fogColor(rd), skyFog);
    return col;
}

float cloudShadow(vec3 p) {
    vec3 L = uLightDir;
    vec2 q = p.xz + L.xz / max(L.y, 0.08) * (CLOUD_H - p.y);
    float d = clamp(cloudBase(q), 0.0, 1.0);
    return 1.0 - d * mix(0.5, 0.8, uCloudDark);
}
"""

SKY_VS = HEADER + """
layout(location = 0) in vec2 aPos;
out vec2 vNdc;
void main() {
    vNdc = aPos;
    gl_Position = vec4(aPos, 1.0, 1.0);
}
"""

SKY_FS = HEADER + ATMOSPHERE + """
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
"""

CITY_VS = HEADER + """
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec2 aSize;
layout(location = 4) in vec3 aTint;
layout(location = 5) in vec3 aInfo;
uniform mat4 uViewProj;
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
"""

SHADOW_VS = HEADER + """
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }
"""

SHADOW_FS = HEADER + """
void main() {}
"""

_lamps = ", ".join(f"vec2({x:.3f}, {z:.3f})" for x, z in lamp_heads_local())

CITY_FS = HEADER + f"""
const float CELL = {CELL:.1f};
const float STREET = {STREET:.1f};
const float LAMP_H = {LAMP_HEIGHT:.2f};
const vec2 LAMPS[8] = vec2[8]({_lamps});
""" + ATMOSPHERE + """
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
out vec4 fragColor;

const vec3 LAMP_COL = vec3(1.0, 0.72, 0.42);

float shadowAt(vec3 p, vec3 n) {
    vec4 lp = uLightVP * vec4(p + n * 0.12, 1.0);
    vec3 s = vec3(lp.xy / lp.w * 0.5 + 0.5, lp.z / lp.w);
    if (s.x <= 0.0 || s.x >= 1.0 || s.y <= 0.0 || s.y >= 1.0 || s.z >= 1.0) return 1.0;
    float bias = 0.0004;
    float sum = 0.0;
    const vec2 taps[4] = vec2[4](vec2(-0.4, -1.2), vec2(1.2, -0.4), vec2(0.4, 1.2), vec2(-1.2, 0.4));
    for (int i = 0; i < 4; i++)
        sum += texture(uShadow, vec3(s.xy + taps[i] * uShadowTexel, s.z - bias));
    float edge = max(abs(s.x - 0.5), abs(s.y - 0.5));
    return mix(sum / 4.0, 1.0, smoothstep(0.42, 0.5, edge));
}

// procedural facade windows; returns 1 for glass, fills cell id and inner shading
float windows(vec2 uv, vec2 size, float style, out vec2 cell, out float inner, out float frame) {
    inner = 1.0;
    frame = 0.0;
    cell = vec2(0.0);
    float margin = 1.0;
    float usable = size.x - 2.0 * margin;
    if (usable < 1.5 || size.y < 3.0) return 0.0;
    float lu = uv.x - margin;
    if (lu < 0.0 || lu > usable || uv.y > size.y - 0.9) return 0.0;
    float floorH = 3.4;
    float cwTarget = style < 0.5 ? 3.0 : (style < 1.5 ? 1.5 : (style < 2.5 ? 1.8 : 2.6));
    float nc = max(1.0, floor(usable / cwTarget));
    float cw = usable / nc;
    float cu = lu / cw;
    float fy = uv.y / floorH;
    vec2 f = vec2(fract(cu), fract(fy));
    cell = vec2(floor(cu), floor(fy));
    vec2 lo, hi;
    float depth;
    if (style < 0.5)      { lo = vec2(0.20, 0.28); hi = vec2(0.80, 0.80); depth = 0.45; }
    else if (style < 1.5) { lo = vec2(-1.0, 0.30); hi = vec2(2.0, 0.74); depth = 0.35; }
    else if (style < 2.5) { lo = vec2(0.40, 0.10); hi = vec2(0.60, 0.92); depth = 0.6; }
    else                  { lo = vec2(0.09, 0.10); hi = vec2(0.91, 0.90); depth = 1.1; }
    if (f.x < lo.x || f.x > hi.x || f.y < lo.y || f.y > hi.y) return 0.0;
    float dTop = (hi.y - f.y) * floorH;
    float dLeft = (f.x - lo.x) * cw;
    float dBottom = (f.y - lo.y) * floorH;
    // fake reveal: the lintel and a jamb shade the recessed glass
    inner = smoothstep(0.0, depth * 0.9, dTop) * mix(0.55, 1.0, smoothstep(0.0, depth * 0.5, dLeft));
    frame = 1.0 - step(0.05, min(min(dTop, dBottom), min(dLeft, (hi.x - f.x) * cw)));
    if (style > 0.5 && style < 1.5) {
        float m = min(f.x, 1.0 - f.x) * cw;
        frame = max(frame, 1.0 - step(0.045, m));
    }
    return 1.0;
}

float fy_of(float y) { return y / 3.4; }

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

float roadPaint(vec3 p) {
    vec2 g = p.xz - CELL * floor(p.xz / CELL + 0.5);
    vec2 a = abs(g);
    float half_ = STREET * 0.5;
    bool inX = a.x < half_;
    bool inZ = a.y < half_;
    float paint = 0.0;
    if (inX && !inZ) {
        paint += step(a.x, 0.09) * step(fract(p.z / 6.0), 0.5);
        paint += step(abs(a.x - (half_ - 1.0)), 0.07);
        if (a.y > half_ + 0.6 && a.y < half_ + 3.6 && a.x < half_ - 1.4)
            paint = step(fract(g.x / 1.1), 0.5);
    }
    if (inZ && !inX) {
        paint += step(a.y, 0.09) * step(fract(p.x / 6.0), 0.5);
        paint += step(abs(a.y - (half_ - 1.0)), 0.07);
        if (a.x > half_ + 0.6 && a.x < half_ + 3.6 && a.y < half_ - 1.4)
            paint = step(fract(g.y / 1.1), 0.5);
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

    int layer = 1;
    float tile = 6.0;
    if (mat == 0) { layer = 2; tile = 8.0; }
    else if (mat == 1) { layer = 3; tile = 4.0; }
    else if (mat == 2) { layer = 0; tile = 4.0; }
    vec2 offs = mat <= 1 ? vec2(0.0) : floor(vec2(hash12(vec2(seed * 91.7, 3.1)), hash12(vec2(seed * 17.3, 7.9))) * 4.0) * 0.25;
    vec2 tuv = vUV / tile + offs;

    vec4 alb = texture(uAlbedo, vec3(tuv, layer));
    vec4 nt = texture(uNormal, vec3(tuv, layer));
    vec3 albedo = alb.rgb * vTint;
    float cavity = alb.a;
    float rough = nt.a;
    vec3 tn = nt.xyz * 2.0 - 1.0;
    vec3 T = tangentFor(N);
    vec3 B = bitangentFor(N);
    vec3 Nd = normalize(T * tn.x + B * tn.y + N * tn.z);

    // distance-based large-scale weathering to break tiling
    float macro = texture(uNoise, vPos.xz * 0.004 + vPos.y * 0.003).g;
    albedo *= mix(0.86, 1.08, macro);

    vec3 emissive = vec3(0.0);
    float specAmt = 0.02;
    float glass = 0.0;
    float innerShade = 1.0;

    if (mat == 0) {
        float paint = roadPaint(vPos);
        albedo = mix(albedo, vec3(0.62, 0.61, 0.56), paint * 0.85);
    } else if (mat == 4) {
        vec2 cell; float inner; float frame;
        glass = windows(vUV, vSize, style, cell, inner, frame);
        if (abs(N.y) > 0.5) glass = 0.0;
        if (glass > 0.5) {
            float h = hash12(cell + seed * 113.0);
            float h2 = hash12(cell.yx * 1.7 + seed * 57.0);
            innerShade = inner;
            if (frame > 0.5) {
                albedo = vec3(0.035, 0.037, 0.04);
                glass = 0.0;
                specAmt = 0.08;
                Nd = N;
            } else {
                vec3 gN = normalize(N + (vec3(h, 0.0, h2) - 0.5) * 0.04);
                vec3 R = reflect(-V, gN);
                float fres = 0.04 + 0.96 * pow(1.0 - max(dot(gN, V), 0.0), 5.0);
                vec3 refl = skyBase(R) * (R.y < 0.0 ? 0.25 : 1.0) * (0.55 + 0.6 * h2);
                vec3 interior = vec3(0.008, 0.009, 0.011) * (0.4 + h) * (1.0 + uAmbient);
                float blind = step(0.82, h2) * step(0.5, fract(vUV.y * 8.0)) * step(0.55, fract(fy_of(vUV.y)));
                interior += blind * vec3(0.03) * uAmbient;
                float litChance = 0.02 + 0.24 * uNight;
                float lit = step(h, litChance);
                vec3 warm = mix(vec3(1.0, 0.62, 0.32), vec3(0.75, 0.88, 1.0), step(0.8, h2));
                emissive = lit * warm * (0.08 + 1.5 * uNight) * inner * (0.5 + 0.5 * h2);
                vec3 glassCol = interior * inner + refl * mix(0.04, 0.75, fres) * inner;
                albedo = glassCol;
            }
        }
    } else if (mat == 5) {
        emissive = LAMP_COL * (0.6 + 30.0 * uNight);
        albedo = vec3(0.4);
    } else if (mat == 6) {
        albedo = vec3(0.045, 0.047, 0.05) * mix(0.8, 1.2, alb.r);
        specAmt = 0.25;
    } else if (mat == 7) {
        float blink = step(0.5, fract(uTime * 0.5 + seed * 7.0)) * smoothstep(0.0, 0.2, fract(uTime * 0.5 + seed * 7.0) - 0.5);
        emissive = vec3(1.0, 0.08, 0.04) * (1.0 + 40.0 * blink * (0.25 + uNight));
        albedo = vec3(0.1);
    }

    // wetness: darker, smoother, reflective puddles on horizontal surfaces
    float horizontal = step(0.5, N.y);
    float puddle = horizontal * smoothstep(0.45, 0.62, texture(uNoise, vPos.xz * 0.02).r * 0.7 + (1.0 - cavity) * 0.6);
    float wet = uWet * mix(0.35, 1.0, horizontal);
    if (glass < 0.5 && mat != 5 && mat != 7) {
        albedo *= mix(1.0, 0.65, wet);
        Nd = normalize(mix(Nd, N, uWet * puddle));
    }

    // lighting
    float sh = shadowAt(vPos, N) * cloudShadow(vPos);
    float NdL = max(dot(Nd, L), 0.0) * smoothstep(-0.02, 0.1, dot(N, L));
    vec3 skyAmb = mix(uHorizon, uZenith, 0.6) * uAmbient;
    vec3 groundAmb = (uGroundCol * 0.6 + uSunColor * 0.04) * uAmbient + uNight * vec3(0.06, 0.045, 0.03);
    skyAmb += uNight * vec3(0.012, 0.014, 0.022);
    vec3 hemi = mix(groundAmb, skyAmb, Nd.y * 0.5 + 0.5);

    float ao = mix(0.55, 1.0, cavity);
    if (abs(N.y) < 0.5) ao *= mix(0.55, 1.0, smoothstep(0.0, 2.2, vUV.y));
    ao *= mix(0.8, 1.0, smoothstep(0.0, 45.0, vPos.y));
    if (N.y < -0.5) ao *= 0.7;

    vec3 H = normalize(L + V);
    float gloss = mix(12.0, 180.0, clamp(1.0 - rough + wet * puddle * 0.9 + specAmt, 0.0, 1.0));
    float spec = pow(max(dot(Nd, H), 0.0), gloss) * (specAmt + wet * 0.6) * (gloss / 40.0);

    vec3 color = albedo * (uSunColor * NdL * sh + hemi * ao + lampLight(vPos, Nd) * ao);
    color += uSunColor * spec * sh;
    if (glass > 0.5) {
        color = albedo + uSunColor * spec * sh * 2.0;
    }

    // wet reflections of the sky
    if (glass < 0.5 && horizontal > 0.5 && uWet > 0.01) {
        vec3 R = reflect(-V, normalize(N + (tn.x * T + tn.y * B) * 0.05 * (1.0 - puddle)));
        float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 refl = skyBase(R);
        color += refl * fres * uWet * mix(0.25, 1.0, puddle) * ao;
    }
    color += emissive;

    // height-attenuated exponential fog
    float hAvg = max(0.5 * (uCamPos.y + vPos.y), 0.0);
    float fog = 1.0 - exp(-dist * uFogDensity * exp(-hAvg / 220.0));
    color = mix(color, fogColor(-V), fog);
    fragColor = vec4(color, 1.0);
}
"""

RAIN_VS = HEADER + """
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
"""

RAIN_FS = HEADER + """
in float vAlpha;
uniform float uRain;
uniform vec3 uRainColor;
out vec4 fragColor;
void main() {
    fragColor = vec4(uRainColor, vAlpha * uRain * 0.35);
}
"""

POST_VS = HEADER + """
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
    vUV = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}
"""

POST_FS = HEADER + """
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uNoiseTex;
uniform float uExposure;
uniform float uTime;
uniform float uSpeed;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uGrade;
uniform float uBloom;
uniform float uFade;
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
    vec3 col;
    col.r = texture(uScene, uv - c * ca).r;
    col.g = texture(uScene, uv).g;
    col.b = texture(uScene, uv + c * ca).b;

    // speed blur toward the edges
    if (uSpeed > 0.05) {
        vec3 acc = col;
        for (int i = 1; i <= 4; i++) {
            acc += texture(uScene, uv - c * float(i) * 0.012 * uSpeed * r2 * 4.0).rgb;
        }
        col = acc / 5.0;
    }

    vec3 bloom = textureLod(uScene, uv, 3.0).rgb * 0.4
               + textureLod(uScene, uv, 5.0).rgb * 0.35
               + textureLod(uScene, uv, 7.0).rgb * 0.25;
    col += max(bloom - 0.9, 0.0) * uBloom + bloom * 0.03 * uBloom;

    col *= uExposure;
    col = aces(col);
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum), col, uSaturation);
    col *= uGrade;
    col = (col - 0.5) * uContrast + 0.5;
    col = clamp(col, 0.0, 1.0);

    float vig = smoothstep(0.95, 0.25, length(c * vec2(uResolution.x / uResolution.y, 1.0)) * 0.9);
    col *= mix(0.55, 1.0, vig);

    col = pow(col, vec3(1.0 / 2.2));
    vec2 nuv = uv * uResolution / 256.0 + vec2(fract(uTime * 13.7), fract(uTime * 7.3)) * 256.0;
    float grain = texture(uNoiseTex, nuv).a - 0.5;
    col += grain * 0.035;
    col *= uFade;
    fragColor = vec4(col, 1.0);
}
"""

OVERLAY_VS = HEADER + """
layout(location = 0) in vec2 aPos;
uniform vec4 uRect;
out vec2 vUV;
void main() {
    vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
    vec2 p = uRect.xy + (aPos * 0.5 + 0.5) * uRect.zw;
    gl_Position = vec4(p, 0.0, 1.0);
}
"""

OVERLAY_FS = HEADER + """
in vec2 vUV;
uniform sampler2D uTex;
uniform float uAlpha;
out vec4 fragColor;
void main() {
    vec4 t = texture(uTex, vUV);
    fragColor = vec4(t.rgb, t.a * uAlpha);
}
"""
