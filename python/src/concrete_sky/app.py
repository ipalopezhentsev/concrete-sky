"""Concrete Sky: main loop, world streaming and rendering."""

from __future__ import annotations

import argparse
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import OpenGL

OpenGL.ERROR_CHECKING = bool(os.environ.get("CONCRETE_SKY_GL_DEBUG"))

import pygame  # noqa: E402
from OpenGL import GL as gl  # noqa: E402

from . import city, shaders, textures  # noqa: E402
from .audio import Audio  # noqa: E402
from .gl import (Framebuffer, Mesh, Program, ShadowMap, bind_texture,  # noqa: E402
                 fullscreen_triangle, texture_2d, texture_array)
from .player import Player  # noqa: E402
from .weather import ORDER, STATES, Weather  # noqa: E402

LOAD_RADIUS = 900.0
UNLOAD_RADIUS = 1150.0
SHADOW_SIZE = 4096
SHADOW_EXTENT = 170.0
NEAR = 0.1


# --------------------------------------------------------------------------- #
# Math                                                                         #
# --------------------------------------------------------------------------- #

def normalize(v):
    return v / np.linalg.norm(v)


def perspective_reversed(fovy_deg: float, aspect: float, near: float) -> np.ndarray:
    """Infinite far plane, reversed Z (depth 1 at near, 0 at infinity)."""
    f = 1.0 / math.tan(math.radians(fovy_deg) / 2)
    return np.array([[f / aspect, 0, 0, 0],
                     [0, f, 0, 0],
                     [0, 0, 0, near],
                     [0, 0, -1, 0]], np.float64)


def ortho01(l, r, b, t, n, f) -> np.ndarray:
    """Orthographic projection with depth mapped to [0, 1]."""
    return np.array([[2 / (r - l), 0, 0, -(r + l) / (r - l)],
                     [0, 2 / (t - b), 0, -(t + b) / (t - b)],
                     [0, 0, -1 / (f - n), -n / (f - n)],
                     [0, 0, 0, 1]], np.float64)


def view_matrix(eye, right, up, fwd) -> np.ndarray:
    return np.array([[*right, -np.dot(right, eye)],
                     [*up, -np.dot(up, eye)],
                     [*(-fwd), np.dot(fwd, eye)],
                     [0, 0, 0, 1]], np.float64)


def frustum_planes(m: np.ndarray, far_plane: bool) -> np.ndarray:
    rows = [m[3] + m[0], m[3] - m[0], m[3] + m[1], m[3] - m[1]]
    if far_plane:
        rows += [m[2], m[3] - m[2]]
    else:
        rows += [m[3] - m[2]]  # reversed-Z near plane: z <= w
    return np.array(rows)


