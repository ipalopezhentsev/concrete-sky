// Concrete Sky: boot, input, main loop and HUD.

import { Audio } from "./audio";
import { spawnPoint } from "./city/generate";
import { Demo } from "./demo";
import { MAX_HEALTH } from "./hunters";
import { add, cross, dot, normalize, scale, setWorldSeed, sub, type Vec3 } from "./math";
import { Player, type Input } from "./player";
import { Renderer, type Camera } from "./renderer";
import { Rides, type Controls } from "./rides";
import { TouchControls } from "./touch";
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
const demoEl = document.getElementById("demo")!;
const watchEl = document.getElementById("watch")!;
const touchEl = document.getElementById("touch")!;
const healthEl = document.getElementById("health")!;
const healthBar = healthEl.firstElementChild as HTMLElement;
const hurtEl = document.getElementById("hurt")!;
const markersEl = document.getElementById("markers")!;
// phones and tablets: the title screen talks about tapping
const coarse = matchMedia("(pointer: coarse)").matches;
const verb = coarse ? "tap" : "click";

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
  /** Test hook: put a hunter (foot, car or flyer) `ahead` metres in front of the player. */
  hunter: (_kind: string, _ahead: number) => false,
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
  if (Number(params.get("geolod")) > 0) world.detailScale = Number(params.get("geolod"));
  if (Number(params.get("farlod")) > 0) world.farScale = Number(params.get("farlod"));
  if (params.get("facecull") === "0") world.faceCull = false;
  statusEl.textContent = "generating textures…";
  const textures = await world.textures();
  let renderer: Renderer;
  try {
    const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined);
    renderer = new Renderer(gl, textures, {
      msaa: num("msaa"),
      shadowSize: num("shadowsize"),
      prepass: params.has("prepass") ? params.get("prepass") !== "0" : undefined,
      fxaa: params.has("fxaa") ? params.get("fxaa") !== "0" : undefined,
      detailDist: num("detail"),
      aniso: num("aniso"),
      cheap: num("cheap"),
      cloudSize: num("cloudsize"),
      cloudDither: num("clouddither"),
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
  beginEl.textContent = `${verb} to run`;
  beginEl.hidden = false;
  watchEl.hidden = false;
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
  debug.hunter = (kind, ahead) => {
    const s = Math.sin(player.yaw), c = Math.cos(player.yaw);
    const p = rides.focus;
    const at: Vec3 = [p[0] + s * ahead, p[1] + (kind === "flyer" ? 6 : 0), p[2] + c * ahead];
    const yaw = player.yaw + Math.PI;
    const h = rides.hunters;
    if (kind === "flyer") h.addFlyer(at, yaw);
    else if (kind === "car") h.addCar(at, yaw);
    else h.addRunner(at, yaw);
    return true;
  };
  if (params.get("vehicle") === "car") rides.spawnCar();
  else if (params.has("vehicle")) rides.spawnFlyer();

  // --- modes: the title screen, playing (mouse or touch), and the demo
  type Mode = "title" | "play" | "demo";
  let mode: Mode = "title";
  let touchPlay = false; // playing with the on-screen controls instead of a locked mouse
  let played = false;
  let idle = 0;
  const demo = new Demo(rides, player, weather);
  // the title screen turns into the demo when left alone (not while testing views)
  const attract = params.get("demo") !== "0" &&
    !["shot", "pose", "autorun", "autofly", "vehicle"].some((k) => params.has(k));

  const keys = new Set<string>();
  let mouseDX = 0, mouseDY = 0;
  let firing = false;
  let notice = "";
  let noticeTime = 0;
  // hunters chase the player unless turned off (H, or ?hunters=0)
  let hunt = params.get("hunters") !== "0" && !["shot", "autorun", "autofly"].some((k) => params.has(k));
  touchEl.toggleAttribute("data-hunt", hunt);
  const setHunt = (on: boolean) => {
    hunt = on;
    touchEl.toggleAttribute("data-hunt", on);
    if (!on) rides.hunters.clear();
    caption(on ? "hunters on" : "hunters off");
  };

  const interact = () => {
    const why = rides.interact();
    if (why) {
      notice = why;
      noticeTime = 2;
    }
  };
  const touch = new TouchControls(touchEl, (action) => {
    if (action === "pause") setMode("title");
    else if (action === "view" && rides.riding) rides.cockpit = !rides.cockpit;
    else if (action === "roof" && !rides.riding) player.respawn();
    else if (action === "weather") weather.next(6);
    else if (action === "hunt") setHunt(!hunt);
  });

  /** Switch mode; `title` false keeps the title screen hidden (a pointer lock is on its way). */
  function setMode(m: Mode, title = true): void {
    if (mode === "demo" && m !== "demo") demo.stop();
    mode = m;
    if (m !== "play") {
      keys.clear();
      firing = false;
    }
    if (title) startEl.classList.toggle("hidden", m !== "title");
    demoEl.hidden = m !== "demo";
    touch.show(m === "play" && touchPlay);
    document.body.classList.toggle("touchplay", m === "play" && touchPlay);
    if (m === "play") {
      played = true;
      beginEl.textContent = `${verb} to continue`;
    }
    if (m === "title") audio.stop();
    idle = 0;
  }

  function play(withTouch: boolean): void {
    audio.start();
    touchPlay = withTouch;
    if (withTouch) {
      if (document.pointerLockElement) document.exitPointerLock();
      document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
      setMode("play");
    } else {
      // resolves with pointerlockchange; older browsers return nothing
      (canvas.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {});
    }
  }

  function startDemo(): void {
    rides.hunters.clear();
    setMode("demo");
    demo.start();
  }

  /** Any input during the demo takes over from wherever it is. */
  function takeOver(withTouch: boolean): void {
    setMode("title", false);
    play(withTouch);
  }

  // F4 copies the stats panel (and the URL, which carries any test parameters)
  let statsText = "";
  const copyStats = () => {
    navigator.clipboard.writeText(`${location.href}\n${statsText}`).then(
      () => caption("stats copied"),
      () => caption("could not copy stats"),
    );
  };

  window.addEventListener("keydown", (e) => {
    idle = 0;
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    if (e.code === "F3") {
      statsEl.hidden = !statsEl.hidden;
      e.preventDefault();
    }
    if (e.code === "F4") {
      e.preventDefault();
      if (!e.repeat) copyStats();
    }
    if (mode === "demo" && !e.repeat && e.code !== "F3" && e.code !== "F4") {
      if (e.code === "Escape") setMode("title");
      else takeOver(false);
    }
    keys.add(e.code);
    if (e.repeat) return;
    if (e.code === "KeyN") weather.next(6);
    if (e.code === "KeyL") {
      weather.cycle = !weather.cycle;
      caption(weather.cycle ? "weather drifting" : "weather held");
    }
    if (e.code === "KeyH" && mode !== "demo") setHunt(!hunt);
    if (mode !== "play") return;
    if (e.code === "KeyR" && !rides.riding) player.respawn();
    if (e.code === "KeyE") interact();
    if (e.code === "KeyV" && rides.riding) rides.cockpit = !rides.cockpit;
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => {
    keys.clear();
    firing = false;
    touch.reset();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && mode === "play" && touchPlay) setMode("title");
  });
  window.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement === canvas) {
      mouseDX += e.movementX;
      mouseDY += e.movementY;
    } else idle = 0;
  });
  window.addEventListener("mousedown", (e) => {
    if (e.button === 0 && document.pointerLockElement === canvas) firing = true;
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) firing = false;
  });
  window.addEventListener("pointerdown", (e) => {
    idle = 0;
    if (mode !== "demo") return;
    e.preventDefault();
    takeOver(e.pointerType === "touch");
  });
  // a tap on the prompt is the E key
  promptEl.addEventListener("pointerdown", (e) => {
    if (mode !== "play" || !touchPlay) return;
    e.stopPropagation();
    interact();
  });
  let startPointer = "mouse";
  startEl.addEventListener("pointerdown", (e) => {
    startPointer = e.pointerType;
  });
  startEl.addEventListener("click", () => play(startPointer === "touch"));
  watchEl.addEventListener("click", (e) => {
    e.stopPropagation();
    audio.start();
    startDemo();
  });
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement === canvas) {
      touchPlay = false;
      setMode("play");
    } else if (mode === "play" && !touchPlay) setMode("title");
  });
  document.addEventListener("pointerlockerror", () => {
    if (mode !== "play") setMode("title");
  });
  if (params.has("demo") && attract) startDemo();

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
  let shownScore = "";
  let shownHits = 0;
  const markers: HTMLElement[] = [];

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    time += dt;
    rides.lifts.update(time);

    const down = (...codes: string[]) => codes.some((c) => keys.has(c));
    // a light push on the stick walks, a full one sprints (it's the throttle in a car)
    const stick = touch.stick;
    const controls: Controls = {
      moveX: (down("KeyD", "ArrowRight") ? 1 : 0) - (down("KeyA", "ArrowLeft") ? 1 : 0) || touch.moveX,
      moveZ: (down("KeyW", "ArrowUp") ? 1 : 0) - (down("KeyS", "ArrowDown") ? 1 : 0) || touch.moveZ,
      up: down("Space") || touch.held.has("jump"),
      down: down("ControlLeft", "ControlRight", "KeyC") || touch.held.has("down") ||
        (!rides.riding && stick > 0 && stick < 0.45),
      sprint: down("ShiftLeft", "ShiftRight") || stick > 0.92,
      fire: firing || down("KeyF") || touch.held.has("fire"),
      mouseDX: mouseDX + touch.lookDX,
      mouseDY: mouseDY + touch.lookDY,
    };
    touch.lookDX = touch.lookDY = 0;
    if (mode === "demo") demo.update(dt, controls, rides.traffic);
    else if (mode === "title" && attract && !played && (idle += dt) > 45) startDemo();
    const running = mode === "play";
    const active = running || mode === "demo" || autorun > 0 || autofly;
    if (rides.riding && active) {
      if (autofly) {
        controls.moveZ = 1;
        controls.sprint = true;
        controls.fire = Math.sin(time * 2) > 0.3;
        player.yaw += dt * 0.12 * Math.sin(time * 0.3);
      }
      rides.drive(dt, controls);
    } else if (active) {
      player.look(controls.mouseDX, controls.mouseDY);
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
      rides.lifts.carry(player);
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

    // vehicles, hunters, weapons, effects
    rides.hunters.active = running && hunt;
    rides.update(dt, time, { eye, fwd, roll, fov: fovDeg }, active && controls.fire);
    const hunters = rides.hunters;
    if (hunters.gotYou) {
      caption("caught");
      fade = 0.15;
    }
    rides.collectInstances(eye);
    const events = rides.combat.takeEvents();
    for (let i = 0; i < events.shots; i++) audio.zap();
    for (const p of events.hostile) {
      audio.zap(Math.min(1, 30 / (Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) + 10)), 0.55);
    }
    if (hunters.hits !== shownHits) {
      shownHits = hunters.hits;
      audio.hurt();
    }
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
    const promptNow = !running ? "" : noticeTime > 0 ? notice : rides.promptText();
    // touch players tap the prompt itself, so drop the key name
    prompt(touchPlay ? promptNow.replace(/^E\s+/, "") : promptNow);
    if (running && touchPlay) touch.setMode(rides.flyer ? "flyer" : rides.car ? "car" : "foot");
    const armed = rides.flyer !== null || (!rides.riding && hunt);
    crosshairEl.classList.toggle("show", running && armed && !params.has("shot"));
    scoreEl.hidden = mode === "demo";
    const parts = [];
    if (hunters.kills) parts.push(`hunters down  ${hunters.kills}`);
    if (hunters.caught) parts.push(`caught  ${hunters.caught}`);
    if (rides.combat.kills) parts.push(`flyers downed  ${rides.combat.kills}`);
    if (rides.combat.carKills) parts.push(`cars wrecked  ${rides.combat.carKills}`);
    const score = parts.join("   ·   ");
    if (score !== shownScore) scoreEl.textContent = shownScore = score;
    const hunted = running && hunt && params.get("hud") !== "0";
    healthEl.hidden = !hunted;
    healthBar.style.transform = `scaleX(${hunters.health / MAX_HEALTH})`;
    healthEl.classList.toggle("low", hunters.health < MAX_HEALTH * 0.35);
    hurtEl.style.opacity = hunted ? String(hunters.hurt) : "0";

    // where the hunters are: a mark over those in view, arrows at the edge for the rest
    let shown = 0;
    if (hunted) {
      const w = window.innerWidth, h = window.innerHeight;
      const tanY = Math.tan(cam.fov / 2), tanX = tanY * (w / h);
      for (const hunter of hunters.list) {
        const to = sub(hunter.center, eye);
        const dist = Math.hypot(...to);
        if (hunter.dead || dist > 300) continue;
        const cx = dot(to, right), cy = dot(to, up), cz = dot(to, fwd);
        const el = markers[shown] ?? markersEl.appendChild(document.createElement("b"));
        markers[shown++] = el;
        el.hidden = false;
        const sx = cx / (cz * tanX), sy = (cy + 1.4) / (cz * tanY);
        if (cz > 0 && Math.abs(sx) < 0.95 && Math.abs(sy) < 0.9) {
          el.hidden = dist < 25;
          el.className = "here";
          el.style.transform = `translate(${(0.5 + 0.5 * sx) * w}px, ${(0.5 - 0.5 * sy) * h}px) rotate(180deg)`;
        } else {
          const len = Math.hypot(cx, cy);
          const [ux, uy] = len > 1e-3 ? [cx / len, cy / len] : [0, -1];
          const k = 1 / Math.hypot(ux / (w * 0.45), uy / (h * 0.42));
          el.className = "";
          el.style.transform = `translate(${w / 2 + ux * k}px, ${h / 2 - uy * k}px) rotate(${Math.atan2(ux, uy)}rad)`;
        }
      }
    }
    for (let i = shown; i < markers.length; i++) markers[i].hidden = true;

    fade = Math.min(1, fade + dt * 0.5);
    const blur = Math.max(0, Math.min(1, (speedNorm - 0.6) * 2.5));
    const shade = mode === "demo" ? Math.min(fade, demo.fade) : fade;
    renderer.render(cam, weather, world, rides.vehicleLists, rides.particles, time, blur, shade);
    debug.frames++;

    // Adaptive resolution, aimed at the display's frame budget: drop the internal
    // scale while frames run long and give it back once there is room to spare.
    // Both directions need a full second of agreement, so the scale cannot oscillate.
    frameAvg += (dt * 1000 - frameAvg) * 0.05;
    if (!scaleParam && time > 4) {
      const budget = 16.7; // one 60 Hz frame
      // Frame time only shows trouble: once vsync locks it at the budget it says nothing
      // about the headroom left. GPU pass timings do, so they decide when to go back up.
      const gpuMs = renderer.timer.total;
      const busy = gpuMs > 0 ? gpuMs > budget * 0.95 : frameAvg > budget * 1.06;
      const idleEnough = gpuMs > 0 ? gpuMs < budget * 0.72 : frameAvg < budget * 0.82;
      if ((busy || frameAvg > budget * 1.06) && renderer.scale > 0.5) slowFrames++;
      else if (idleEnough && frameAvg < budget * 1.06 && renderer.scale < 1) slowFrames--;
      else slowFrames = 0;
      if (Math.abs(slowFrames) > 60) {
        renderer.scale = Math.min(1, Math.max(0.5, renderer.scale - Math.sign(slowFrames) * 0.1));
        resize();
        slowFrames = 0;
        frameAvg = budget;
      }
    }

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
        hunters: hunters.list.map((x) => x.mode).join(","), health: hunters.health, hunterKills: hunters.kills, caught: hunters.caught,
        mode, demo: demo.kind, touch: touchPlay,
      };
      {
        statsText = [
          `${fps.toFixed(0)} fps  ${renderer.width}x${renderer.height} x${renderer.samples} msaa${renderer.fxaa ? " + fxaa" : ""}  worst ${worstShown.toFixed(1)} ms`,
          renderer.renderer,
          `reversed z: ${renderer.reversedZ}   depth pre-pass: ${renderer.prepass}`,
          `regions ${world.stats.regions} (drawn ${world.stats.drawn}, pending ${world.stats.pending}, ${(world.stats.tris / 1000).toFixed(0)}k tris)`,
          `pos ${player.pos.map((v) => v.toFixed(1)).join(" ")}`,
          `weather: ${weather.name}   city seed ${seed}`,
          `vehicles: ${t.cars.count} cars, ${t.vans.count} vans, ${t.flyers.count} flyers (${renderer.vehiclesDrawn} in view)`,
          `hunters: ${hunt ? hunters.list.map((x) => x.mode).join(" ") || "none yet" : "off"} (up to ${hunters.pressure})`,
          `gpu ms: ${renderer.timer.summary()}  = ${renderer.timer.total.toFixed(2)} total`,
        ].join("\n");
        if (!statsEl.hidden) statsEl.textContent = statsText;
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
