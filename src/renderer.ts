// Render passes: cloud shadow map, cached sun shadow map, depth pre-pass, city,
// sky (only where nothing was drawn), rain, then HDR post-processing.

import {
  ColorTarget, InstancedMesh, Mesh, Program, SceneTarget, ShadowTarget, bindTexture, fullscreenTriangle, textureArray, texture2D, type GL,
} from "./gl";
import {
  cross, dot, frustumPlanes, mul, normalize, ortho, perspective, perspectiveReversed, scale, sub, viewMatrix, type Vec3,
} from "./math";
import * as S from "./shaders";
import { NOISE_SIZE, TEX_LAYERS, TEX_SIZE, type TextureSet } from "./textures";
import { GpuTimer } from "./timer";
import { boxesMesh, VERTEX_LAYOUT } from "./city/mesh";
import { carBoxes, figureBoxes, flyerBoxes, liftBoxes, modelData } from "./vehicles/models";
import { LIFT_SIZE } from "./city/generate";
import { LIFT_THICK } from "./lifts";
import { INSTANCE_LAYOUT, type InstanceList } from "./vehicles/traffic";
import { PARTICLE_INSTANCE_LAYOUT, type Particles } from "./effects/particles";
import type { Weather } from "./weather";
import type { World } from "./world";

const SHADOW_EXTENT = 180;
const SHADOW_BACK = 700; // how far toward the sun shadow casters are gathered
const SHADOW_MOVE = 12; // re-render the shadow map after moving this far
const CLOUD_SIZE = 256;
const CLOUD_EXTENT = 1200;

interface ClipControl {
  clipControlEXT(origin: number, depth: number): void;
  LOWER_LEFT_EXT: number;
  NEGATIVE_ONE_TO_ONE_EXT: number;
  ZERO_TO_ONE_EXT: number;
}

export interface Camera {
  eye: Vec3;
  fwd: Vec3;
  right: Vec3;
  up: Vec3;
  fov: number; // vertical, radians
  vel: Vec3;
}

export interface VehicleLists {
  cars: InstanceList;
  vans: InstanceList;
  flyers: InstanceList;
  /** People on foot, by pose: standing, left stride, right stride. */
  figures?: InstanceList[];
  lifts?: InstanceList;
}

export interface RenderOptions {
  msaa?: number;
  shadowSize?: number;
  prepass?: boolean;
}

export class Renderer {
  readonly renderer: string;
  readonly integrated: boolean;
  readonly samples: number;
  readonly prepass: boolean;
  readonly timer: GpuTimer;
  private clip: ClipControl | null;
  private sky: Program;
  private city: Program;
  private depthProg: Program;
  private rainProg: Program;
  private post: Program;
  private cloudProg: Program;
  private vehicleProg: Program;
  private vehicleMeshes: { car: InstancedMesh; van: InstancedMesh; flyer: InstancedMesh; figures: InstancedMesh[]; lift: InstancedMesh };
  private particleProg: Program;
  private particleMesh: InstancedMesh;
  private tri: Mesh;
  private rain: Mesh;
  private albedo: WebGLTexture;
  private normal: WebGLTexture;
  private noise: WebGLTexture;
  private scene: SceneTarget | null = null;
  private shadow: ShadowTarget;
  private shadowSize: number;
  private clouds: ColorTarget;
  private lightVP: Float32Array = new Float32Array(16);
  private shadowCenter: Vec3 | null = null;
  private shadowDir: string = "";
  scale = 1;
  maxPixelRatio = 1;
  width = 0;
  height = 0;
  shadowRenders = 0;

