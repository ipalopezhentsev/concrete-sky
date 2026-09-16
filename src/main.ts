// Concrete Sky: boot, input, main loop and HUD.

import { Audio } from "./audio";
import { spawnPoint } from "./city/generate";
import { add, cross, normalize, scale, setWorldSeed, type Vec3 } from "./math";
import { Player, type Input } from "./player";
import { Renderer, type Camera } from "./renderer";
import { Rides, type Controls } from "./rides";
import { STATES, Weather } from "./weather";
import { World } from "./world";

const params = new URLSearchParams(location.search);
const canvas = document.getElementById("view") as HTMLCanvasElement;
const startEl = document.getElementById("start")!;
const statusEl = document.getElementById("status")!;
const beginEl = document.getElementById("begin")!;
const captionEl = document.getElementById("caption")!;
const statsEl = document.getElementById("stats")!;
const promptEl = document.getElementById("prompt")!;
const crosshairEl = document.getElementById("crosshair")!;
const scoreEl = document.getElementById("score")!;

let promptText = "";
function prompt(text: string): void {
  if (text === promptText) return;
  promptText = text;
  promptEl.textContent = text;
  promptEl.classList.toggle("show", text !== "");
}

// Test / debug hooks (used by automated screenshots).
const debug = {
  ready: false,
  frames: 0,
  error: "",
  renderer: "",
  stats: {} as Record<string, unknown>,
  /** Test hook: stand next to the nearest parked car. */
  toCar: () => false,
};
(window as unknown as { __cs: typeof debug }).__cs = debug;

function fail(msg: string): never {
  debug.error = msg;
  statusEl.textContent = msg;
  statusEl.style.color = "#e88";
  throw new Error(msg);
}

let captionTimer = 0;
function caption(text: string): void {
  if (params.get("hud") === "0") return;
  captionEl.textContent = `— ${text} —`;
  captionEl.classList.add("show");
  clearTimeout(captionTimer);
  captionTimer = window.setTimeout(() => captionEl.classList.remove("show"), 4500);
}