def aabb_visible(planes: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> bool:
    n = planes[:, :3]
    p = np.where(n >= 0, hi, lo)
    return bool(np.all(np.einsum("ij,ij->i", n, p) + planes[:, 3] >= 0))


# --------------------------------------------------------------------------- #
# World streaming                                                              #
# --------------------------------------------------------------------------- #

class Region:
    def __init__(self, data: city.RegionData):
        self.mesh = Mesh(data.vertices, city.VERTEX_LAYOUT, data.indices)
        x0, z0 = data.rx * city.REGION, data.rz * city.REGION
        pad = 30.0  # bridges and expressways poke into neighbours
        self.lo = np.array([x0 - pad, -1.0, z0 - pad])
        self.hi = np.array([x0 + city.REGION + pad, data.max_height + 1, z0 + city.REGION + pad])
        self.colliders = data.colliders


class World:
    def __init__(self):
        self.regions: dict[tuple[int, int], Region] = {}
        self._collide_key = None
        self._collide_boxes = np.zeros((0, 6))

    @staticmethod
    def region_of(x: float, z: float) -> tuple[int, int]:
        return math.floor(x / city.REGION), math.floor(z / city.REGION)

    def _center_dist(self, key, x, z) -> float:
        cx = (key[0] + 0.5) * city.REGION
        cz = (key[1] + 0.5) * city.REGION
        # distance to the region rectangle, not its centre
        dx = max(abs(x - cx) - city.REGION / 2, 0.0)
        dz = max(abs(z - cz) - city.REGION / 2, 0.0)
        return math.hypot(dx, dz)

    def ensure(self, key) -> None:
        if key not in self.regions:
            self.regions[key] = Region(city.build_region(*key))

    def update(self, x: float, z: float, budget: int = 1) -> None:
        rx, rz = self.region_of(x, z)
        span = int(LOAD_RADIUS // city.REGION) + 1
        missing = []
        for i in range(rx - span, rx + span + 1):
            for j in range(rz - span, rz + span + 1):
                d = self._center_dist((i, j), x, z)
                if d <= LOAD_RADIUS and (i, j) not in self.regions:
                    missing.append((d, (i, j)))
        missing.sort()
        for _, key in missing[:budget]:
            self.ensure(key)
        for key in [k for k in self.regions if self._center_dist(k, x, z) > UNLOAD_RADIUS]:
            self.regions.pop(key).mesh.delete()

    def colliders(self, x: float, z: float) -> np.ndarray:
        ci, cj = math.floor(x / city.CELL), math.floor(z / city.CELL)
        if self._collide_key == (ci, cj):
            return self._collide_boxes
        parts = []
        for i in range(ci - 1, ci + 2):
            for j in range(cj - 1, cj + 2):
                key = (i // city.REGION_CELLS, j // city.REGION_CELLS)
                self.ensure(key)
                parts.append(self.regions[key].colliders[(i, j)])
        self._collide_key = (ci, cj)
        self._collide_boxes = np.concatenate(parts)
        return self._collide_boxes

    def draw(self, planes: np.ndarray) -> int:
        n = 0
        for region in self.regions.values():
            if aabb_visible(planes, region.lo, region.hi):
                region.mesh.draw()
                n += 1
        return n


# --------------------------------------------------------------------------- #
# Text overlay                                                                 #
# --------------------------------------------------------------------------- #

class Label:
    def __init__(self, text: str, size: int, color=(235, 235, 230), spacing: int = 0):
        font = pygame.font.Font(None, size)
        if spacing:
            text = (" " * spacing).join(text)
        lines = text.split("\n")
        surfs = [font.render(line, True, color) for line in lines]
        w = max(s.get_width() for s in surfs)
        h = sum(s.get_height() for s in surfs)
        surf = pygame.Surface((w + 4, h + 4), pygame.SRCALPHA)
        y = 2
        for s in surfs:
            surf.blit(s, ((w - s.get_width()) // 2 + 2, y))
            y += s.get_height()
        data = np.frombuffer(pygame.image.tobytes(surf, "RGBA"), np.uint8).reshape(surf.get_height(), surf.get_width(), 4)
        self.tex = texture_2d(data, mipmaps=False, repeat=False)
        self.w, self.h = surf.get_size()

    def delete(self):
        gl.glDeleteTextures(1, [self.tex])


# --------------------------------------------------------------------------- #
# App                                                                          #
# --------------------------------------------------------------------------- #

class App:
    def __init__(self, args):
        self.args = args
        pygame.init()
        pygame.display.gl_set_attribute(pygame.GL_CONTEXT_MAJOR_VERSION, 4)
        pygame.display.gl_set_attribute(pygame.GL_CONTEXT_MINOR_VERSION, 5)
        pygame.display.gl_set_attribute(pygame.GL_CONTEXT_PROFILE_MASK, pygame.GL_CONTEXT_PROFILE_CORE)
        pygame.display.gl_set_attribute(pygame.GL_DEPTH_SIZE, 24)
        flags = pygame.OPENGL | pygame.DOUBLEBUF
        if args.fullscreen:
            flags |= pygame.FULLSCREEN
            size = (0, 0)
        else:
            size = (args.width, args.height)
        pygame.display.set_mode(size, flags, vsync=0 if args.shots else 1)
        pygame.display.set_caption("Concrete Sky")
        self.width, self.height = pygame.display.get_window_size()

        renderer = gl.glGetString(gl.GL_RENDERER).decode()
        print("GL:", renderer, gl.glGetString(gl.GL_VERSION).decode())
        integrated = any(k in renderer for k in ("Intel", "UHD", "Iris"))
        if integrated:
            print("hint: running on an integrated GPU. On a hybrid laptop, set python.exe to "
                  "'High performance' in Windows Settings > System > Display > Graphics.")
        scale = args.scale if args.scale > 0 else (0.7 if integrated else 1.0)
        self.render_w, self.render_h = int(self.width * scale), int(self.height * scale)
        gl.glClipControl(gl.GL_LOWER_LEFT, gl.GL_ZERO_TO_ONE)

        self._loading_screen("generating textures")
        albedo, normals, noise = textures.generate()
        self.tex_albedo = texture_array(albedo, srgb=True)
        self.tex_normal = texture_array(normals, srgb=False)
        self.tex_noise = texture_2d(noise, mipmaps=False)

        self.sky_prog = Program(shaders.SKY_VS, shaders.SKY_FS)
        self.city_prog = Program(shaders.CITY_VS, shaders.CITY_FS)
        self.shadow_prog = Program(shaders.SHADOW_VS, shaders.SHADOW_FS)
        self.rain_prog = Program(shaders.RAIN_VS, shaders.RAIN_FS)
        self.post_prog = Program(shaders.POST_VS, shaders.POST_FS)
        self.overlay_prog = Program(shaders.OVERLAY_VS, shaders.OVERLAY_FS)

        self.tri = fullscreen_triangle()
        self.quad = Mesh(np.array([[-1, -1], [1, -1], [-1, 1], [1, 1]], np.float32), [2],
                         mode=gl.GL_TRIANGLE_STRIP)
        rng = np.random.default_rng(3)
        n_drops = 7000
        seeds = rng.random((n_drops, 3)).astype(np.float32)
        rain = np.zeros((n_drops * 2, 4), np.float32)
        rain[0::2, :3] = seeds
        rain[1::2, :3] = seeds
        rain[1::2, 3] = 1.0
        self.rain = Mesh(rain, [3, 1], mode=gl.GL_LINES)

        self.hdr = Framebuffer(self.render_w, self.render_h)
        self.shadow = ShadowMap(SHADOW_SIZE)

        self.world = World()
        self.player = Player(-4.5, city.CELL * 0.5 - 20, yaw=0.0)
        self.weather = Weather(args.weather, cycle=not args.shots)
        self.audio = Audio() if not (args.no_audio or args.shots) else None

        self._loading_screen("pouring concrete")
        self.world.update(*self.player.pos[[0, 2]], budget=10_000)

        self.title = Label("CONCRETE SKY", 96, spacing=1)
        self.help = Label("WASD run    SHIFT sprint    CTRL walk    SPACE jump\n"
                          "N next weather    L hold weather    H help    TAB mouse    ESC quit", 30,
                          color=(210, 210, 205))
        self.weather_label: Label | None = None
        self.weather_label_t = 0.0
        self.help_t = 12.0
        self.title_t = 8.0
        self.fade = 0.0
        self.time = 0.0
        self.mouse_captured = False
        self.cam_vel = np.zeros(3)
        self.shots_dir = Path("screenshots")
        self.frame_count = 0

    # ------------------------------------------------------------------ #
    def _loading_screen(self, text: str) -> None:
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, 0)
        gl.glClearColor(0.05, 0.05, 0.06, 1)
        gl.glClear(gl.GL_COLOR_BUFFER_BIT)
        pygame.display.flip()
        pygame.event.pump()
        print(text + "...")

    def capture_mouse(self, on: bool) -> None:
        self.mouse_captured = on
        pygame.event.set_grab(on)
        pygame.mouse.set_visible(not on)
        pygame.mouse.set_relative_mode(on)
        pygame.mouse.get_rel()

    # ------------------------------------------------------------------ #
    def camera(self):
        p = self.player
        eye = p.eye()
        fwd = p.forward()
        right = normalize(np.cross(fwd, [0.0, 1.0, 0.0]))
        up = np.cross(right, fwd)
        roll = p.view_roll()
        right, up = right * math.cos(roll) + up * math.sin(roll), up * math.cos(roll) - right * math.sin(roll)
        return eye, fwd, right, up

    def light_matrix(self, eye, fwd, light_dir) -> np.ndarray:
        flat = np.array([fwd[0], 0.0, fwd[2]])
        if np.linalg.norm(flat) > 1e-3:
            flat = normalize(flat)
        center = eye + flat * (SHADOW_EXTENT * 0.55)
        center[1] = 0.0
        L = normalize(np.asarray(light_dir, np.float64))
        up_hint = np.array([0.0, 1.0, 0.0]) if abs(L[1]) < 0.95 else np.array([0.0, 0.0, 1.0])
        lf = -L
        lr = normalize(np.cross(lf, up_hint))
        lu = np.cross(lr, lf)
        # snap to shadow texels to avoid shimmering
        texel = 2 * SHADOW_EXTENT / SHADOW_SIZE
        cx = math.floor(np.dot(center, lr) / texel) * texel
        cy = math.floor(np.dot(center, lu) / texel) * texel
        cz = np.dot(center, lf)
        center = lr * cx + lu * cy + lf * cz
        dist = 900.0
        view = view_matrix(center - lf * dist, lr, lu, lf)
        proj = ortho01(-SHADOW_EXTENT, SHADOW_EXTENT, -SHADOW_EXTENT, SHADOW_EXTENT, 1.0, dist + 400.0)
        return proj @ view

    def render(self) -> None:
        w = self.weather
        wu = w.uniforms()
        eye, fwd, right, up = self.camera()
        aspect = self.render_w / self.render_h
        proj = perspective_reversed(self.player.fov, aspect, NEAR)
        view = view_matrix(eye, right, up, fwd)
        view_proj = proj @ view
        light_vp = self.light_matrix(eye, fwd, wu["uLightDir"])

        common = dict(wu)
        common["uTime"] = self.time
        common["uCamPos"] = eye

        # --- shadow pass ---
        self.shadow.bind()
        gl.glEnable(gl.GL_DEPTH_TEST)
        gl.glDepthFunc(gl.GL_LESS)
        gl.glClearDepth(1.0)
        gl.glClear(gl.GL_DEPTH_BUFFER_BIT)
        gl.glEnable(gl.GL_DEPTH_CLAMP)
        gl.glDisable(gl.GL_CULL_FACE)
        gl.glEnable(gl.GL_POLYGON_OFFSET_FILL)
        gl.glPolygonOffset(1.5, 3.0)
        self.shadow_prog.use()
        self.shadow_prog.set("uViewProj", light_vp)
        self.world.draw(frustum_planes(light_vp, far_plane=False))
        gl.glDisable(gl.GL_POLYGON_OFFSET_FILL)
        gl.glDisable(gl.GL_DEPTH_CLAMP)

        # --- main pass ---
        self.hdr.bind()
        gl.glClearDepth(0.0)
        gl.glClear(gl.GL_COLOR_BUFFER_BIT | gl.GL_DEPTH_BUFFER_BIT)

        bind_texture(0, self.tex_albedo, gl.GL_TEXTURE_2D_ARRAY)
        bind_texture(1, self.tex_normal, gl.GL_TEXTURE_2D_ARRAY)
        bind_texture(2, self.shadow.depth)
        bind_texture(3, self.tex_noise)

        gl.glDisable(gl.GL_DEPTH_TEST)
        gl.glDepthMask(gl.GL_FALSE)
        sp = self.sky_prog
        sp.use()
        sp.set_many(common)
        sp.set("uNoise", 3)
        tan_y = math.tan(math.radians(self.player.fov) / 2)
        sp.set("uTanHalf", (tan_y * aspect, tan_y))
        sp.set("uCamFwd", fwd)
        sp.set("uCamRight", right)
        sp.set("uCamUp", up)
        self.tri.draw()

        gl.glEnable(gl.GL_DEPTH_TEST)
        gl.glDepthMask(gl.GL_TRUE)
        gl.glDepthFunc(gl.GL_GREATER)
        gl.glEnable(gl.GL_CULL_FACE)
        gl.glCullFace(gl.GL_BACK)
        cp = self.city_prog
        cp.use()
        cp.set_many(common)
        cp.set("uViewProj", view_proj)
        cp.set("uLightVP", light_vp)
        cp.set("uShadowTexel", 1.0 / SHADOW_SIZE)
        cp.set("uAlbedo", 0)
        cp.set("uNormal", 1)
        cp.set("uShadow", 2)
        cp.set("uNoise", 3)
        planes = frustum_planes(view_proj, far_plane=False)
        self.world.draw(planes)

        rain_amt = w.params["rain"]
        if rain_amt > 0.01:
            gl.glDisable(gl.GL_CULL_FACE)
            gl.glEnable(gl.GL_BLEND)
            gl.glBlendFunc(gl.GL_SRC_ALPHA, gl.GL_ONE_MINUS_SRC_ALPHA)
            gl.glDepthMask(gl.GL_FALSE)
            rp = self.rain_prog
            rp.use()
            rp.set("uViewProj", view_proj)
            rp.set("uCamPos", eye)
            rp.set("uTime", self.time)
            rp.set("uWindVec", (2.5 * w.params["wind"], 1.5 * w.params["wind"]))
            rp.set("uCamVel", self.cam_vel)
            rp.set("uRain", rain_amt)
            rp.set("uRainColor", (0.25 + 0.5 * w.params["ambient"]) * np.array([0.8, 0.85, 0.95]))
            self.rain.draw()
            gl.glDepthMask(gl.GL_TRUE)
            gl.glDisable(gl.GL_BLEND)

        # --- post ---
        self.hdr.build_mips()
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, 0)
        gl.glViewport(0, 0, self.width, self.height)
        gl.glDisable(gl.GL_DEPTH_TEST)
        gl.glDisable(gl.GL_CULL_FACE)
        pp = self.post_prog
        pp.use()
        bind_texture(4, self.hdr.color)
        pp.set("uScene", 4)
        pp.set("uNoiseTex", 3)
        pp.set_many(w.post_uniforms())
        pp.set("uTime", self.time)
        pp.set("uSpeed", float(np.clip((self.player.speed_norm - 0.6) * 2.5, 0, 1)))
        pp.set("uFade", self.fade)
        pp.set("uResolution", (float(self.width), float(self.height)))
        self.tri.draw()

        self.draw_overlays()

    def draw_label(self, label: Label, cx: float, cy: float, alpha: float) -> None:
        if alpha <= 0.01:
            return
        op = self.overlay_prog
        wn = label.w / self.width * 2
        hn = label.h / self.height * 2
        op.set("uRect", (cx - wn / 2, cy - hn / 2, wn, hn))
        op.set("uAlpha", alpha)
        bind_texture(5, label.tex)
        op.set("uTex", 5)
        self.quad.draw()

    def draw_overlays(self) -> None:
        gl.glEnable(gl.GL_BLEND)
        gl.glBlendFunc(gl.GL_SRC_ALPHA, gl.GL_ONE_MINUS_SRC_ALPHA)
        self.overlay_prog.use()
        fade = lambda t, total: min(1.0, t / 1.5, (total - t) / 1.5 + 1.0) if t > 0 else 0.0  # noqa: E731
        self.draw_label(self.title, 0.0, 0.25, min(1.0, self.title_t / 2.0) * 0.9)
        self.draw_label(self.help, 0.0, -0.8, min(1.0, self.help_t / 1.5) * 0.8)
        if self.weather_label is not None:
            self.draw_label(self.weather_label, 0.0, 0.62, fade(self.weather_label_t, 6.0) * 0.85)
        gl.glDisable(gl.GL_BLEND)

    # ------------------------------------------------------------------ #
    def handle_events(self) -> bool:
        for e in pygame.event.get():
            if e.type == pygame.QUIT:
                return False
            if e.type == pygame.KEYDOWN:
                if e.key == pygame.K_ESCAPE:
                    return False
                if e.key == pygame.K_TAB:
                    self.capture_mouse(not self.mouse_captured)
                elif e.key == pygame.K_n:
                    self.weather.next(6.0)
                elif e.key == pygame.K_l:
                    self.weather.cycle = not self.weather.cycle
                    self.show_text("weather held" if not self.weather.cycle else "weather drifting")
                elif e.key == pygame.K_h:
                    self.help_t = 0.0 if self.help_t > 0 else 8.0
                elif e.key == pygame.K_F12:
                    self.save_screenshot()
            if e.type == pygame.MOUSEBUTTONDOWN and not self.mouse_captured:
                self.capture_mouse(True)
            if e.type == pygame.WINDOWFOCUSLOST and self.mouse_captured:
                self.capture_mouse(False)
        return True

    def show_text(self, text: str) -> None:
        if self.weather_label is not None:
            self.weather_label.delete()
        self.weather_label = Label(f"— {text} —", 44, spacing=1)
        self.weather_label_t = 6.0

    def save_screenshot(self, path: Path | None = None) -> Path:
        if path is None:
            self.shots_dir.mkdir(exist_ok=True)
            path = self.shots_dir / time.strftime("concrete-sky-%Y%m%d-%H%M%S.png")
        gl.glBindFramebuffer(gl.GL_FRAMEBUFFER, 0)
        gl.glReadBuffer(gl.GL_BACK)
        data = gl.glReadPixels(0, 0, self.width, self.height, gl.GL_RGB, gl.GL_UNSIGNED_BYTE)
        img = np.frombuffer(data, np.uint8).reshape(self.height, self.width, 3)[::-1]
        surf = pygame.image.frombuffer(np.ascontiguousarray(img).tobytes(), (self.width, self.height), "RGB")
        pygame.image.save(surf, str(path))
        print("saved", path)
        return path

    def update(self, dt: float) -> None:
        self.time += dt
        keys = pygame.key.get_pressed()
        if self.mouse_captured:
            dx, dy = pygame.mouse.get_rel()
            self.player.look(dx, dy)
        move = (float(keys[pygame.K_d]) - float(keys[pygame.K_a]),
                float(keys[pygame.K_w]) - float(keys[pygame.K_s]))
        sprint = keys[pygame.K_LSHIFT] or keys[pygame.K_RSHIFT]
        walk = keys[pygame.K_LCTRL] or keys[pygame.K_c]
        jump = keys[pygame.K_SPACE]
        if self.args.autorun:
            move, sprint = (0.0, 1.0), True
            self.player.yaw += dt * 0.08 * math.sin(self.time * 0.3)
        before = self.player.eye()
        self.player.update(dt, move, sprint, walk, jump, self.world.colliders)
        self.cam_vel = (self.player.eye() - before) / max(dt, 1e-4)

        self.weather.update(dt)
        if self.weather.changed_to is not None:
            if self.time > 1.0:
                self.show_text(self.weather.changed_to)
            self.weather.changed_to = None

        self.world.update(*self.player.pos[[0, 2]], budget=1)

        if self.audio:
            if self.player.footstep:
                self.audio.step(self.player.speed_norm, self.weather.wet)
            if self.player.landed > 0.15:
                self.audio.landing(self.player.landed)
            self.audio.update(dt, self.weather.params, self.player.speed_norm, self.player.pos[1])

        self.fade = min(1.0, self.fade + dt * 0.5)
        self.title_t = max(0.0, self.title_t - dt)
        self.help_t = max(0.0, self.help_t - dt)
        self.weather_label_t = max(0.0, self.weather_label_t - dt)

    def run(self) -> None:
        if self.args.shots:
            self.run_shots(Path(self.args.shots))
            return
        self.capture_mouse(not self.args.autorun)
        clock = pygame.time.Clock()
        fps_t, frames = 0.0, 0
        running = True
        while running:
            dt = min(clock.tick(0) / 1000.0, 0.05)
            running = self.handle_events()
            self.update(dt)
            self.render()
            pygame.display.flip()
            if self.args.autorun and self.time > self.args.autorun:
                self.save_screenshot()
                print(f"autorun: {self.frame_count / self.time:.1f} fps avg, pos {self.player.pos.round(1)}")
                running = False
            self.frame_count += 1
            frames += 1
            fps_t += dt
            if fps_t > 2.0:
                pygame.display.set_caption(f"Concrete Sky — {frames / fps_t:.0f} fps — {self.weather.name}")
                fps_t, frames = 0.0, 0
        pygame.quit()

    def run_shots(self, out: Path) -> None:
        """Render a set of fixed views for every weather state (for development)."""
        out.mkdir(parents=True, exist_ok=True)
        self.fade = 1.0
        self.title_t = self.help_t = 0.0
        views = self.args.views or "street,up,high"
        presets = {
            "street": ((-4.5, 1.0, 30.0), 0.0, 0.05),
            "up": ((-4.5, 1.0, 30.0), 0.6, 0.45),
            "high": ((60.0, 45.0, -60.0), 0.9, -0.12),
            "side": ((20.0, 1.0, 5.0), 1.57, 0.1),
        }
        names = self.args.shot_weathers.split(",") if self.args.shot_weathers else ORDER
        for name in names:
            self.weather = Weather(name, cycle=False)
            self.weather.update(0.0)
            for view in views.split(","):
                pos, yaw, pitch = presets[view]
                self.player.pos[:] = pos
                self.player.yaw, self.player.pitch = yaw, pitch
                self.world.update(pos[0], pos[2], budget=10_000)
                pygame.event.pump()
                self.render()
                gl.glFinish()
                t0 = time.perf_counter()
                for _ in range(5):
                    self.render()
                gl.glFinish()
                dt = (time.perf_counter() - t0) / 5
                self.save_screenshot(out / f"{name.replace(' ', '_')}-{view}.png")
                print(f"  frame {dt * 1000:.1f} ms")
                pygame.display.flip()
        pygame.quit()


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="concrete-sky", description="A moody run through a brutalist city.")
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--fullscreen", action="store_true")
    ap.add_argument("--weather", default="clear sky", choices=list(STATES))
    ap.add_argument("--scale", type=float, default=0.0,
                    help="internal render resolution scale (default: auto, 0.7 on integrated GPUs)")
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--shots", metavar="DIR", help="render preset views to DIR and exit")
    ap.add_argument("--shot-weathers", help="comma-separated weather names for --shots")
    ap.add_argument("--views", help="comma-separated views for --shots (street,up,high,side)")
    ap.add_argument("--autorun", type=float, default=0.0, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    App(args).run()


if __name__ == "__main__":
    main(sys.argv[1:])