  constructor(private gl: GL, tex: TextureSet, opts: RenderOptions = {}) {
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("This browser cannot render to float textures (EXT_color_buffer_float).");
    gl.getExtension("OES_texture_float_linear");
    this.clip = gl.getExtension("EXT_clip_control") as ClipControl | null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    this.renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    this.integrated = /Intel|UHD|Iris|Radeon\(TM\) Graphics|Apple|SwiftShader|llvmpipe|Mali|Adreno/i.test(this.renderer);
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
    // 4x MSAA costs integrated GPUs ~15% of the frame; 2x keeps edges smooth enough
    this.samples = Math.min(opts.msaa ?? (this.integrated ? 2 : 4), maxSamples);
    // The colour pass matches the pre-pass depth with EQUAL, which needs bit-identical depth
    // from both. Apple's Metal-backed WebGL doesn't always give that, and surfaces flicker.
    this.prepass = opts.prepass ?? !/Apple/i.test(this.renderer);
    this.shadowSize = opts.shadowSize ?? (this.integrated ? 2048 : 4096);
    this.timer = new GpuTimer(gl);

    this.sky = new Program(gl, S.SKY_VS, S.SKY_FS);
    this.city = new Program(gl, S.CITY_VS, S.CITY_FS);
    this.depthProg = new Program(gl, S.SHADOW_VS, S.SHADOW_FS);
    this.rainProg = new Program(gl, S.RAIN_VS, S.RAIN_FS);
    this.post = new Program(gl, S.POST_VS, S.POST_FS);
    this.cloudProg = new Program(gl, S.POST_VS, S.CLOUD_FS);
    this.vehicleProg = new Program(gl, S.VEHICLE_VS, S.CITY_FS);
    const instanced = (data: number[]) => {
      const m = boxesMesh(data);
      return new InstancedMesh(gl, m.vertices, VERTEX_LAYOUT, m.indices, INSTANCE_LAYOUT);
    };
    this.particleProg = new Program(gl, S.PARTICLE_VS, S.PARTICLE_FS);
    this.particleMesh = new InstancedMesh(
      gl, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), [2], new Uint32Array([0, 1, 2, 0, 2, 3]), PARTICLE_INSTANCE_LAYOUT,
    );
    this.vehicleMeshes = {
      car: instanced(modelData(carBoxes(false))),
      van: instanced(modelData(carBoxes(true))),
      flyer: instanced(modelData(flyerBoxes())),
      figures: [0, 1, -1].map((stride) => instanced(modelData(figureBoxes(stride)))),
      lift: instanced(modelData(liftBoxes(LIFT_SIZE, LIFT_THICK))),
    };
    this.tri = fullscreenTriangle(gl);

    const drops = 7000;
    const rain = new Float32Array(drops * 2 * 4);
    for (let i = 0; i < drops; i++) {
      const sx = Math.random(), sy = Math.random(), sz = Math.random();
      rain.set([sx, sy, sz, 0, sx, sy, sz, 1], i * 8);
    }
    this.rain = new Mesh(gl, rain, [3, 1], null, gl.LINES);