async function main(): Promise<void> {
  const gl = canvas.getContext("webgl2", {
    powerPreference: "high-performance",
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: params.has("shot"),
  });
  if (!gl) fail("WebGL2 is not available in this browser.");

  // a new city every visit, unless ?seed= asks for a particular one
  const seed = Number(params.get("seed")) || 1 + Math.floor(Math.random() * 999999);
  setWorldSeed(seed);
  const seedEl = document.getElementById("seed")!;
  seedEl.textContent = `city no. ${seed}`;
  seedEl.title = `add ?seed=${seed} to the address to come back to this city`;
  const world = new World(gl, seed);
  statusEl.textContent = "generating textures…";
  const textures = await world.textures();
  let renderer: Renderer;
  try {
    const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined);
    renderer = new Renderer(gl, textures, {
      msaa: num("msaa"),
      shadowSize: num("shadowsize"),
      prepass: params.has("prepass") ? params.get("prepass") !== "0" : undefined,
    });
  } catch (e) {
    fail(String((e as Error).message));
  }
  debug.renderer = renderer.renderer;
  if (renderer.integrated) {
    // A page can only ask for the fast GPU; the browser decides for all its tabs.
    const gpu = document.getElementById("gpu")!;
    const name = renderer.renderer.replace(/^ANGLE \([^,]+, (.+?)(?: \(0x[0-9a-fA-F]+\))?(?:,| Direct3D).*$/, "$1").trim();
    gpu.textContent = `running on ${name}. If you have a discrete graphics card, set your browser to ` +
      `"High performance" in the system graphics settings and reload.`;
    gpu.hidden = false;
  }
  const scaleParam = Number(params.get("scale"));
  if (scaleParam > 0) renderer.scale = scaleParam;
  // render at CSS-pixel resolution by default: 4x fewer pixels on high-DPI screens
  renderer.maxPixelRatio = Number(params.get("dpr")) || 1;
  const resize = () => renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  resize();
  window.addEventListener("resize", resize);

  const spawn = spawnPoint();
  const player = new Player(spawn.x, spawn.y, spawn.z, spawn.yaw);
  const pose = params.get("pose")?.split(",").map(Number);
  if (pose && pose.length >= 5) {
    player.pos = [pose[0], pose[1], pose[2]];
    player.yaw = pose[3];
    player.pitch = pose[4];
  }
  const startWeather = params.get("weather") ?? "clear sky";
  const weather = new Weather(STATES[startWeather] ? startWeather : "clear sky");
  if (params.has("shot")) weather.cycle = false;
  const audio = new Audio();

  statusEl.textContent = "pouring concrete…";
  await world.ready(player.pos[0], player.pos[2], params.has("shot") ? 950 : 450, (f) => {
    statusEl.textContent = `pouring concrete… ${Math.round(f * 100)}%`;
  });
  statusEl.hidden = true;
  beginEl.hidden = false;
  if (params.has("shot")) startEl.classList.add("hidden");
  debug.ready = true;

  const rides = new Rides(world, player);
  rides.sync();
  debug.toCar = () => {
    let best: { x: number; z: number; yaw: number } | null = null;
    let bestD = Infinity;
    for (const p of rides.parking.all()) {
      if (p.kind === "flyer") continue;
      const d = Math.hypot(p.x - player.pos[0], p.z - player.pos[2]);
      if (d < bestD) [bestD, best] = [d, p];
    }
    if (!best) return false;
    // stand on the pavement side, clear of the car's footprint
    const side = best.z > Math.round(best.z / 88) * 88 ? 1 : -1;
    player.pos = [best.x, 0.18, best.z + side * 2.3];
    player.yaw = Math.PI;
    return true;
  };
  if (params.get("vehicle") === "car") rides.spawnCar();
  else if (params.has("vehicle")) rides.spawnFlyer();

  // --- input
  const keys = new Set<string>();
  let mouseDX = 0, mouseDY = 0;
  let firing = false;
  let running = false;
  let notice = "";
  let noticeTime = 0;
  window.addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    if (e.repeat) return;
    if (e.code === "KeyN") weather.next(6);
    if (e.code === "KeyL") {
      weather.cycle = !weather.cycle;
      caption(weather.cycle ? "weather drifting" : "weather held");
    }
    if (e.code === "KeyR" && running && !rides.riding) player.respawn();
    if (e.code === "KeyE" && running) {
      const why = rides.interact();
      if (why) {
        notice = why;
        noticeTime = 2;
      }
    }
    if (e.code === "KeyV" && rides.riding) rides.cockpit = !rides.cockpit;
    if (e.code === "F3") {
      statsEl.hidden = !statsEl.hidden;
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => {
    keys.clear();
    firing = false;
  });
  window.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement === canvas) {
      mouseDX += e.movementX;
      mouseDY += e.movementY;
    }
  });
  window.addEventListener("mousedown", (e) => {
    if (e.button === 0 && document.pointerLockElement === canvas) firing = true;
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) firing = false;
  });
  startEl.addEventListener("click", () => {
    audio.start();
    void canvas.requestPointerLock?.();
  });
  document.addEventListener("pointerlockchange", () => {
    running = document.pointerLockElement === canvas;
    startEl.classList.toggle("hidden", running);
    beginEl.textContent = "click to continue";
    if (!running) {
      keys.clear();
      firing = false;
      audio.stop();
    }
  });

  // --- loop
  const autorun = Number(params.get("autorun")) || 0;
  const autofly = params.has("autofly");
  let last = performance.now();
  let time = 0;
  let fade = params.has("shot") ? 1 : 0;
  let frameAvg = 16;
  let slowFrames = 0;
  let fpsTime = 0, fpsFrames = 0, fps = 0, worst = 0, worstShown = 0;
  let prevEye = player.eye();
  let shownKills = -1;

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    time += dt;

    const down = (...codes: string[]) => codes.some((c) => keys.has(c));
    const controls: Controls = {
      moveX: (down("KeyD", "ArrowRight") ? 1 : 0) - (down("KeyA", "ArrowLeft") ? 1 : 0),
      moveZ: (down("KeyW", "ArrowUp") ? 1 : 0) - (down("KeyS", "ArrowDown") ? 1 : 0),
      up: down("Space"),
      down: down("ControlLeft", "ControlRight", "KeyC"),
      sprint: down("ShiftLeft", "ShiftRight"),
      fire: firing || down("KeyF"),
      mouseDX, mouseDY,
    };
    const active = running || autorun > 0 || autofly;
    if (rides.riding && active) {
      if (autofly) {
        controls.moveZ = 1;
        controls.sprint = true;
        controls.fire = Math.sin(time * 2) > 0.3;
        player.yaw += dt * 0.12 * Math.sin(time * 0.3);
      }
      rides.drive(dt, controls);
    } else if (active) {
      player.look(mouseDX, mouseDY);
      const input: Input = {
        moveX: controls.moveX, moveZ: controls.moveZ, sprint: controls.sprint, walk: controls.down, jump: controls.up,
      };
      if (autorun) {
        input.moveZ = 1;
        input.sprint = true;
        input.jump = Math.sin(time * 1.3) > 0.95;
        player.yaw += dt * 0.15 * Math.sin(time * 0.4);
      }
      player.update(dt, input, rides.colliders);
      if (player.footstep) audio.step(player.speedNorm, weather.wet);
      if (player.landed > 0.2) audio.landing(player.landed);
    }
    mouseDX = mouseDY = 0;

    weather.update(params.has("shot") ? 0 : dt);
    if (weather.changed) {
      if (time > 1) caption(weather.changed);
      weather.changed = null;
    }
    const focus = rides.focus;
    world.update(focus[0], focus[2]);
    rides.sync();

    // camera
    const fwd = player.forward();
    const rideCam = rides.camera(fwd);
    const eye = rideCam?.eye ?? player.eye();
    const roll = rideCam?.roll ?? player.viewRoll();
    let right = normalize(cross(fwd, [0, 1, 0]));
    let up = cross(right, fwd);
    [right, up] = [
      add(scale(right, Math.cos(roll)), scale(up, Math.sin(roll))),
      add(scale(up, Math.cos(roll)), scale(right, -Math.sin(roll))),
    ];
    const vel: Vec3 = [0, 1, 2].map((i) => (eye[i] - prevEye[i]) / Math.max(dt, 1e-4)) as Vec3;
    prevEye = eye;
    const fovDeg = rideCam?.fov ?? player.fov;
    const cam: Camera = { eye, fwd, right, up, fov: (fovDeg * Math.PI) / 180, vel };

    // vehicles, weapons, effects
    rides.update(dt, time, { eye, fwd, roll, fov: fovDeg }, active && controls.fire);
    rides.collectInstances(eye);
    const events = rides.combat.takeEvents();
    for (let i = 0; i < events.shots; i++) audio.zap();
    for (const p of [...events.hits, ...events.explosions]) {
      audio.boom(Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]), events.hits.includes(p) ? 0.6 : 1);
    }
    if (rides.car && rides.car.impact > 4) audio.landing(Math.min(1, rides.car.impact / 25));

    // sound
    const speedNorm = rides.speedNorm;
    audio.update(dt, weather.params, speedNorm, focus[1]);
    if (rides.flyer) audio.engine(1, 74, rides.flyer.speedNorm, rides.flyer.vel[1] * 0.03);
    else if (rides.car) audio.engine(1, 38, rides.car.speedNorm, Math.abs(controls.moveZ) * 0.2);
    else audio.engine(0, 74, 0, 0);

    // HUD
    noticeTime -= dt;
    if (!running) prompt("");
    else if (noticeTime > 0) prompt(notice);
    else prompt(rides.promptText());
    crosshairEl.classList.toggle("show", running && rides.flyer !== null && !params.has("shot"));
    const score = rides.combat.kills * 1000 + rides.combat.carKills;
    if (score !== shownKills) {
      shownKills = score;
      const parts = [];
      if (rides.combat.kills) parts.push(`flyers downed  ${rides.combat.kills}`);
      if (rides.combat.carKills) parts.push(`cars wrecked  ${rides.combat.carKills}`);
      scoreEl.textContent = parts.join("   ·   ");
    }

    fade = Math.min(1, fade + dt * 0.5);
    const blur = Math.max(0, Math.min(1, (speedNorm - 0.6) * 2.5));
    renderer.render(cam, weather, world, rides.traffic, rides.particles, time, blur, fade);
    debug.frames++;

    // adaptive resolution: drop the internal scale if frames stay slow
    frameAvg += (dt * 1000 - frameAvg) * 0.05;
    if (!scaleParam && time > 4 && frameAvg > 21 && renderer.scale > 0.55) {
      if (++slowFrames > 60) {
        renderer.scale = Math.max(0.5, renderer.scale - 0.15);
        resize();
        slowFrames = 0;
        frameAvg = 16;
      }
    } else slowFrames = 0;

    fpsTime += dt;
    fpsFrames++;
    worst = Math.max(worst, dt);
    if (fpsTime > 0.5) {
      fps = fpsFrames / fpsTime;
      fpsTime = fpsFrames = 0;
      worstShown = worst * 1000;
      worst = 0;
      const t = rides.traffic;
      debug.stats = {
        fps, ...world.stats, scale: renderer.scale, pos: player.pos, fov: player.fov,
        size: `${renderer.width}x${renderer.height}`, gpu: renderer.timer.summary(), cpuMs: frameAvg,
        shadowRenders: renderer.shadowRenders, worstMs: worstShown,
        riding: rides.flyer ? "flyer" : rides.car ? "car" : "", flying: !!rides.flyer,
        flyerGrounded: rides.flyer?.grounded, carSpeed: rides.car?.speed,
        vehicles: t.cars.count + t.vans.count + t.flyers.count, kills: rides.combat.kills, carKills: rides.combat.carKills, seed,
        particles: rides.particles.glow.count + rides.particles.smoke.count,
      };
      if (!statsEl.hidden) {
        statsEl.textContent = [
          `${fps.toFixed(0)} fps  ${renderer.width}x${renderer.height} x${renderer.samples} msaa  worst ${worstShown.toFixed(1)} ms`,
          renderer.renderer,
          `reversed z: ${renderer.reversedZ}`,
          `regions ${world.stats.regions} (drawn ${world.stats.drawn}, pending ${world.stats.pending})`,
          `pos ${player.pos.map((v) => v.toFixed(1)).join(" ")}`,
          `weather: ${weather.name}   city seed ${seed}`,
          `vehicles: ${t.cars.count} cars, ${t.vans.count} vans, ${t.flyers.count} flyers`,
          `gpu ms: ${renderer.timer.summary()}`,
        ].join("\n");
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error(e);
  debug.error = String(e);
});
