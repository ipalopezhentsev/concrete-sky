// First-person runner: movement, box collision, ledge climbing and camera feel.

import type { Vec3 } from "./math";

const RADIUS = 0.35;
const HEIGHT = 1.8;
const EYE = 1.68;
const STEP = 0.55;
const RUN_SPEED = 7.5;
const SPRINT_SPEED = 13.5;
const WALK_SPEED = 3.2;
const JUMP_SPEED = 6.4;
const GRAVITY = 19;
const MANTLE_REACH = 2.3; // how far above the feet a ledge can be grabbed
const MANTLE_SPEED = 7;

/** Lowest bottom of a non-steppable box above `y` overlapping the player's column. */
function ceilingAbove(boxes: Float32Array, x: number, z: number, y: number): number {
  let c = Infinity;
  for (let i = 0; i < boxes.length; i += 6)
    if (boxes[i] < x + RADIUS && boxes[i + 3] > x - RADIUS && boxes[i + 2] < z + RADIUS && boxes[i + 5] > z - RADIUS &&
        boxes[i + 1] > y + STEP && boxes[i + 1] < c) c = boxes[i + 1];
  return c;
}

export type Colliders = (x: number, z: number) => Float32Array;

export interface Input {
  moveX: number; // strafe, +1 = right
  moveZ: number; // forward
  sprint: boolean;
  walk: boolean;
  jump: boolean;
}

export class Player {
  pos: Vec3;
  vel: Vec3 = [0, 0, 0];
  yaw: number;
  pitch = 0;
  grounded = false;
  fov = 78;
  roll = 0;
  footstep = false;
  landed = 0;
  mantled = false;
  speedNorm = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private eyeOffset = 0;
  private eyeVel = 0;
  private yawRate = 0;
  private mantle: { target: number; dir: [number, number] } | null = null;
  private ledge: { top: number; dir: [number, number] } | null = null;
  private safe: Vec3;
  private safeTimer = 0;
  private fallStart = 0;

  constructor(x: number, y: number, z: number, yaw = 0) {
    this.pos = [x, y, z];
    this.yaw = yaw;
    this.safe = [x, y, z];
  }

