"""Procedurally generated textures (numpy only).

Every texture tiles seamlessly. Arrays are (rows, cols); row 0 is the bottom
of the texture (v = 0), so "downward" features grow toward lower row indices.
Albedo layers store a cavity term in alpha (1 = flat surface, 0 = deep groove).
"""

from __future__ import annotations

import numpy as np

SIZE = 512

# Texture-array layer indices (must match shaders.py).
LAYER_BOARD = 0
LAYER_PANEL = 1
LAYER_ASPHALT = 2
LAYER_PAVING = 3


def value_noise(rng: np.random.Generator, size: int, fx: int, fy: int | None = None) -> np.ndarray:
    """Tileable smooth value noise with fx x fy lattice cells, in [0, 1]."""
    fy = fx if fy is None else fy
    grid = rng.random((fy, fx), dtype=np.float32)
    tx = np.arange(size, dtype=np.float32) * (fx / size)
    ty = np.arange(size, dtype=np.float32) * (fy / size)
    ix0 = tx.astype(np.int32)
    iy0 = ty.astype(np.int32)
    ix1 = (ix0 + 1) % fx
    iy1 = (iy0 + 1) % fy
    sx = tx - ix0
    sy = ty - iy0
    sx = sx * sx * (3 - 2 * sx)
    sy = sy * sy * (3 - 2 * sy)
    g00 = grid[iy0[:, None], ix0[None, :]]
    g10 = grid[iy0[:, None], ix1[None, :]]
    g01 = grid[iy1[:, None], ix0[None, :]]
    g11 = grid[iy1[:, None], ix1[None, :]]
    top = g00 + (g10 - g00) * sx[None, :]
    bot = g01 + (g11 - g01) * sx[None, :]
    return top + (bot - top) * sy[:, None]


