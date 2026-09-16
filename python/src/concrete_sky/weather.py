"""Weather and mood: named states that blend smoothly into each other."""

from __future__ import annotations

import math
import random

import numpy as np

# All colors are linear HDR.
STATES: dict[str, dict] = {
    "clear sky": dict(
        sun_elev=48, sun_azim=35, sun_color=(1.00, 0.96, 0.88), sun_int=3.2, sun_glow=1.0,
        zenith=(0.05, 0.18, 0.62), horizon=(0.42, 0.60, 0.88), ground=(0.30, 0.30, 0.30),
        ambient=0.55, cloud_cover=0.42, cloud_dark=0.10, cloud_speed=1.0,
        fog_density=0.0015, fog_color=(0.55, 0.66, 0.84), fog_tint=0.1,
        rain=0.0, night=0.0, exposure=0.95, saturation=1.1, contrast=1.1, grade=(1.0, 1.0, 1.0),
        wind=0.35, gloom=0.0, weight=5,
    ),
    "drifting cumulus": dict(
        sun_elev=40, sun_azim=60, sun_color=(1.00, 0.95, 0.86), sun_int=3.4, sun_glow=1.0,
        zenith=(0.04, 0.15, 0.55), horizon=(0.42, 0.57, 0.82), ground=(0.28, 0.28, 0.28),
        ambient=0.55, cloud_cover=0.6, cloud_dark=0.35, cloud_speed=1.6,
        fog_density=0.0018, fog_color=(0.58, 0.68, 0.82), fog_tint=0.15,
        rain=0.0, night=0.0, exposure=1.0, saturation=1.05, contrast=1.08, grade=(1.0, 1.0, 1.02),
        wind=0.5, gloom=0.15, weight=4,
    ),
    "white noon": dict(
        sun_elev=72, sun_azim=10, sun_color=(1.00, 0.98, 0.94), sun_int=3.6, sun_glow=1.3,
        zenith=(0.16, 0.34, 0.80), horizon=(0.78, 0.84, 0.92), ground=(0.34, 0.33, 0.31),
        ambient=0.65, cloud_cover=0.25, cloud_dark=0.05, cloud_speed=0.6,
        fog_density=0.0026, fog_color=(0.80, 0.84, 0.90), fog_tint=0.3,
        rain=0.0, night=0.0, exposure=0.85, saturation=0.9, contrast=1.1, grade=(1.02, 1.01, 0.98),
        wind=0.25, gloom=0.0, weight=2,
    ),
    "overcast": dict(
        sun_elev=45, sun_azim=40, sun_color=(0.85, 0.87, 0.90), sun_int=0.5, sun_glow=0.3,
        zenith=(0.30, 0.34, 0.40), horizon=(0.56, 0.59, 0.63), ground=(0.22, 0.22, 0.23),
        ambient=1.35, cloud_cover=0.96, cloud_dark=0.45, cloud_speed=1.2,
        fog_density=0.0040, fog_color=(0.52, 0.55, 0.60), fog_tint=0.6,
        rain=0.0, night=0.0, exposure=1.15, saturation=0.72, contrast=1.02, grade=(0.98, 1.0, 1.03),
        wind=0.55, gloom=0.6, weight=3,
    ),
    "rain": dict(
        sun_elev=40, sun_azim=40, sun_color=(0.70, 0.75, 0.82), sun_int=0.25, sun_glow=0.1,
        zenith=(0.14, 0.16, 0.20), horizon=(0.30, 0.33, 0.37), ground=(0.12, 0.12, 0.13),
        ambient=1.2, cloud_cover=1.0, cloud_dark=0.85, cloud_speed=2.4,
        fog_density=0.0065, fog_color=(0.28, 0.31, 0.35), fog_tint=0.8,
        rain=1.0, night=0.25, exposure=1.35, saturation=0.65, contrast=1.08, grade=(0.94, 0.99, 1.06),
        wind=0.9, gloom=1.0, weight=2,
    ),
    "fog": dict(
        sun_elev=30, sun_azim=110, sun_color=(0.95, 0.93, 0.88), sun_int=0.9, sun_glow=0.8,
        zenith=(0.52, 0.57, 0.64), horizon=(0.70, 0.73, 0.76), ground=(0.40, 0.41, 0.42),
        ambient=1.0, cloud_cover=0.75, cloud_dark=0.2, cloud_speed=0.3,
        fog_density=0.020, fog_color=(0.64, 0.67, 0.71), fog_tint=1.0,
        rain=0.0, night=0.05, exposure=1.05, saturation=0.6, contrast=0.95, grade=(0.98, 1.0, 1.02),
        wind=0.15, gloom=0.7, weight=2,
    ),
    "golden hour": dict(
        sun_elev=7, sun_azim=250, sun_color=(1.00, 0.60, 0.30), sun_int=2.6, sun_glow=1.8,
        zenith=(0.08, 0.16, 0.42), horizon=(0.95, 0.60, 0.40), ground=(0.28, 0.22, 0.20),
        ambient=0.55, cloud_cover=0.48, cloud_dark=0.25, cloud_speed=0.8,
        fog_density=0.0024, fog_color=(0.85, 0.60, 0.45), fog_tint=0.2,
        rain=0.0, night=0.12, exposure=0.95, saturation=1.1, contrast=1.1, grade=(1.04, 0.99, 0.94),
        wind=0.3, gloom=0.25, weight=3,
    ),
    "storm light": dict(
        sun_elev=16, sun_azim=200, sun_color=(1.00, 0.82, 0.60), sun_int=4.0, sun_glow=1.2,
        zenith=(0.15, 0.17, 0.23), horizon=(0.45, 0.42, 0.40), ground=(0.18, 0.17, 0.17),
        ambient=1.3, cloud_cover=0.72, cloud_dark=0.95, cloud_speed=3.0,
        fog_density=0.0035, fog_color=(0.35, 0.36, 0.38), fog_tint=0.4,
        rain=0.15, night=0.1, exposure=1.1, saturation=0.9, contrast=1.12, grade=(1.02, 1.0, 0.98),
        wind=1.0, gloom=0.9, weight=2,
    ),
    "blue hour": dict(
        sun_elev=-5, sun_azim=280, sun_color=(0.25, 0.35, 0.60), sun_int=0.6, sun_glow=0.9,
        zenith=(0.006, 0.013, 0.045), horizon=(0.06, 0.075, 0.14), ground=(0.03, 0.03, 0.04),
        ambient=1.1, cloud_cover=0.35, cloud_dark=0.4, cloud_speed=0.6,
        fog_density=0.0032, fog_color=(0.06, 0.08, 0.14), fog_tint=0.3,
        rain=0.0, night=1.0, exposure=1.3, saturation=0.85, contrast=1.05, grade=(0.97, 1.0, 1.05),
        wind=0.3, gloom=0.5, weight=2,
    ),
}

