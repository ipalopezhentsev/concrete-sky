"""First-person runner: movement, collision against city boxes, camera feel."""

from __future__ import annotations

import math

import numpy as np

RADIUS = 0.35
HEIGHT = 1.8
EYE = 1.68
STEP = 0.55
RUN_SPEED = 7.5
SPRINT_SPEED = 13.5
WALK_SPEED = 3.2
JUMP_SPEED = 6.2
GRAVITY = 19.0


class Player:
    def __init__(self, x: float, z: float, yaw: float = 0.0):
        self.pos = np.array([x, 0.0, z], np.float64)  # feet
        self.vel = np.zeros(3, np.float64)
        self.yaw = yaw  # radians, 0 looks toward +Z
        self.pitch = 0.0
        self.grounded = False
        self.bob_phase = 0.0
        self.bob_amp = 0.0
        self.eye_offset = 0.0  # smoothed step-up / landing dip
        self.eye_vel = 0.0
        self.roll = 0.0
        self.fov = 78.0
        self.yaw_rate = 0.0
        self.footstep = False  # set for one frame when a foot lands
        self.landed = 0.0  # impact strength of a landing this frame
        self.speed_norm = 0.0

    # --- input ------------------------------------------------------------ #
    def look(self, dx: float, dy: float, sensitivity: float = 0.0022) -> None:
        self.yaw -= dx * sensitivity
        self.pitch = max(-1.5, min(1.5, self.pitch - dy * sensitivity))
        self.yaw_rate += dx * sensitivity

    def forward(self) -> np.ndarray:
        cp = math.cos(self.pitch)
        return np.array([math.sin(self.yaw) * cp, math.sin(self.pitch), math.cos(self.yaw) * cp])

    # --- simulation ------------------------------------------------------- #
    def update(self, dt: float, move: tuple[float, float], sprint: bool, walk: bool, jump: bool, colliders) -> None:
        self.footstep = False
        self.landed = 0.0
        fwd = np.array([math.sin(self.yaw), 0.0, math.cos(self.yaw)])
        right = np.array([-fwd[2], 0.0, fwd[0]])
        wish = fwd * move[1] + right * move[0]
        n = np.linalg.norm(wish)
        if n > 1e-6:
            wish /= n
        target_speed = WALK_SPEED if walk else (SPRINT_SPEED if sprint else RUN_SPEED)
        target = wish * target_speed

        horiz = self.vel[[0, 2]]
        accel = 10.0 if self.grounded else 2.5
        if n < 1e-6 and self.grounded:
            accel = 12.0
        blend = 1 - math.exp(-accel * dt)
        horiz += (target[[0, 2]] - horiz) * blend
        self.vel[0], self.vel[2] = horiz

        if jump and self.grounded:
            self.vel[1] = JUMP_SPEED
            self.grounded = False
        self.vel[1] -= GRAVITY * dt

        boxes = colliders(self.pos[0], self.pos[2])
        self._move_axis(0, self.vel[0] * dt, boxes)
        self._move_axis(2, self.vel[2] * dt, boxes)
        self._move_vertical(dt, boxes)

        # camera feel
        speed = math.hypot(self.vel[0], self.vel[2])
        self.speed_norm = speed / SPRINT_SPEED
        on_foot = self.grounded and speed > 0.5
        target_amp = min(speed / SPRINT_SPEED, 1.0) if on_foot else 0.0
        self.bob_amp += (target_amp - self.bob_amp) * min(1.0, dt * 8)
        if on_foot:
            prev = self.bob_phase
            self.bob_phase += dt * (5.2 + speed * 0.45)
            if math.floor(prev / math.pi) != math.floor(self.bob_phase / math.pi):
                self.footstep = True

        # spring the eye offset back to zero
        k, damping = 90.0, 14.0
        self.eye_vel += (-k * self.eye_offset - damping * self.eye_vel) * dt
        self.eye_offset += self.eye_vel * dt

        strafe = float(np.dot(self.vel, right)) / SPRINT_SPEED
        target_roll = -strafe * 0.035 - self.yaw_rate * 0.6
        self.roll += (max(-0.08, min(0.08, target_roll)) - self.roll) * min(1.0, dt * 6)
        self.yaw_rate = 0.0

        target_fov = 76.0 + max(0.0, speed - RUN_SPEED * 0.5) * 1.35
        self.fov += (target_fov - self.fov) * min(1.0, dt * 3)

    def _blocking(self, boxes: np.ndarray, pos: np.ndarray) -> np.ndarray:
        feet, head = pos[1], pos[1] + HEIGHT
        return ((boxes[:, 0] < pos[0] + RADIUS) & (boxes[:, 3] > pos[0] - RADIUS)
                & (boxes[:, 2] < pos[2] + RADIUS) & (boxes[:, 5] > pos[2] - RADIUS)
                & (boxes[:, 4] > feet + STEP) & (boxes[:, 1] < head))

    def _move_axis(self, axis: int, delta: float, boxes: np.ndarray) -> None:
        if delta == 0.0:
            return
        self.pos[axis] += delta
        if len(boxes) == 0:
            return
        hit = self._blocking(boxes, self.pos)
        if not hit.any():
            return
        hb = boxes[hit]
        lo_i, hi_i = axis, axis + 3
        if delta > 0:
            self.pos[axis] = hb[:, lo_i].min() - RADIUS - 1e-4
        else:
            self.pos[axis] = hb[:, hi_i].max() + RADIUS + 1e-4
        self.vel[axis] = 0.0

    def _move_vertical(self, dt: float, boxes: np.ndarray) -> None:
        old_feet = self.pos[1]
        new_feet = old_feet + self.vel[1] * dt
        ground = 0.0
        ceiling = math.inf
        if len(boxes):
            inside = ((boxes[:, 0] < self.pos[0] + RADIUS) & (boxes[:, 3] > self.pos[0] - RADIUS)
                      & (boxes[:, 2] < self.pos[2] + RADIUS) & (boxes[:, 5] > self.pos[2] - RADIUS))
            ib = boxes[inside]
            if len(ib):
                below = ib[ib[:, 4] <= old_feet + STEP + 1e-3]
                if len(below):
                    ground = max(ground, below[:, 4].max())
                above = ib[ib[:, 1] >= old_feet + HEIGHT - 1e-3]
                if len(above):
                    ceiling = above[:, 1].min()

        if self.vel[1] > 0 and new_feet + HEIGHT > ceiling:
            new_feet = ceiling - HEIGHT
            self.vel[1] = 0.0

        was_grounded = self.grounded
        if new_feet <= ground:
            if ground > old_feet + 1e-3 and was_grounded:
                # step up: move instantly, let the camera catch up
                self.eye_offset -= ground - old_feet
            if not was_grounded and self.vel[1] < -2.0:
                impact = min(-self.vel[1] / 15.0, 1.0)
                self.eye_vel -= impact * 3.5
                self.landed = impact
            new_feet = ground
            self.vel[1] = 0.0
            self.grounded = True
        elif was_grounded and new_feet - ground < STEP and self.vel[1] <= 0:
            # stick to the ground when walking down steps
            self.eye_offset += new_feet - ground
            new_feet = ground
            self.vel[1] = 0.0
        else:
            self.grounded = False
        self.pos[1] = new_feet

    # --- camera ----------------------------------------------------------- #
    def eye(self) -> np.ndarray:
        bob_y = abs(math.sin(self.bob_phase)) * 0.09 * self.bob_amp - 0.045 * self.bob_amp
        bob_x = math.cos(self.bob_phase) * 0.05 * self.bob_amp
        fwd = np.array([math.sin(self.yaw), 0.0, math.cos(self.yaw)])
        right = np.array([-fwd[2], 0.0, fwd[0]])
        return self.pos + np.array([0.0, EYE + bob_y + self.eye_offset, 0.0]) + right * bob_x

    def view_roll(self) -> float:
        return self.roll + math.sin(self.bob_phase) * 0.006 * self.bob_amp