    this.albedo = textureArray(gl, TEX_SIZE, TEX_LAYERS, tex.albedo, true);
    this.normal = textureArray(gl, TEX_SIZE, TEX_LAYERS, tex.normal, false);
    this.noise = texture2D(gl, NOISE_SIZE, tex.noise);
    this.shadow = new ShadowTarget(gl, this.shadowSize);
    this.clouds = new ColorTarget(gl, CLOUD_SIZE);
  }

  get reversedZ(): boolean {
    return this.clip !== null;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const pr = Math.min(dpr, this.maxPixelRatio);
    canvas.width = Math.round(cssWidth * pr);
    canvas.height = Math.round(cssHeight * pr);
    const w = Math.max(64, Math.round(canvas.width * this.scale));
    const h = Math.max(64, Math.round(canvas.height * this.scale));
    if (this.scene && this.scene.width === w && this.scene.height === h) return;
    this.scene?.dispose();
    this.scene = new SceneTarget(gl, w, h, this.samples);
    this.width = w;
    this.height = h;
  }

  private buildLightMatrix(center: Vec3, L: Vec3): Float32Array {
    const lf = scale(L, -1);
    const upHint: Vec3 = Math.abs(L[1]) < 0.95 ? [0, 1, 0] : [0, 0, 1];
    const lr = normalize(cross(lf, upHint));
    const lu = cross(lr, lf);
    // snap to shadow texels so static shadows don't crawl
    const texel = (2 * SHADOW_EXTENT) / this.shadowSize;
    const cx = Math.floor(dot(center, lr) / texel) * texel;
    const cy = Math.floor(dot(center, lu) / texel) * texel;
    const cz = dot(center, lf);
    const snapped = [0, 1, 2].map((i) => lr[i] * cx + lu[i] * cy + lf[i] * cz) as Vec3;
    const view = viewMatrix(sub(snapped, scale(lf, SHADOW_BACK)), lr, lu, lf);
    const proj = ortho(-SHADOW_EXTENT, SHADOW_EXTENT, -SHADOW_EXTENT, SHADOW_EXTENT, 1, SHADOW_BACK + 500);
    return mul(proj, view);
  }

  /** Re-render the sun shadow map only when the runner or the sun has moved enough. */
  private updateShadows(cam: Camera, lightDir: Vec3, world: World): void {
    const gl = this.gl;
    // quantise the light direction so slow sun motion updates in small steps
    const q = lightDir.map((v) => Math.round(v * 300) / 300) as Vec3;
    const dirKey = q.join(",");
    const center: Vec3 = [cam.eye[0], cam.eye[1] * 0.5, cam.eye[2]];
    const c = this.shadowCenter;
    const moved = !c || Math.hypot(center[0] - c[0], center[2] - c[2]) > SHADOW_MOVE || Math.abs(center[1] - c[1]) > 6;
    if (!moved && dirKey === this.shadowDir) return;
    this.shadowCenter = center;
    this.shadowDir = dirKey;
    this.lightVP = this.buildLightMatrix(center, normalize(q));
    this.shadowRenders++;

    this.clip?.clipControlEXT(this.clip.LOWER_LEFT_EXT, this.clip.NEGATIVE_ONE_TO_ONE_EXT);
    this.shadow.bind();
    gl.colorMask(false, false, false, false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 3);
    this.depthProg.use().mat4("uViewProj", this.lightVP);
    world.draw(frustumPlanes(this.lightVP, true, true), center, 0.4, false);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
  }

  render(cam: Camera, weather: Weather, world: World, vehicles: VehicleLists, particles: Particles, time: number, speed: number, fade: number): void {
    const gl = this.gl;
    const scene = this.scene!;
    const timer = this.timer;
    timer.poll();
    const wu = weather.uniforms();
    const common = { ...wu, uTime: time, uCamPos: cam.eye };
    const aspect = scene.width / scene.height;
    const cloudCenter = [
      Math.round(cam.eye[0] / 32) * 32,
      Math.round(cam.eye[2] / 32) * 32,
    ];

    // --- cloud shadow map (tiny)
    timer.begin("clouds");
    this.clip?.clipControlEXT(this.clip.LOWER_LEFT_EXT, this.clip.NEGATIVE_ONE_TO_ONE_EXT);
    this.clouds.bind();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    bindTexture(gl, 3, this.noise);
    this.cloudProg.use().setAll(common).int("uNoise", 3)
      .vec("uCloudCenter", cloudCenter).float("uCloudExtent", CLOUD_EXTENT);
    this.tri.draw();

    // --- sun shadows (cached)
    timer.begin("shadow");
    this.updateShadows(cam, wu.uLightDir as Vec3, world);

    // --- camera
    const view = viewMatrix(cam.eye, cam.right, cam.up, cam.fwd);
    let proj: Float32Array;
    if (this.clip) {
      this.clip.clipControlEXT(this.clip.LOWER_LEFT_EXT, this.clip.ZERO_TO_ONE_EXT);
      proj = perspectiveReversed(cam.fov, aspect, 0.1);
    } else {
      proj = perspective(cam.fov, aspect, 0.25, 4000);
    }
    const viewProj = mul(proj, view);
    const planes = this.clip ? frustumPlanes(viewProj, false, true) : frustumPlanes(viewProj, true, true);
    const nearer = this.clip ? gl.GREATER : gl.LESS;

    scene.bind();
    gl.depthMask(true);
    gl.clearDepth(this.clip ? 0 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // --- depth pre-pass: afterwards only the visible surface of each pixel gets shaded
    if (this.prepass) {
      timer.begin("prepass");
      gl.colorMask(false, false, false, false);
      gl.depthFunc(nearer);
      this.depthProg.use().mat4("uViewProj", viewProj);
      world.draw(planes, cam.eye, 1, true);
      gl.colorMask(true, true, true, true);
      gl.depthFunc(gl.EQUAL);
      gl.depthMask(false);
    } else {
      gl.depthFunc(nearer);
    }

    timer.begin("city");
    bindTexture(gl, 0, this.albedo, gl.TEXTURE_2D_ARRAY);
    bindTexture(gl, 1, this.normal, gl.TEXTURE_2D_ARRAY);
    bindTexture(gl, 2, this.shadow.depth);
    bindTexture(gl, 3, this.noise);
    bindTexture(gl, 5, this.clouds.tex);
    const surface = (prog: Program) => prog.use().setAll(common)
      .mat4("uViewProj", viewProj).mat4("uLightVP", this.lightVP)
      .float("uShadowTexel", 1 / this.shadowSize)
      .int("uAlbedo", 0).int("uNormal", 1).int("uShadow", 2).int("uNoise", 3)
      .int("uCloudTex", 5).vec("uCloudCenter", cloudCenter).float("uCloudExtent", CLOUD_EXTENT);
    surface(this.city);
    world.draw(planes, cam.eye, 1, true);

    // --- vehicles (dynamic, instanced; not in the cached shadow map)
    timer.begin("vehicles");
    gl.depthMask(true);
    gl.depthFunc(nearer);
    surface(this.vehicleProg);
    this.vehicleMeshes.car.draw(vehicles.cars.data, vehicles.cars.count);
    this.vehicleMeshes.van.draw(vehicles.vans.data, vehicles.vans.count);
    this.vehicleMeshes.flyer.draw(vehicles.flyers.data, vehicles.flyers.count);
    vehicles.figures?.forEach((list, i) => this.vehicleMeshes.figures[i].draw(list.data, list.count));
    if (vehicles.lifts) this.vehicleMeshes.lift.draw(vehicles.lifts.data, vehicles.lifts.count);

    // --- sky, only where no geometry was drawn
    timer.begin("sky");
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.depthFunc(this.clip ? gl.GEQUAL : gl.LEQUAL);
    const tanY = Math.tan(cam.fov / 2);
    this.sky.use().setAll(common).int("uNoise", 3)
      .float("uSkyZ", this.clip ? 0 : 1)
      .vec("uTanHalf", [tanY * aspect, tanY])
      .vec("uCamFwd", cam.fwd).vec("uCamRight", cam.right).vec("uCamUp", cam.up);
    this.tri.draw();

    const rain = weather.params.rain;
    if (rain > 0.01) {
      timer.begin("rain");
      gl.depthFunc(nearer);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const w = weather.params.wind;
      const amb = 0.25 + 0.5 * weather.params.ambient;
      this.rainProg.use()
        .mat4("uViewProj", viewProj).vec("uCamPos", cam.eye).float("uTime", time)
        .vec("uWindVec", [2.5 * w, 1.5 * w]).vec("uCamVel", cam.vel)
        .float("uRain", rain).vec("uRainColor", [0.8 * amb, 0.85 * amb, 0.95 * amb]);
      this.rain.draw();
      gl.disable(gl.BLEND);
    }

    // --- particles: smoke (blended), then fire and sparks (additive)
    const smokeCount = particles.smoke.write(false);
    const glowCount = particles.glow.write(true);
    if (smokeCount + glowCount > 0) {
      timer.begin("particles");
      gl.depthFunc(nearer);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      const sunLight = (wu.uSunColor as number[]).map((c) => c * 0.25);
      const amb = weather.params.ambient;
      const light = [0, 1, 2].map((i) => (weather.params.horizon[i] + weather.params.zenith[i]) * 0.5 * amb + sunLight[i] + 0.02);
      const pp = this.particleProg.use()
        .mat4("uViewProj", viewProj).vec("uCamRight", cam.right).vec("uCamUp", cam.up).vec("uCamPos", cam.eye)
        .float("uFogDensity", weather.params.fogDensity).vec("uSmokeLight", light);
      pp.int("uSmoke", 1);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.particleMesh.draw(particles.smoke.out, smokeCount);
      pp.int("uSmoke", 0);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.particleMesh.draw(particles.glow.out, glowCount);
      gl.disable(gl.BLEND);
    }
    gl.depthMask(true);

    // --- post
    timer.begin("resolve");
    scene.resolve();
    timer.begin("post");
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const canvas = gl.canvas as HTMLCanvasElement;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.DEPTH_TEST);
    bindTexture(gl, 4, scene.color);
    bindTexture(gl, 6, scene.bloom);
    this.post.use().setAll(weather.postUniforms())
      .int("uScene", 4).int("uBloomTex", 6).int("uNoiseTex", 3)
      .float("uTime", time).float("uSpeed", speed).float("uFade", fade)
      .float("uBloomLod", Math.max(0, Math.log2(scene.bloomHeight / 110)))
      .vec("uResolution", [canvas.width, canvas.height]);
    this.tri.draw();
    timer.end();
  }
}