VECTOR_KEYS = [k for k, v in STATES["clear sky"].items() if isinstance(v, tuple)]
SCALAR_KEYS = [k for k, v in STATES["clear sky"].items() if not isinstance(v, tuple) and k != "weight"]
ORDER = list(STATES)


def _as_arrays(state: dict) -> dict:
    return {k: (np.array(state[k], np.float32) if k in VECTOR_KEYS else float(state[k]))
            for k in VECTOR_KEYS + SCALAR_KEYS}


def _smooth(t: float) -> float:
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def _direction(elev_deg: float, azim_deg: float) -> np.ndarray:
    e, a = math.radians(elev_deg), math.radians(azim_deg)
    return np.array([math.cos(e) * math.sin(a), math.sin(e), math.cos(e) * math.cos(a)], np.float32)


class Weather:
    def __init__(self, start: str = "clear sky", seed: int | None = None, cycle: bool = True):
        self.rng = random.Random(seed)
        self.cycle = cycle
        self.src_name = self.dst_name = start
        self.src = self.dst = _as_arrays(STATES[start])
        self.blend = 1.0
        self.blend_time = 20.0
        self.hold = self.rng.uniform(50, 80)
        self.wet = STATES[start]["rain"]
        self.cloud_offset = np.zeros(2, np.float32)
        self.params = dict(self.src)
        self.changed_to: str | None = start

    @property
    def name(self) -> str:
        return self.dst_name

    def _pick_next(self) -> str:
        names = [n for n in ORDER if n != self.dst_name]
        weights = [STATES[n]["weight"] for n in names]
        return self.rng.choices(names, weights)[0]

    def go_to(self, name: str, duration: float) -> None:
        self.src = dict(self.params)
        self.src_name = self.dst_name
        self.dst_name = name
        self.dst = _as_arrays(STATES[name])
        self.blend = 0.0
        self.blend_time = duration
        self.hold = self.rng.uniform(45, 90)
        self.changed_to = name

    def next(self, duration: float = 5.0) -> None:
        idx = ORDER.index(self.dst_name)
        self.go_to(ORDER[(idx + 1) % len(ORDER)], duration)

    def update(self, dt: float) -> None:
        if self.blend < 1.0:
            self.blend = min(1.0, self.blend + dt / self.blend_time)
        elif self.cycle:
            self.hold -= dt
            if self.hold <= 0:
                self.go_to(self._pick_next(), self.rng.uniform(15, 30))
        t = _smooth(self.blend)
        p = {}
        for k in VECTOR_KEYS:
            p[k] = self.src[k] + (self.dst[k] - self.src[k]) * t
        for k in SCALAR_KEYS:
            p[k] = self.src[k] + (self.dst[k] - self.src[k]) * t
        # azimuth: take the short way round
        da = (self.dst["sun_azim"] - self.src["sun_azim"] + 180) % 360 - 180
        p["sun_azim"] = self.src["sun_azim"] + da * t
        self.params = p

        rate = 0.12 if p["rain"] > self.wet else 0.025
        self.wet += (p["rain"] - self.wet) * min(1.0, dt * rate * 3)
        wind_dir = np.array([0.8, 0.6], np.float32)
        self.cloud_offset += wind_dir * dt * 0.0022 * p["cloud_speed"]
        self.cloud_offset %= 64.0

    def uniforms(self) -> dict:
        p = self.params
        sun_dir = _direction(p["sun_elev"], p["sun_azim"])
        light_dir = _direction(max(p["sun_elev"], 12.0), p["sun_azim"])
        # below the horizon the "sun" light is really moon / sky light
        return {
            "uSunDir": sun_dir,
            "uLightDir": light_dir,
            "uSunColor": p["sun_color"] * p["sun_int"],
            "uZenith": p["zenith"],
            "uHorizon": p["horizon"],
            "uGroundCol": p["ground"],
            "uSunGlow": p["sun_glow"],
            "uAmbient": p["ambient"],
            "uCloudCover": p["cloud_cover"],
            "uCloudDark": p["cloud_dark"],
            "uCloudOffset": self.cloud_offset,
            "uFogColor": p["fog_color"],
            "uFogDensity": p["fog_density"],
            "uFogTint": p["fog_tint"],
            "uNight": p["night"],
            "uWet": min(self.wet * 1.2, 1.0),
        }

    def post_uniforms(self) -> dict:
        p = self.params
        return {
            "uExposure": p["exposure"],
            "uSaturation": p["saturation"],
            "uContrast": p["contrast"],
            "uGrade": p["grade"],
            "uBloom": 0.6 + 0.8 * p["night"],
        }
