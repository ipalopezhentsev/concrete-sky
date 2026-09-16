"""Deterministic, infinite brutalist city built entirely from boxes.

The world is a grid of cells (CELL x CELL metres). Streets run along the cell
borders; every cell holds one block. Cells are grouped into regions, which are
the unit of mesh generation and drawing.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

import numpy as np

CELL = 88.0
STREET = 18.0
REGION_CELLS = 3
REGION = CELL * REGION_CELLS
LAMP_HEIGHT = 7.2
WORLD_SEED = 1971

# Materials (must match shaders.py).
M_ASPHALT, M_PAVING, M_BOARD, M_PANEL, M_WINDOWS, M_LAMP, M_METAL, M_BEACON = range(8)

# Window styles.
W_PUNCHED, W_RIBBON, W_SLIT, W_GRID = range(4)

FLOOR = 3.4

CONCRETE_TINTS = [
    (1.00, 1.00, 1.00),
    (0.92, 0.93, 0.95),
    (1.03, 1.00, 0.95),
    (0.85, 0.85, 0.86),
    (1.02, 0.97, 0.93),
    (0.78, 0.79, 0.80),
    (1.06, 1.05, 1.02),
]

_MASK = (1 << 64) - 1


def hash_int(*values: int) -> int:
    h = (0x9E3779B97F4A7C15 ^ WORLD_SEED) & _MASK
    for v in values:
        h ^= v & _MASK
        h = (h * 0xBF58476D1CE4E5B9) & _MASK
        h ^= h >> 31
        h = (h * 0x94D049BB133111EB) & _MASK
        h ^= h >> 29
    return h


def lamp_heads_local() -> list[tuple[float, float]]:
    """Lamp head (x, z) positions in cell-local coordinates (shared with shader)."""
    s = STREET / 2
    over = s + 0.6 - 1.6  # post at curb, arm reaches over the street
    far = CELL - over
    a, b = CELL * 0.3, CELL * 0.7
    return [(over, a), (over, b), (far, a), (far, b), (a, over), (b, over), (a, far), (b, far)]


@dataclass
class Builder:
    boxes: list = field(default_factory=list)
    solid: list = field(default_factory=list)  # flags whether a box collides

    def box(self, x0, y0, z0, x1, y1, z1, mat, tint=(1, 1, 1), style=0, seed=None, collide=True):
        if x1 - x0 < 1e-3 or y1 - y0 < 1e-3 or z1 - z0 < 1e-3:
            return
        if seed is None:
            seed = random.random()
        self.boxes.append((x0, y0, z0, x1, y1, z1, *tint, mat, style, seed))
        self.solid.append(collide)


# --------------------------------------------------------------------------- #
# Building archetypes. Each gets a lot rectangle (x0, z0, x1, z1).             #
# --------------------------------------------------------------------------- #

def _tint(r: random.Random):
    return r.choice(CONCRETE_TINTS)


def _beacon(b: Builder, cx, top, cz):
    b.box(cx - 0.35, top, cz - 0.35, cx + 0.35, top + 0.7, cz + 0.35, M_BEACON, collide=False)


def _fins_x(b: Builder, r, x0, x1, z, y0, y1, depth, tint):
    """Vertical fins along a facade parallel to X, protruding toward sign(depth)."""
    spacing = r.choice([2.4, 3.2, 4.0])
    n = int((x1 - x0) / spacing)
    for i in range(1, n):
        x = x0 + i * (x1 - x0) / n
        za, zb = sorted((z, z + depth))
        b.box(x - 0.2, y0, za, x + 0.2, y1, zb, M_BOARD, tint)


def _fins_z(b: Builder, r, z0, z1, x, y0, y1, depth, tint):
    spacing = r.choice([2.4, 3.2, 4.0])
    n = int((z1 - z0) / spacing)
    for i in range(1, n):
        z = z0 + i * (z1 - z0) / n
        xa, xb = sorted((x, x + depth))
        b.box(xa, y0, z - 0.2, xb, y1, z + 0.2, M_BOARD, tint)


def _bands(b: Builder, x0, z0, x1, z1, y0, y1, every, tint, out=0.8):
    y = y0 + every
    while y < y1 - 1:
        b.box(x0 - out, y - 0.35, z0 - out, x1 + out, y + 0.35, z1 + out, M_PANEL, tint)
        y += every


def slab_tower(b: Builder, r: random.Random, lot):
    lx0, lz0, lx1, lz1 = lot
    tint = _tint(r)
    w, d = r.uniform(18, 30), r.uniform(14, 22)
    if r.random() < 0.5:
        w, d = d, w
    h = r.choice([r.uniform(40, 70), r.uniform(60, 110), r.uniform(90, 150)])
    cx = r.uniform(lx0 + w / 2 + 2, lx1 - w / 2 - 2)
    cz = r.uniform(lz0 + d / 2 + 2, lz1 - d / 2 - 2)
    x0, x1, z0, z1 = cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2
    base = r.choice([6.0, 7.5, 9.0])
    style = r.choice([W_PUNCHED, W_RIBBON, W_GRID, W_PUNCHED])

    # pilotis
    nx, nz = max(2, int(w / 7)), max(2, int(d / 7))
    for i in range(nx + 1):
        for j in range(nz + 1):
            if 0 < i < nx and 0 < j < nz:
                continue
            px = x0 + 1.2 + i * (w - 2.4) / nx
            pz = z0 + 1.2 + j * (d - 2.4) / nz
            b.box(px - 0.8, 0, pz - 0.8, px + 0.8, base, pz + 0.8, M_BOARD, tint)
    core_w = min(w, d) * 0.3
    b.box(cx - core_w, 0, cz - core_w / 2, cx + core_w, base, cz + core_w / 2, M_PANEL, tint)
    # transfer slab + body
    b.box(x0 - 0.6, base - 1.4, z0 - 0.6, x1 + 0.6, base, z1 + 0.6, M_BOARD, tint)
    b.box(x0, base, z0, x1, h, z1, M_WINDOWS, tint, style)
    decor = r.random()
    if decor < 0.35:
        _fins_x(b, r, x0, x1, z0, base, h - 2, -1.1, tint)
        _fins_x(b, r, x0, x1, z1, base, h - 2, 1.1, tint)
    elif decor < 0.7:
        _bands(b, x0, z0, x1, z1, base, h - 2, FLOOR * r.choice([2, 3]), tint)
    # service shafts
    if r.random() < 0.7:
        sw = r.uniform(3, 5)
        b.box(x0 - sw, 0, cz - sw / 2, x0, h + r.uniform(3, 9), cz + sw / 2, M_BOARD, tint)
    if r.random() < 0.5:
        sw = r.uniform(3, 5)
        b.box(x1, 0, cz - sw / 2, x1 + sw, h + r.uniform(3, 9), cz + sw / 2, M_BOARD, tint)
    # crown
    over = r.uniform(0.8, 2.5)
    ch = r.uniform(3, 7)
    b.box(x0 - over, h, z0 - over, x1 + over, h + ch, z1 + over, M_BOARD, tint)
    top = h + ch
    if r.random() < 0.6:
        top += r.uniform(4, 10)
        b.box(cx - w * 0.2, h + ch, cz - d * 0.2, cx + w * 0.2, top, cz + d * 0.2, M_PANEL, tint)
    _beacon(b, cx, top, cz)
    # podium
    if r.random() < 0.6:
        ph = r.choice([2.0, 3.5, 5.0])
        px0, px1 = lx0, r.uniform(lx0 + 10, lx1)
        pz0, pz1 = r.uniform(lz0, lz1 - 12), lz1
        if not (px1 > x0 and px0 < x1 and pz1 > z0 and pz0 < z1):
            b.box(px0, 0.18, pz0, px1, ph, pz1, M_WINDOWS, tint, W_RIBBON)
            b.box(px0 - 0.4, ph, pz0 - 0.4, px1 + 0.4, ph + 1.1, pz1 + 0.4, M_BOARD, tint)


def ziggurat(b: Builder, r: random.Random, lot):
    lx0, lz0, lx1, lz1 = lot
    tint = _tint(r)
    x0, z0, x1, z1 = lx0 + r.uniform(0, 6), lz0 + r.uniform(0, 6), lx1 - r.uniform(0, 6), lz1 - r.uniform(0, 6)
    levels = r.randint(4, 10)
    y = 0.18
    step = r.uniform(2.5, 5.0)
    sides = r.choice([(1, 0, 0, 0), (1, 0, 1, 0), (1, 1, 0, 0), (1, 1, 1, 1), (0, 1, 0, 1)])
    style = r.choice([W_RIBBON, W_GRID, W_PUNCHED])
    for _ in range(levels):
        if x1 - x0 < 8 or z1 - z0 < 8:
            break
        lh = FLOOR * r.choice([1, 2, 2, 3])
        b.box(x0, y, z0, x1, y + lh, z1, M_WINDOWS, tint, style)
        y += lh
        b.box(x0, y, z0, x1, y + 0.5, z1, M_BOARD, tint)
        nx0 = x0 + step * sides[0]
        nz0 = z0 + step * sides[1]
        nx1 = x1 - step * sides[2]
        nz1 = z1 - step * sides[3]
        # parapets on exposed terrace edges
        if sides[0]:
            b.box(x0, y, z0, x0 + 0.4, y + 1.1, z1, M_BOARD, tint)
        if sides[1]:
            b.box(x0, y, z0, x1, y + 1.1, z0 + 0.4, M_BOARD, tint)
        if sides[2]:
            b.box(x1 - 0.4, y, z0, x1, y + 1.1, z1, M_BOARD, tint)
        if sides[3]:
            b.box(x0, y, z1 - 0.4, x1, y + 1.1, z1, M_BOARD, tint)
        x0, z0, x1, z1 = nx0, nz0, nx1, nz1
        y += 0.5
    # stair / lift towers against the stepped mass
    for _ in range(r.randint(0, 2)):
        tx = r.uniform(lot[0] + 2, lot[2] - 6)
        tz = r.choice([lot[1] + 1, lot[3] - 6])
        b.box(tx, 0, tz, tx + 5, y + r.uniform(2, 8), tz + 5, M_BOARD, tint)


def megastructure(b: Builder, r: random.Random, lot):
    lx0, lz0, lx1, lz1 = lot
    tint = _tint(r)
    lift = r.uniform(14, 26)
    thick = FLOOR * r.choice([2, 3])
    x0, z0, x1, z1 = lx0 - 2, lz0 + r.uniform(4, 14), lx1 + 2, lz1 - r.uniform(4, 14)
    if r.random() < 0.5:
        x0, z0, x1, z1 = lx0 + r.uniform(4, 14), lz0 - 2, lx1 - r.uniform(4, 14), lz1 + 2
    # piers
    pw = r.uniform(3, 5)
    long_x = (x1 - x0) > (z1 - z0)
    n = r.randint(2, 3)
    for i in range(n):
        t = (i + 0.5) / n
        # each pier is a wall with a tall arch-like opening in its middle
        if long_x:
            px = x0 + t * (x1 - x0)
            a0, a1, mid = z0 + 2, z1 - 2, (z0 + z1) / 2
            b.box(px - pw / 2, 0, a0, px + pw / 2, lift, mid - 5, M_BOARD, tint)
            b.box(px - pw / 2, 0, mid + 5, px + pw / 2, lift, a1, M_BOARD, tint)
            b.box(px - pw / 2, lift - 5, mid - 5, px + pw / 2, lift, mid + 5, M_BOARD, tint)
        else:
            pz = z0 + t * (z1 - z0)
            a0, a1, mid = x0 + 2, x1 - 2, (x0 + x1) / 2
            b.box(a0, 0, pz - pw / 2, mid - 5, lift, pz + pw / 2, M_BOARD, tint)
            b.box(mid + 5, 0, pz - pw / 2, a1, lift, pz + pw / 2, M_BOARD, tint)
            b.box(mid - 5, lift - 5, pz - pw / 2, mid + 5, lift, pz + pw / 2, M_BOARD, tint)
    b.box(x0, lift, z0, x1, lift + thick, z1, M_WINDOWS, tint, r.choice([W_RIBBON, W_GRID]))
    b.box(x0 - 1, lift + thick, z0 - 1, x1 + 1, lift + thick + 1.5, z1 + 1, M_BOARD, tint)
    y = lift + thick + 1.5
    # blocks on top
    for _ in range(r.randint(1, 3)):
        w, d = r.uniform(8, 18), r.uniform(8, 18)
        bx = r.uniform(x0 + 1, max(x0 + 1, x1 - w - 1))
        bz = r.uniform(z0 + 1, max(z0 + 1, z1 - d - 1))
        h = r.uniform(6, 40)
        b.box(bx, y, bz, bx + w, y + h, bz + d, M_WINDOWS, tint, r.choice([W_PUNCHED, W_SLIT]))
        b.box(bx - 0.6, y + h, bz - 0.6, bx + w + 0.6, y + h + 1.5, bz + d + 0.6, M_BOARD, tint)
    # ground-level kiosks beneath
    for _ in range(r.randint(0, 3)):
        kx, kz = r.uniform(lx0, lx1 - 6), r.uniform(lz0, lz1 - 6)
        b.box(kx, 0.18, kz, kx + r.uniform(3, 6), r.uniform(2.5, 3.5), kz + r.uniform(3, 6), M_PANEL, tint)


def inverted_ziggurat(b: Builder, r: random.Random, lot):
    """Levels that grow outward as they rise (Boston City Hall / Geisel vibes)."""
    lx0, lz0, lx1, lz1 = lot
    tint = _tint(r)
    cx, cz = (lx0 + lx1) / 2 + r.uniform(-5, 5), (lz0 + lz1) / 2 + r.uniform(-5, 5)
    hw, hd = r.uniform(6, 10), r.uniform(6, 10)
    # stem
    b.box(cx - hw, 0, cz - hd, cx + hw, 8, cz + hd, M_BOARD, tint)
    y = 8.0
    grow = r.uniform(1.5, 3.5)
    style = r.choice([W_SLIT, W_GRID, W_PUNCHED])
    for i in range(r.randint(3, 6)):
        hw = min(hw + grow, (lx1 - lx0) / 2 + 3)
        hd = min(hd + grow, (lz1 - lz0) / 2 + 3)
        lh = FLOOR * r.choice([1, 2])
        b.box(cx - hw, y, cz - hd, cx + hw, y + lh, cz + hd, M_WINDOWS, tint, style)
        b.box(cx - hw - 0.3, y - 0.6, cz - hd - 0.3, cx + hw + 0.3, y, cz + hd + 0.3, M_BOARD, tint)
        y += lh
    b.box(cx - hw - 1, y, cz - hd - 1, cx + hw + 1, y + r.uniform(3, 6), cz + hd + 1, M_BOARD, tint)
    # external columns
    for sx in (-1, 1):
        for sz in (-1, 1):
            b.box(cx + sx * (hw - 1.5) - 0.7, 0, cz + sz * (hd - 1.5) - 0.7,
                  cx + sx * (hw - 1.5) + 0.7, y, cz + sz * (hd - 1.5) + 0.7, M_BOARD, tint)


def cluster(b: Builder, r: random.Random, lot):
    """Stacked, offset modules (Habitat 67 / capsule tower vibes)."""
    lx0, lz0, lx1, lz1 = lot
    tint = _tint(r)
    n = 6
    cw = (lx1 - lx0) / n
    cd = (lz1 - lz0) / n
    peak = r.uniform(20, 60)
    for i in range(n):
        for j in range(n):
            u = (i + 0.5) / n - 0.5
            v = (j + 0.5) / n - 0.5
            top = peak * max(0.0, 1 - 1.6 * math.hypot(u, v)) + r.uniform(-6, 6)
            if top < 4 or r.random() < 0.15:
                continue
            y = 0.18
            while y < top:
                h = FLOOR * r.choice([1, 1, 2])
                ox, oz = r.uniform(-2.5, 2.5), r.uniform(-2.5, 2.5)
                x0 = lx0 + i * cw + ox
                z0 = lz0 + j * cd + oz
                if r.random() < 0.5:
                    x1, z1 = x0 + cw * r.uniform(1.0, 1.6), z0 + cd * 0.8
                else:
                    x1, z1 = x0 + cw * 0.8, z0 + cd * r.uniform(1.0, 1.6)
                mat = M_WINDOWS if r.random() < 0.75 else M_BOARD
                b.box(x0, y, z0, x1, y + h, z1, mat, tint, r.choice([W_PUNCHED, W_SLIT, W_GRID]))
                y += h
    b.box((lx0 + lx1) / 2 - 3, 0, (lz0 + lz1) / 2 - 3, (lx0 + lx1) / 2 + 3, peak + 10,
          (lz0 + lz1) / 2 + 3, M_BOARD, tint)


def plaza(b: Builder, r: random.Random, lot):
    lx0, lz0, lx1, lz1 = lot
    tint = _tint(r)
    cx, cz = (lx0 + lx1) / 2, (lz0 + lz1) / 2
    kind = r.random()
    if kind < 0.4:
        # stepped amphitheatre / pyramid - good for running up
        steps = r.randint(6, 14)
        half = min(lx1 - lx0, lz1 - lz0) / 2 - 2
        for s in range(steps):
            hh = half - s * r.uniform(1.4, 1.6) if s else half
            if hh < 3:
                break
            b.box(cx - hh, 0.18, cz - hh, cx + hh, 0.18 + 0.45 * (s + 1), cz + hh, M_PAVING, tint)
        top = 0.18 + 0.45 * steps
        b.box(cx - 1.5, top, cz - 1.5, cx + 1.5, top + r.uniform(12, 30), cz + 1.5, M_BOARD, tint)
    elif kind < 0.7:
        # monoliths
        for _ in range(r.randint(1, 3)):
            w, d = r.uniform(2, 5), r.uniform(8, 18)
            if r.random() < 0.5:
                w, d = d, w
            mx, mz = r.uniform(lx0 + 2, lx1 - w - 2), r.uniform(lz0 + 2, lz1 - d - 2)
            b.box(mx, 0, mz, mx + w, r.uniform(15, 45), mz + d, M_BOARD, tint)
        for _ in range(r.randint(3, 8)):
            bx, bz = r.uniform(lx0, lx1 - 4), r.uniform(lz0, lz1 - 1)
            b.box(bx, 0.18, bz, bx + r.uniform(2, 6), 0.65, bz + r.uniform(0.8, 1.5), M_BOARD, tint)
    else:
        # raised deck with a pergola of heavy beams
        dh = r.choice([0.9, 1.35, 1.8])
        b.box(lx0 + 3, 0.18, lz0 + 3, lx1 - 3, dh, lz1 - 3, M_PAVING, tint)
        # stairs up to the deck on all four sides
        n_steps = int(round((dh - 0.18) / 0.45))
        for s in range(n_steps):
            top, depth = dh - 0.45 * s, 0.6 * (s + 1)
            b.box(lx0 + 3 - depth, 0.18, cz - 4, lx0 + 3, top, cz + 4, M_PAVING, tint)
            b.box(lx1 - 3, 0.18, cz - 4, lx1 - 3 + depth, top, cz + 4, M_PAVING, tint)
            b.box(cx - 4, 0.18, lz0 + 3 - depth, cx + 4, top, lz0 + 3, M_PAVING, tint)
            b.box(cx - 4, 0.18, lz1 - 3, cx + 4, top, lz1 - 3 + depth, M_PAVING, tint)
        span = r.uniform(5, 7)
        top = dh + r.uniform(4.5, 6.5)
        x = lx0 + 6
        while x < lx1 - 5:
            for zc in (lz0 + 6, lz1 - 6):
                b.box(x - 0.5, dh, zc - 0.5, x + 0.5, top, zc + 0.5, M_BOARD, tint)
            b.box(x - 0.4, top, lz0 + 5, x + 0.4, top + 1.2, lz1 - 5, M_BOARD, tint)
            x += span
        b.box(lx0 + 5, top + 1.2, lz0 + 5.5, lx1 - 5, top + 1.8, lz0 + 6.5, M_BOARD, tint)
        b.box(lx0 + 5, top + 1.2, lz1 - 6.5, lx1 - 5, top + 1.8, lz1 - 5.5, M_BOARD, tint)


def twin_towers(b: Builder, r: random.Random, lot):
    lx0, lz0, lx1, lz1 = lot
    tint = _tint(r)
    w = r.uniform(12, 18)
    h1, h2 = r.uniform(50, 130), r.uniform(50, 130)
    style = r.choice([W_SLIT, W_PUNCHED, W_GRID])
    along_x = r.random() < 0.5
    cz = (lz0 + lz1) / 2
    cx = (lx0 + lx1) / 2
    if along_x:
        a = (lx0 + 1, cz - w / 2, lx0 + 1 + w, cz + w / 2)
        c = (lx1 - 1 - w, cz - w / 2, lx1 - 1, cz + w / 2)
    else:
        a = (cx - w / 2, lz0 + 1, cx + w / 2, lz0 + 1 + w)
        c = (cx - w / 2, lz1 - 1 - w, cx + w / 2, lz1 - 1)
    for (x0, z0, x1, z1), h in ((a, h1), (c, h2)):
        b.box(x0 + 2, 0, z0 + 2, x1 - 2, 5, z1 - 2, M_BOARD, tint)
        b.box(x0, 5, z0, x1, h, z1, M_WINDOWS, tint, style)
        b.box(x0 - 1, h, z0 - 1, x1 + 1, h + 4, z1 + 1, M_BOARD, tint)
        _beacon(b, (x0 + x1) / 2, h + 4, (z0 + z1) / 2)
    top = min(h1, h2)
    for _ in range(r.randint(1, 3)):
        y = r.uniform(12, top - 6)
        if along_x:
            b.box(a[2], y, cz - 2.5, c[0], y + 4, cz + 2.5, M_WINDOWS, tint, W_RIBBON)
        else:
            b.box(cx - 2.5, y, a[3], cx + 2.5, y + 4, c[1], M_WINDOWS, tint, W_RIBBON)


def monolith_block(b: Builder, r: random.Random, lot):
    lx0, lz0, lx1, lz1 = lot
    tint = _tint(r)
    h = r.uniform(25, 55)
    inset = r.uniform(2, 8)
    x0, z0, x1, z1 = lx0 + inset, lz0 + inset, lx1 - inset, lz1 - inset
    b.box(x0 + 4, 0, z0 + 4, x1 - 4, 4.5, z1 - 4, M_METAL, tint)
    b.box(x0, 4.5, z0, x1, h, z1, M_WINDOWS, tint, W_SLIT)
    top_over = r.uniform(2, 5)
    b.box(x0 - top_over, h, z0 - top_over, x1 + top_over, h + r.uniform(5, 9), z1 + top_over, M_BOARD, tint)
    # buttresses
    n = r.randint(3, 6)
    for i in range(n):
        t = x0 + (i + 0.5) * (x1 - x0) / n
        b.box(t - 0.8, 0, z0 - 2.5, t + 0.8, h, z0, M_BOARD, tint)
        b.box(t - 0.8, 0, z1, t + 0.8, h, z1 + 2.5, M_BOARD, tint)


ARCHETYPES = [
    (slab_tower, 5),
    (ziggurat, 3),
    (megastructure, 2),
    (inverted_ziggurat, 2),
    (cluster, 2),
    (plaza, 2),
    (twin_towers, 2),
    (monolith_block, 2),
]


def build_cell(ci: int, cj: int, b: Builder) -> None:
    r = random.Random(hash_int(ci, cj, 1))
    random.seed(hash_int(ci, cj, 2))
    ox, oz = ci * CELL, cj * CELL
    s = STREET / 2
    bx0, bz0, bx1, bz1 = ox + s, oz + s, ox + CELL - s, oz + CELL - s

    # sidewalk plinth
    b.box(bx0, 0, bz0, bx1, 0.18, bz1, M_PAVING, seed=0.0)

    # street lamps: post at curb, arm over the street, emissive head
    heads = lamp_heads_local()
    for i, (hx, hz) in enumerate(heads):
        wx, wz = ox + hx, oz + hz
        if i < 4:
            dirx = 1 if i < 2 else -1
            px, pz = wx + dirx * 1.6, wz
            b.box(px - 0.12, 0.18, pz - 0.12, px + 0.12, LAMP_HEIGHT + 0.3, pz + 0.12, M_METAL)
            b.box(min(px, wx) - 0.2, LAMP_HEIGHT + 0.1, pz - 0.06, max(px, wx) + 0.2, LAMP_HEIGHT + 0.3, pz + 0.06,
                  M_METAL, collide=False)
            b.box(wx - 0.5, LAMP_HEIGHT - 0.05, wz - 0.18, wx + 0.5, LAMP_HEIGHT + 0.1, wz + 0.18, M_LAMP, collide=False)
        else:
            dirz = 1 if i < 6 else -1
            px, pz = wx, wz + dirz * 1.6
            b.box(px - 0.12, 0.18, pz - 0.12, px + 0.12, LAMP_HEIGHT + 0.3, pz + 0.12, M_METAL)
            b.box(px - 0.06, LAMP_HEIGHT + 0.1, min(pz, wz) - 0.2, px + 0.06, LAMP_HEIGHT + 0.3, max(pz, wz) + 0.2,
                  M_METAL, collide=False)
            b.box(wx - 0.18, LAMP_HEIGHT - 0.05, wz - 0.5, wx + 0.18, LAMP_HEIGHT + 0.1, wz + 0.5, M_LAMP, collide=False)

    lot = (bx0 + 4, bz0 + 4, bx1 - 4, bz1 - 4)
    if ci == 0 and cj == 0:
        plaza(b, r, lot)
    else:
        total = sum(w for _, w in ARCHETYPES)
        pick = r.uniform(0, total)
        for fn, w in ARCHETYPES:
            pick -= w
            if pick <= 0:
                fn(b, r, lot)
                break

    # skybridge across the street to the east / north neighbour
    if hash_int(ci, cj, 3) % 100 < 22:
        y = r.uniform(10, 40)
        z = r.uniform(bz0 + 8, bz1 - 12)
        b.box(bx1 - 6, y, z, bx1 + STREET + 6, y + 4, z + 4.5, M_WINDOWS, _tint(r), W_RIBBON)
        b.box(bx1 - 6, y - 0.8, z - 0.4, bx1 + STREET + 6, y, z + 4.9, M_BOARD, _tint(r))
    if hash_int(ci, cj, 4) % 100 < 18:
        y = r.uniform(10, 40)
        x = r.uniform(bx0 + 8, bx1 - 12)
        b.box(x, y, bz1 - 6, x + 4.5, y + 4, bz1 + STREET + 6, M_WINDOWS, _tint(r), W_RIBBON)
        b.box(x - 0.4, y - 0.8, bz1 - 6, x + 4.9, y, bz1 + STREET + 6, M_BOARD, _tint(r))

    # elevated expressways along the street lines through this cell
    if hash_int(ci, 7) % 5 == 0:
        _expressway_z(b, ox, oz, 12.0)
    if hash_int(cj, 8) % 5 == 0:
        _expressway_x(b, ox, oz, 19.0)


def _expressway_z(b: Builder, x: float, oz: float, h: float):
    t = (0.97, 0.97, 0.98)
    b.box(x - 6.5, h, oz, x + 6.5, h + 1.6, oz + CELL, M_BOARD, t, seed=0.3)
    b.box(x - 6.5, h + 1.6, oz, x - 6.0, h + 2.7, oz + CELL, M_PANEL, t, seed=0.3)
    b.box(x + 6.0, h + 1.6, oz, x + 6.5, h + 2.7, oz + CELL, M_PANEL, t, seed=0.3)
    for pz in (oz + 26, oz + 62):
        b.box(x - 0.9, 0, pz - 0.9, x + 0.9, h, pz + 0.9, M_BOARD, t, seed=0.5)
        b.box(x - 4.5, h - 1.4, pz - 1.0, x + 4.5, h, pz + 1.0, M_BOARD, t, seed=0.5)


def _expressway_x(b: Builder, ox: float, z: float, h: float):
    t = (0.95, 0.95, 0.96)
    b.box(ox, h, z - 6.5, ox + CELL, h + 1.6, z + 6.5, M_BOARD, t, seed=0.6)
    b.box(ox, h + 1.6, z - 6.5, ox + CELL, h + 2.7, z - 6.0, M_PANEL, t, seed=0.6)
    b.box(ox, h + 1.6, z + 6.0, ox + CELL, h + 2.7, z + 6.5, M_PANEL, t, seed=0.6)
    for px in (ox + 26, ox + 62):
        b.box(px - 0.9, 0, z - 0.9, px + 0.9, h, z + 0.9, M_BOARD, t, seed=0.2)
        b.box(px - 1.0, h - 1.4, z - 4.5, px + 1.0, h, z + 4.5, M_BOARD, t, seed=0.2)


# --------------------------------------------------------------------------- #
# Mesh assembly                                                                #
# --------------------------------------------------------------------------- #

# Each face: 4 corners as (xsel, ysel, zsel) with 0 = min / 1 = max, CCW from
# outside in order bottom-left, bottom-right, top-right, top-left; plus normal
# and which box extents give (width, height) of the face.
_FACES = [
    (((1, 0, 1), (1, 0, 0), (1, 1, 0), (1, 1, 1)), (1, 0, 0), (2, 1)),
    (((0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)), (-1, 0, 0), (2, 1)),
    (((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)), (0, 0, 1), (0, 1)),
    (((1, 0, 0), (0, 0, 0), (0, 1, 0), (1, 1, 0)), (0, 0, -1), (0, 1)),
    (((0, 1, 1), (1, 1, 1), (1, 1, 0), (0, 1, 0)), (0, 1, 0), (0, 2)),
    (((1, 0, 1), (0, 0, 1), (0, 0, 0), (1, 0, 0)), (0, -1, 0), (0, 2)),
]
_CORNER_UV = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float32)

VERTEX_LAYOUT = [3, 3, 2, 2, 3, 3]  # pos, normal, uv(m), face size(m), tint, (material, style, seed)
FLOATS_PER_VERTEX = sum(VERTEX_LAYOUT)


def boxes_to_mesh(boxes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """boxes: (N, 12) float32 -> (vertices (N*24, 16), indices (N*36,))."""
    n = len(boxes)
    lo = boxes[:, 0:3]
    hi = boxes[:, 3:6]
    ext = hi - lo
    rest = boxes[:, 6:12]
    faces = []
    for corners, normal, (wa, ha) in _FACES:
        sel = np.array(corners, np.float32)  # (4, 3)
        pos = lo[:, None, :] + sel[None, :, :] * ext[:, None, :]  # (N, 4, 3)
        size = np.stack([ext[:, wa], ext[:, ha]], axis=1)  # (N, 2)
        uv = _CORNER_UV[None, :, :] * size[:, None, :]
        nrm = np.broadcast_to(np.array(normal, np.float32), (n, 4, 3))
        sz = np.broadcast_to(size[:, None, :], (n, 4, 2))
        rs = np.broadcast_to(rest[:, None, :], (n, 4, 6))
        faces.append(np.concatenate([pos, nrm, uv, sz, rs], axis=2))
    verts = np.stack(faces, axis=1).reshape(-1, FLOATS_PER_VERTEX).astype(np.float32)
    base = (np.arange(n * 6, dtype=np.uint32) * 4)[:, None]
    quad = np.array([0, 1, 2, 0, 2, 3], np.uint32)[None, :]
    indices = (base + quad).reshape(-1)
    return verts, indices


@dataclass
class RegionData:
    rx: int
    rz: int
    vertices: np.ndarray
    indices: np.ndarray
    max_height: float
    colliders: dict  # (ci, cj) -> (M, 6) array


def build_region(rx: int, rz: int) -> RegionData:
    all_boxes = []
    colliders = {}
    for ci in range(rx * REGION_CELLS, (rx + 1) * REGION_CELLS):
        for cj in range(rz * REGION_CELLS, (rz + 1) * REGION_CELLS):
            b = Builder()
            build_cell(ci, cj, b)
            arr = np.array(b.boxes, np.float32).reshape(-1, 12)
            all_boxes.append(arr)
            solid = np.array(b.solid, bool)
            colliders[(ci, cj)] = arr[solid, :6].astype(np.float64)

    x0, z0 = rx * REGION, rz * REGION
    ground = np.array([[x0, -1.0, z0, x0 + REGION, 0.0, z0 + REGION, 1, 1, 1, M_ASPHALT, 0, 0.0]], np.float32)
    boxes = np.concatenate([ground] + all_boxes)
    verts, idx = boxes_to_mesh(boxes)
    return RegionData(rx, rz, verts, idx, float(boxes[:, 4].max()), colliders)
