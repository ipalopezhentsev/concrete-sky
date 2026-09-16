"""Procedurally synthesized ambience: wind, drones, rain and footsteps.

Loops are made by spectral synthesis (random-phase spectra -> inverse FFT),
which makes them seamless by construction.
"""

from __future__ import annotations

import random

import numpy as np

RATE = 44100


def _spectral_noise(rng: np.random.Generator, seconds: float, shape) -> np.ndarray:
    n = int(RATE * seconds)
    freqs = np.fft.rfftfreq(n, 1 / RATE)
    mag = shape(np.maximum(freqs, 1e-3))
    phase = rng.uniform(0, 2 * np.pi, len(freqs))
    spec = mag * np.exp(1j * phase)
    spec[0] = 0
    out = np.fft.irfft(spec, n)
    return out / (np.abs(out).max() + 1e-9)


def _band(lo: float, hi: float, tilt: float = 1.0):
    def shape(f):
        return (f ** -tilt) * np.exp(-((np.log(f / np.sqrt(lo * hi))) / np.log(hi / lo) * 2.2) ** 2)
    return shape


def _stereo(left: np.ndarray, right: np.ndarray, gain: float = 0.9) -> np.ndarray:
    data = np.stack([left, right], axis=1) * gain * 32767
    return np.ascontiguousarray(np.clip(data, -32767, 32767).astype(np.int16))


def _envelope_loop(rng, seconds, rate_hz):
    """Slow, loop-safe modulation in [0, 1]."""
    env = _spectral_noise(rng, seconds, lambda f: np.where(f < rate_hz, 1.0, 0.0))
    return (env - env.min()) / (env.max() - env.min() + 1e-9)


def wind(rng, seconds=16.0):
    chans = []
    for _ in range(2):
        low = _spectral_noise(rng, seconds, _band(60, 500, 0.8))
        whistle = _spectral_noise(rng, seconds, _band(700, 1400, 0.2)) * 0.18
        gust = _envelope_loop(rng, seconds, 0.35)
        chans.append((low * (0.35 + 0.65 * gust) + whistle * gust ** 2) * 0.8)
    return _stereo(*chans)


def drone(rng, seconds=24.0, dark=False):
    t = np.arange(int(RATE * seconds)) / RATE
    base = 55.0
    ratios = [1, 1.5, 2, 3, 4.5] if not dark else [1, 1.189, 1.414, 2, 2.828]
    chans = []
    for side in range(2):
        s = np.zeros_like(t)
        for i, r in enumerate(ratios):
            # snap every partial to complete a whole number of cycles in the loop
            f = round(base * r * seconds) / seconds
            detune = round((base * r + (0.15 + 0.1 * i) * (1 if side else -1)) * seconds) / seconds
            amp = 0.5 / (1 + i)
            lfo = 0.5 + 0.5 * np.sin(2 * np.pi * t * (i + 1) / seconds + rng.uniform(0, 6.28))
            s += amp * (np.sin(2 * np.pi * f * t) + np.sin(2 * np.pi * detune * t)) * (0.4 + 0.6 * lfo)
        air = _spectral_noise(rng, seconds, _band(200, 900, 0.5)) * 0.08
        s = s / np.abs(s).max() + air
        chans.append(s * 0.7)
    return _stereo(*chans)


def rain(rng, seconds=8.0):
    chans = []
    n = int(RATE * seconds)
    for _ in range(2):
        hiss = _spectral_noise(rng, seconds, _band(1500, 9000, 0.3)) * 0.5
        body = _spectral_noise(rng, seconds, _band(300, 1500, 0.6)) * 0.3
        drops = np.zeros(n)
        for _ in range(int(seconds * 90)):
            pos = rng.integers(0, n)
            length = rng.integers(60, 300)
            env = np.exp(-np.arange(length) / (length / 5))
            tone = np.sin(np.arange(length) * rng.uniform(0.2, 0.8))
            idx = (pos + np.arange(length)) % n
            drops[idx] += env * tone * rng.uniform(0.1, 0.5)
        chans.append(hiss + body + drops * 0.6)
    return _stereo(*chans)


def footstep(rng, variant: int):
    n = int(RATE * 0.22)
    t = np.arange(n) / RATE
    scuff = _spectral_noise(rng, 0.22, _band(800, 5000, 0.4))
    thump = np.sin(2 * np.pi * (70 + 15 * variant) * t) * np.exp(-t * 40)
    grit = scuff * np.exp(-t * (28 + 6 * variant)) * 0.6
    attack = np.minimum(t / 0.003, 1.0)
    s = (thump * 0.9 + grit) * attack
    s /= np.abs(s).max()
    pan = 0.15 if variant % 2 else -0.15
    return _stereo(s * (1 - pan), s * (1 + pan), 0.8)


def landing(rng):
    n = int(RATE * 0.5)
    t = np.arange(n) / RATE
    s = np.sin(2 * np.pi * 48 * t) * np.exp(-t * 14)
    s += _spectral_noise(rng, 0.5, _band(200, 3000, 0.6)) * np.exp(-t * 22) * 0.7
    s /= np.abs(s).max()
    return _stereo(s, s, 0.9)


class Audio:
    def __init__(self):
        self.ok = False
        try:
            import pygame
            self.pg = pygame
            pygame.mixer.init(RATE, -16, 2, 1024)
            pygame.mixer.set_num_channels(16)
            rng = np.random.default_rng(42)
            snd = pygame.sndarray.make_sound
            self.loops = {
                "wind": snd(wind(rng)),
                "drone": snd(drone(rng)),
                "drone_dark": snd(drone(rng, dark=True)),
                "rain": snd(rain(rng)),
            }
            self.steps = [snd(footstep(rng, i)) for i in range(4)]
            self.land = snd(landing(rng))
            self.channels = {}
            for i, (name, sound) in enumerate(self.loops.items()):
                ch = pygame.mixer.Channel(i)
                ch.play(sound, loops=-1)
                ch.set_volume(0.0)
                self.channels[name] = ch
            pygame.mixer.set_reserved(len(self.loops))
            self.volumes = {k: 0.0 for k in self.loops}
            self.ok = True
        except Exception as exc:  # audio is optional
            print(f"audio disabled: {exc}")

    def update(self, dt: float, params: dict, speed_norm: float, altitude: float) -> None:
        if not self.ok:
            return
        gloom = params["gloom"]
        targets = {
            "wind": 0.12 + 0.35 * params["wind"] + 0.25 * speed_norm + min(altitude / 60.0, 0.3),
            "drone": 0.22 * (1 - gloom),
            "drone_dark": 0.26 * gloom,
            "rain": 0.55 * params["rain"],
        }
        for name, target in targets.items():
            v = self.volumes[name]
            v += (min(target, 1.0) - v) * min(1.0, dt * 0.8)
            self.volumes[name] = v
            self.channels[name].set_volume(v)

    def step(self, speed_norm: float, wet: float) -> None:
        if not self.ok:
            return
        s = random.choice(self.steps)
        ch = s.play()
        if ch is not None:
            ch.set_volume(0.15 + 0.3 * speed_norm + 0.1 * wet)

    def landing(self, strength: float) -> None:
        if not self.ok:
            return
        ch = self.land.play()
        if ch is not None:
            ch.set_volume(0.2 + 0.6 * strength)