  look(dx: number, dy: number, sensitivity = 0.0022): void {
    this.yaw -= dx * sensitivity;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * sensitivity));
    this.yawRate += dx * sensitivity;
  }

  forward(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp];
  }

  /** Teleport back to the last spot where the runner stood on a roof or deck. */
  respawn(): void {
    this.pos = [...this.safe];
    this.vel = [0, 0, 0];
    this.mantle = null;
    this.eyeOffset = -0.6;
  }

  update(dt: number, input: Input, colliders: Colliders): void {
    this.footstep = false;
    this.landed = 0;
    this.mantled = false;
    const fwd: [number, number] = [Math.sin(this.yaw), Math.cos(this.yaw)];
    const right: [number, number] = [-fwd[1], fwd[0]];
    let wx = fwd[0] * input.moveZ + right[0] * input.moveX;
    let wz = fwd[1] * input.moveZ + right[1] * input.moveX;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-6) {
      wx /= wl;
      wz /= wl;
    }
    const target = input.walk ? WALK_SPEED : input.sprint ? SPRINT_SPEED : RUN_SPEED;
    let accel = this.grounded ? 10 : 2.5;
    if (wl < 1e-6 && this.grounded) accel = 12;
    const k = 1 - Math.exp(-accel * dt);
    this.vel[0] += (wx * target - this.vel[0]) * k;
    this.vel[2] += (wz * target - this.vel[2]) * k;

    const boxes = colliders(this.pos[0], this.pos[2]);

    if (this.mantle) {
      // pull up over the ledge, then carry on forward
      this.pos[1] += MANTLE_SPEED * dt;
      this.vel[1] = 0;
      if (this.pos[1] >= this.mantle.target) {
        this.pos[1] = this.mantle.target;
        this.vel[0] = this.mantle.dir[0] * Math.max(RUN_SPEED * 0.6, Math.hypot(this.vel[0], this.vel[2]));
        this.vel[2] = this.mantle.dir[1] * Math.max(RUN_SPEED * 0.6, Math.hypot(this.vel[0], this.vel[2]));
        this.pos[0] += this.mantle.dir[0] * 0.3;
        this.pos[2] += this.mantle.dir[1] * 0.3;
        this.mantle = null;
        this.eyeVel -= 1.2;
      }
    } else {
      if (input.jump && this.grounded) {
        this.vel[1] = JUMP_SPEED;
        this.grounded = false;
      }
      this.vel[1] -= GRAVITY * dt;
      this.ledge = null;
      const px = this.pos[0], pz = this.pos[2];
      this.moveAxis(0, this.vel[0] * dt, boxes);
      this.moveAxis(2, this.vel[2] * dt, boxes);
      if (!this.moveVertical(dt, boxes)) {
        // stepping up would put our head inside something: undo the move
        this.pos[0] = px;
        this.pos[2] = pz;
        this.vel[0] = this.vel[2] = 0;
      }
      this.tryMantle(input, wl > 1e-6 ? [wx, wz] : null, boxes);
    }

    // remember safe footing above the street
    if (this.grounded && this.pos[1] > 3) {
      this.safeTimer += dt;
      if (this.safeTimer > 0.4) this.safe = [...this.pos];
    } else this.safeTimer = 0;

    this.updateCamera(dt, right);
  }

  private tryMantle(input: Input, wish: [number, number] | null, boxes: Float32Array): void {
    if (!this.ledge || !wish) return;
    if (this.grounded && !input.jump) return;
    const { top, dir } = this.ledge;
    if (dir[0] * wish[0] + dir[1] * wish[1] < 0.3) return;
    const rise = top - this.pos[1];
    if (rise <= STEP || rise > MANTLE_REACH) return;
    // need head room on top of the ledge
    const px = this.pos[0] + dir[0] * (RADIUS + 0.35);
    const pz = this.pos[2] + dir[1] * (RADIUS + 0.35);
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < px + RADIUS && boxes[i + 3] > px - RADIUS &&
          boxes[i + 2] < pz + RADIUS && boxes[i + 5] > pz - RADIUS &&
          boxes[i + 4] > top + 0.01 && boxes[i + 1] < top + HEIGHT) return;
    }
    this.mantle = { target: top, dir };
    this.mantled = true;
    this.grounded = false;
  }

  private moveAxis(axis: 0 | 2, delta: number, boxes: Float32Array): void {
    if (delta === 0) return;
    this.pos[axis] += delta;
    const [x, feet, z] = this.pos;
    const head = feet + HEIGHT;
    let limit = delta > 0 ? Infinity : -Infinity;
    let ledgeTop = -Infinity;
    let hit = false;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < x + RADIUS && boxes[i + 3] > x - RADIUS &&
          boxes[i + 2] < z + RADIUS && boxes[i + 5] > z - RADIUS &&
          boxes[i + 4] > feet + STEP && boxes[i + 1] < head) {
        hit = true;
        if (delta > 0) limit = Math.min(limit, boxes[i + axis]);
        else limit = Math.max(limit, boxes[i + axis + 3]);
        if (boxes[i + 1] <= feet + STEP + 0.05) ledgeTop = Math.max(ledgeTop, boxes[i + 4]);
        else ledgeTop = Infinity; // an overhang or wall starting above us: not climbable
      }
    }
    if (!hit) return;
    this.pos[axis] = delta > 0 ? limit - RADIUS - 1e-4 : limit + RADIUS + 1e-4;
    this.vel[axis] = 0;
    if (Number.isFinite(ledgeTop)) {
      const s = Math.sign(delta);
      this.ledge = { top: ledgeTop, dir: axis === 0 ? [s, 0] : [0, s] };
    }
  }

  /** Returns false if a step-up was refused for lack of head room. */
  private moveVertical(dt: number, boxes: Float32Array): boolean {
    const [x, oldFeet, z] = this.pos;
    let newFeet = oldFeet + this.vel[1] * dt;
    let ground = 0;
    let ceiling = Infinity;
    for (let i = 0; i < boxes.length; i += 6) {
      if (!(boxes[i] < x + RADIUS && boxes[i + 3] > x - RADIUS &&
            boxes[i + 2] < z + RADIUS && boxes[i + 5] > z - RADIUS)) continue;
      if (boxes[i + 4] <= oldFeet + STEP + 1e-3) ground = Math.max(ground, boxes[i + 4]);
      else if (boxes[i + 1] >= oldFeet + HEIGHT - 1e-3) ceiling = Math.min(ceiling, boxes[i + 1]);
    }
    if (this.vel[1] > 0 && newFeet + HEIGHT > ceiling) {
      newFeet = ceiling - HEIGHT;
      this.vel[1] = 0;
    }
    const was = this.grounded;
    if (ground > oldFeet + 1e-3 && ground + HEIGHT > ceilingAbove(boxes, x, z, ground)) return false;
    if (newFeet <= ground) {
      if (ground > oldFeet + 1e-3 && was) this.eyeOffset -= ground - oldFeet;
      if (!was && this.vel[1] < -2) {
        const fall = this.fallStart - ground;
        const impact = Math.min(-this.vel[1] / 18, 1);
        this.eyeVel -= impact * 4;
        this.landed = fall > 0.8 ? impact : 0;
      }
      newFeet = ground;
      this.vel[1] = 0;
      this.grounded = true;
    } else if (was && newFeet - ground < STEP && this.vel[1] <= 0) {
      this.eyeOffset += newFeet - ground;
      newFeet = ground;
      this.vel[1] = 0;
    } else {
      if (was) this.fallStart = oldFeet;
      this.grounded = false;
    }
    this.pos[1] = newFeet;
    return true;
  }

  private updateCamera(dt: number, right: [number, number]): void {
    const speed = Math.hypot(this.vel[0], this.vel[2]);
    this.speedNorm = speed / SPRINT_SPEED;
    const onFoot = this.grounded && speed > 0.5;
    const targetAmp = onFoot ? Math.min(speed / SPRINT_SPEED, 1) : 0;
    this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, dt * 8);
    if (onFoot) {
      const prev = this.bobPhase;
      this.bobPhase += dt * (5.2 + speed * 0.45);
      if (Math.floor(prev / Math.PI) !== Math.floor(this.bobPhase / Math.PI)) this.footstep = true;
    }
    this.eyeVel += (-90 * this.eyeOffset - 14 * this.eyeVel) * dt;
    this.eyeOffset += this.eyeVel * dt;

    const strafe = (this.vel[0] * right[0] + this.vel[2] * right[1]) / SPRINT_SPEED;
    const targetRoll = Math.max(-0.08, Math.min(0.08, -strafe * 0.035 - this.yawRate * 0.6));
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 6);
    this.yawRate = 0;

    const targetFov = 76 + Math.max(0, speed - RUN_SPEED * 0.5) * 1.35;
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 3);
  }

  eye(): Vec3 {
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.09 * this.bobAmp - 0.045 * this.bobAmp;
    const bobX = Math.cos(this.bobPhase) * 0.05 * this.bobAmp;
    return [
      this.pos[0] - Math.cos(this.yaw) * bobX,
      this.pos[1] + EYE + bobY + this.eyeOffset,
      this.pos[2] + Math.sin(this.yaw) * bobX,
    ];
  }

  viewRoll(): number {
    return this.roll + Math.sin(this.bobPhase) * 0.006 * this.bobAmp;
  }
}