def fbm(rng: np.random.Generator, size: int, fx: int, fy: int | None = None,
        octaves: int = 5, gain: float = 0.5) -> np.ndarray:
    fy = fx if fy is None else fy
    total = np.zeros((size, size), np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        mx, my = fx << o, fy << o
        if mx > size or my > size:
            break
        total += amp * value_noise(rng, size, mx, my)
        norm += amp
        amp *= gain
    return total / norm


def stretch(x: np.ndarray) -> np.ndarray:
    """Normalize to [0, 1] using robust percentiles."""
    lo, hi = np.percentile(x, [1, 99])
    return np.clip((x - lo) / (hi - lo + 1e-6), 0, 1).astype(np.float32)


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def wrapped_dist(a: np.ndarray, b: float, period: int) -> np.ndarray:
    d = np.abs(a - b) % period
    return np.minimum(d, period - d)


def disc_mask(size: int, centers: list[tuple[float, float]], radius: float) -> np.ndarray:
    """Soft discs (tileable). centers are (x, y) in pixels."""
    y = np.arange(size, dtype=np.float32)[:, None]
    x = np.arange(size, dtype=np.float32)[None, :]
    out = np.zeros((size, size), np.float32)
    for cx, cy in centers:
        d = np.sqrt(wrapped_dist(x, cx, size) ** 2 + wrapped_dist(y, cy, size) ** 2)
        out = np.maximum(out, 1 - smoothstep(radius - 1.0, radius + 0.8, d))
    return out


def speckles(rng: np.random.Generator, size: int, density: float) -> np.ndarray:
    dots = (rng.random((size, size)) < density).astype(np.float32)
    grown = dots + 0.5 * (np.roll(dots, 1, 0) + np.roll(dots, 1, 1))
    return np.clip(grown, 0, 1)


def normal_map(height: np.ndarray, strength: float) -> np.ndarray:
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * strength
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * strength
    n = np.stack([-dx, -dy, np.ones_like(height)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n


def pack(albedo: np.ndarray, cavity: np.ndarray) -> np.ndarray:
    rgba = np.concatenate([np.clip(albedo, 0, 1), np.clip(cavity, 0, 1)[..., None]], axis=-1)
    return (rgba * 255 + 0.5).astype(np.uint8)


def pack_normal(n: np.ndarray, extra: np.ndarray) -> np.ndarray:
    rgba = np.concatenate([n * 0.5 + 0.5, np.clip(extra, 0, 1)[..., None]], axis=-1)
    return (rgba * 255 + 0.5).astype(np.uint8)


def tint(gray: np.ndarray, rgb: tuple[float, float, float], warmth: np.ndarray) -> np.ndarray:
    base = np.array(rgb, np.float32)
    col = gray[..., None] * base
    col[..., 0] *= 1 + 0.05 * (warmth - 0.5)
    col[..., 2] *= 1 - 0.05 * (warmth - 0.5)
    return col


# --------------------------------------------------------------------------- #
# Individual materials                                                         #
# --------------------------------------------------------------------------- #

def board_formed_concrete(rng: np.random.Generator, size: int = SIZE):
    """4 m x 4 m of board-formed (plank-textured) cast concrete."""
    n_boards = 32
    bh = size // n_boards
    y = np.arange(size)[:, None]
    x = np.arange(size)[None, :]
    row = (y // bh).repeat(size, 1)

    row_tone = rng.normal(0, 0.035, n_boards).astype(np.float32)[row]
    shifts = rng.integers(0, size, n_boards)
    grain_src = value_noise(rng, size, 6, 128) * 0.6 + value_noise(rng, size, 12, 64) * 0.4
    grain = grain_src[y.repeat(size, 1), (x + shifts[row]) % size]
    wobble = fbm(rng, size, 8, 32, octaves=3)

    pos = (y % bh).repeat(size, 1)
    seam = (pos == 0).astype(np.float32)
    fin = (pos == 1).astype(np.float32) * (wobble > 0.45)

    joints = rng.integers(0, size, (n_boards, 2))
    jd = np.minimum(wrapped_dist(x, joints[row, 0], size), wrapped_dist(x, joints[row, 1], size))
    joint = (jd < 1.0).astype(np.float32)

    tie_centers = [(64 + 128 * i + (32 if j % 2 else 0), 48 + 128 * j) for i in range(4) for j in range(4)]
    holes = disc_mask(size, tie_centers, 5.0)
    rims = disc_mask(size, tie_centers, 7.5) - holes

    blotch = stretch(fbm(rng, size, 4, octaves=6))
    warm = fbm(rng, size, 2, octaves=3)
    streak = stretch(value_noise(rng, size, 64, 3) * 0.7 + value_noise(rng, size, 128, 6) * 0.3)
    streak_mask = smoothstep(0.45, 0.8, fbm(rng, size, 3, 2, octaves=3))
    streaks = smoothstep(0.5, 1.0, streak) * streak_mask
    pits = speckles(rng, size, 0.0035)

    g = (0.64 + 0.09 * (blotch - 0.5) + row_tone + 0.07 * (grain - 0.5)
         - 0.13 * streaks - 0.22 * pits - 0.18 * seam - 0.10 * joint - 0.35 * holes - 0.05 * rims)
    albedo = tint(g, (0.97, 0.95, 0.90), warm)

    height = (row_tone * 3 + 0.35 * grain + 0.25 * wobble - 1.0 * seam + 0.5 * fin
              - 0.6 * joint - 1.6 * holes - 0.7 * pits + 0.3 * rims)
    cavity = 1 - np.clip(0.8 * seam + 0.9 * holes + 0.6 * pits + 0.4 * joint, 0, 1)
    rough = 0.85 + 0.1 * grain
    return pack(albedo, cavity), pack_normal(normal_map(height, 1.6), rough)


def precast_panel(rng: np.random.Generator, size: int = SIZE):
    """6 m x 6 m: four 3 m precast panels with seams, tie holes and drip stains."""
    panel = size // 2
    y = np.arange(size)[:, None]
    x = np.arange(size)[None, :]
    px = (x % panel).repeat(size, 0)
    py = (y % panel).repeat(size, 1)
    pidx = ((y // panel) * 2 + (x // panel)).astype(np.int32)

    tone = rng.normal(0, 0.035, 4).astype(np.float32)[pidx]
    seam_d = np.minimum(np.minimum(px, panel - 1 - px), np.minimum(py, panel - 1 - py)).astype(np.float32)
    seam = 1 - smoothstep(0.5, 2.5, seam_d)
    edge_dirt = 1 - smoothstep(2.0, 18.0, seam_d)

    centers = [(ox + a, oy + b) for ox in (0, panel) for oy in (0, panel) for a in (48, panel - 48) for b in (48, panel - 48)]
    holes = disc_mask(size, centers, 5.5)
    plugs = disc_mask(size, centers, 8.0)

    fine = fbm(rng, size, 16, octaves=5)
    blotch = stretch(fbm(rng, size, 3, octaves=6))
    warm = fbm(rng, size, 2, octaves=3)
    pores = speckles(rng, size, 0.006)

    drips = np.zeros((size, size), np.float32)
    drip_noise = value_noise(rng, size, 128, 16)
    for cx, cy in centers:
        length = rng.uniform(40, 160)
        width = rng.uniform(3, 7)
        dx = wrapped_dist(x, cx, size)
        below = (cy - y) % size  # distance downward from the hole
        fade = np.clip(1 - below / length, 0, 1) * (below < length) * (below > 4)
        shape = np.exp(-(dx / width) ** 2) * fade
        drips = np.maximum(drips, shape * (0.6 + 0.4 * drip_noise))

    bottom_stain = (1 - smoothstep(0, 70, py.astype(np.float32))) * smoothstep(0.35, 0.7, fbm(rng, size, 8, 4, octaves=3))
    vertical = smoothstep(0.55, 0.95, value_noise(rng, size, 96, 4)) * smoothstep(0.4, 0.8, fbm(rng, size, 4, 2, 3))

    g = (0.68 + tone + 0.06 * (blotch - 0.5) + 0.04 * (fine - 0.5)
         - 0.12 * drips - 0.10 * bottom_stain - 0.08 * vertical - 0.06 * edge_dirt
         - 0.25 * seam - 0.30 * holes + 0.03 * (plugs - holes) - 0.15 * pores)
    albedo = tint(g, (0.95, 0.95, 0.93), warm)
    height = 0.25 * fine - 1.4 * seam - 1.5 * holes - 0.5 * pores + 0.2 * blotch
    cavity = 1 - np.clip(0.9 * seam + 0.9 * holes + 0.5 * pores, 0, 1)
    rough = 0.7 + 0.2 * fine
    return pack(albedo, cavity), pack_normal(normal_map(height, 1.4), rough)


def asphalt(rng: np.random.Generator, size: int = SIZE):
    """8 m x 8 m of weathered asphalt with tar-sealed cracks."""
    aggregate = rng.random((size, size)).astype(np.float32)
    agg = value_noise(rng, size, 256) * 0.5 + aggregate * 0.5
    patches = stretch(fbm(rng, size, 3, octaves=6))
    patch_mask = smoothstep(0.62, 0.66, fbm(rng, size, 2, octaves=4))
    warm = fbm(rng, size, 2, octaves=3)

    crack_field = fbm(rng, size, 6, octaves=4)
    crack = 1 - smoothstep(0.004, 0.012, np.abs(crack_field - 0.5))
    crack *= smoothstep(0.45, 0.6, fbm(rng, size, 3, octaves=3))
    crack2_field = fbm(rng, size, 10, octaves=3)
    crack2 = (1 - smoothstep(0.003, 0.008, np.abs(crack2_field - 0.5))) * smoothstep(0.55, 0.7, fbm(rng, size, 4, octaves=3))
    tar = np.clip(crack + crack2, 0, 1)
    tar_wide = np.clip(tar + 0.5 * (np.roll(tar, 1, 0) + np.roll(tar, -1, 1)), 0, 1)

    oil = smoothstep(0.6, 0.8, fbm(rng, size, 4, octaves=5)) * 0.7

    g = (0.31 + 0.06 * (patches - 0.5) + 0.10 * (agg - 0.5) + 0.05 * patch_mask
         - 0.10 * tar_wide - 0.06 * oil)
    g = np.maximum(g, 0.05)
    albedo = tint(g, (1.0, 0.99, 0.97), warm)
    height = 0.6 * agg - 1.0 * tar - 0.2 * patch_mask
    cavity = 1 - np.clip(0.8 * tar + 0.3 * (1 - agg), 0, 1)
    rough = 0.75 + 0.2 * agg - 0.35 * oil
    return pack(albedo, cavity), pack_normal(normal_map(height, 1.1), rough)


def paving(rng: np.random.Generator, size: int = SIZE):
    """4 m x 4 m of 50 cm concrete paving slabs."""
    slab = size // 8
    y = np.arange(size)[:, None]
    x = np.arange(size)[None, :]
    sx = (x % slab).repeat(size, 0).astype(np.float32)
    sy = (y % slab).repeat(size, 1).astype(np.float32)
    sid = ((y // slab) * 8 + (x // slab)).astype(np.int32)

    tone = rng.normal(0, 0.025, 64).astype(np.float32)[sid]
    d = np.minimum(np.minimum(sx, slab - 1 - sx), np.minimum(sy, slab - 1 - sy))
    joint = 1 - smoothstep(0.3, 1.8, d)
    bevel = 1 - smoothstep(1.5, 4.0, d)
    dirt = (1 - smoothstep(1.0, 10.0, d)) * fbm(rng, size, 16, octaves=3)

    cracked = (rng.random(64) < 0.12)[sid]
    crack_field = fbm(rng, size, 8, octaves=4)
    crack = (1 - smoothstep(0.004, 0.012, np.abs(crack_field - 0.5))) * cracked

    fine = fbm(rng, size, 32, octaves=4)
    blotch = stretch(fbm(rng, size, 4, octaves=5))
    warm = fbm(rng, size, 2, octaves=3)
    grit = speckles(rng, size, 0.01)

    g = (0.60 + tone + 0.08 * (blotch - 0.5) + 0.05 * (fine - 0.5)
         - 0.35 * joint - 0.10 * dirt - 0.18 * crack - 0.08 * grit)
    albedo = tint(g, (0.96, 0.95, 0.92), warm)
    height = 0.2 * fine - 1.2 * joint - 0.4 * bevel - 0.8 * crack + tone * 2
    cavity = 1 - np.clip(0.9 * joint + 0.6 * crack, 0, 1)
    rough = 0.8 + 0.15 * fine
    return pack(albedo, cavity), pack_normal(normal_map(height, 1.5), rough)


def shader_noise(rng: np.random.Generator, size: int = 256) -> np.ndarray:
    """Utility noise for shaders: R smooth, G low-freq fbm, B medium, A white."""
    r = value_noise(rng, size, 16)
    g = fbm(rng, size, 4, octaves=4)
    b = value_noise(rng, size, 64)
    a = rng.random((size, size)).astype(np.float32)
    rgba = np.stack([stretch(r), stretch(g), stretch(b), a], axis=-1)
    return (rgba * 255 + 0.5).astype(np.uint8)


def generate(seed: int = 7):
    """Returns (albedo_layers, normal_layers, noise) as uint8 arrays."""
    rng = np.random.default_rng(seed)
    makers = [board_formed_concrete, precast_panel, asphalt, paving]
    albedo, normal = zip(*(m(rng) for m in makers))
    return np.stack(albedo), np.stack(normal), shader_noise(rng)
