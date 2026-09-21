#!/usr/bin/env python3
"""
kivo — brand "K" logo generator.

Draws the kivo launcher/PWA logo (a warm-emerald rounded tile with a single
lower-case "k") as pure geometry and rasterises it with an analytic scanline
fill at high resolution, then box-filters it down to every shipped size.
Pure standard library — no PIL, no network, no font files — so the brand mark
is reproducible byte-for-byte anywhere (CI included).

Outputs (all PNG, 8-bit RGBA):
    frontend/icons/icon-192.png      PWA / favicon
    frontend/icons/icon-512.png      PWA + source for android/tools/make_icons.py
    frontend/icons/maskable-512.png  adaptive-icon foreground (safe-zone art)

Usage:
    python3 android/tools/make_k_logo.py
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
ICONS = REPO / "frontend" / "icons"

MASTER = 2048          # render resolution before downsampling (4x the 512 art)
BOX = 1000.0           # design space the letter/tile coordinates live in

# Brand gradient — deep jade → vivid emerald (matches --teal/--grad-mint).
GRAD_TOP = (11, 94, 70)
GRAD_BOT = (24, 160, 112)

# --------------------------------------------------------------------------- #
# geometry helpers (design space: 0..BOX, y grows downward)
# --------------------------------------------------------------------------- #
def rounded_rect_spans(size: int, radius: float):
    """Per-row [x0, x1) spans of a full-bleed rounded square (design 0..BOX)."""
    r = radius * size / BOX
    spans = []
    for y in range(size):
        if y < r:
            dy = r - (y + 0.5)
            dx = (r * r - dy * dy) ** 0.5 if dy < r else 0.0
            x0 = r - dx
            x1 = size - r + dx
        elif y >= size - r:
            dy = (y + 0.5) - (size - r)
            dx = (r * r - dy * dy) ** 0.5 if dy < r else 0.0
            x0 = r - dx
            x1 = size - r + dx
        else:
            x0, x1 = 0.0, float(size)
        spans.append((x0, x1))
    return spans


def scale_point(p, scale, cx, cy):
    return (cx + (p[0] - cx) * scale, cy + (p[1] - cy) * scale)


def polygon_spans(points, size: int):
    """Per-row [x0, x1) coverage spans for a convex polygon (even-odd pairs)."""
    pts = [(x * size / BOX, y * size / BOX) for x, y in points]
    n = len(pts)
    edges = []
    for i in range(n):
        (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % n]
        if y0 == y1:
            continue
        if y0 > y1:
            (x0, y0), (x1, y1) = (x1, y1), (x0, y0)
        edges.append((y0, y1, x0, (x1 - x0) / (y1 - y0)))
    spans = []
    for y in range(size):
        cy = y + 0.5
        xs = []
        for ey0, ey1, ex, slope in edges:
            if ey0 <= cy < ey1:
                xs.append(ex + (cy - ey0) * slope)
        if not xs:
            spans.append(None)
            continue
        # convex input: the horizontal rule always enters and exits through
        # the outermost intersections — vertices on the rule only add doubles.
        spans.append((min(xs), max(xs)))
    return spans


def quad(p1, p2, p3, p4):
    return [p1, p2, p3, p4]


def stroke(a, b, thickness, cut_a=None, cut_b=None):
    """
    A diagonal stroke as a convex quad: centreline a→b, `thickness` measured
    perpendicular, ends optionally trimmed by a horizontal cut (typographic
    terminals) given as ("top"|"bottom", y).
    """
    import math
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    nx, ny = -dy / length, dx / length  # unit normal
    half = thickness / 2.0
    p1 = (a[0] + nx * half, a[1] + ny * half)
    p2 = (b[0] + nx * half, b[1] + ny * half)
    p3 = (b[0] - nx * half, b[1] - ny * half)
    p4 = (a[0] - nx * half, a[1] - ny * half)
    pts = [p1, p2, p3, p4]

    def trim(points, which, y):
        """Keep the part of each quad above/below y by clipping with a rule."""
        def side(p):
            return (p[1] - y) * (-1 if which == "top" else 1)
        out = []
        n = len(points)
        for i in range(n):
            cur, nxt = points[i], points[(i + 1) % n]
            sc, sn = side(cur), side(nxt)
            if sc >= 0:
                out.append(cur)
            if (sc >= 0) != (sn >= 0):
                t = sc / (sc - sn)
                out.append((cur[0] + (nxt[0] - cur[0]) * t, y))
        return out

    if cut_a:
        pts = trim(pts, *cut_a)
    if cut_b:
        pts = trim(pts, *cut_b)
    return pts


def bbox(polys):
    xs = [p[0] for poly in polys for p in poly]
    ys = [p[1] for poly in polys for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


# The kivo "k": a confident lower-case letterform — sturdy ascender stem with
# softly chamfered terminals, one springy diagonal arm up to the x-height and
# a long kicking leg to the baseline, both meeting the stem at a shared joint
# the way a real grotesque "k" is drawn.
def k_letter(scale=1.0, cx=500.0, cy=500.0):
    stem_top, stem_bot = 172.0, 812.0
    stem_l, stem_r = 296.0, 446.0
    xh = 402.0            # x-height line
    base = 812.0          # baseline
    joint = (stem_r - 50.0, 588.0)      # arm + leg spring off here
    arm_end = (700.0, 376.0)            # pokes past x-height, then sliced flat
    leg_end = (742.0, 876.0)            # pokes past baseline, then sliced flat
    th = 132.0            # diagonal stroke weight

    polys = [
        # ascender stem — one clean, confident bar
        quad((stem_l, stem_top), (stem_r, stem_top),
             (stem_r, stem_bot), (stem_l, stem_bot)),
        # arm: joint → past the x-height, sliced flat exactly at the x-height
        stroke(joint, arm_end, th, cut_b=("bottom", xh)),
        # leg: joint → past the baseline, sliced flat exactly at the baseline
        stroke(joint, leg_end, th, cut_b=("top", base)),
    ]

    # normalise: uniform scale (aspect preserved) around the letter's own
    # centre, then re-centre on the optical middle of the tile.
    x0, y0, x1, y1 = bbox(polys)
    bw, bh = (x1 - x0), (y1 - y0)
    s = scale * min(0.64 * BOX / bw, 0.68 * BOX / bh)
    w, h = bw * s, bh * s
    out = []
    for poly in polys:
        qp = []
        for px, py in poly:
            qx = cx - w / 2.0 + (px - x0) * s
            qy = cy - h / 2.0 + (py - y0) * s
            qp.append((qx, qy))
        out.append(qp)
    return out


# --------------------------------------------------------------------------- #
# rasteriser
# --------------------------------------------------------------------------- #
def render_master(tile_radius: float, letter_scale: float, cx: float, cy: float) -> list[bytearray]:
    size = MASTER
    tile = rounded_rect_spans(size, tile_radius)
    shapes = [polygon_spans(poly, size) for poly in k_letter(letter_scale, cx, cy)]
    # one soft top highlight band to give the tile a lit-from-above feel
    hi_a, hi_b = 0.10, 0.0

    rows = []
    for y in range(size):
        row = bytearray(size * 4)
        t = y / (size - 1)
        r = int(GRAD_TOP[0] + (GRAD_BOT[0] - GRAD_TOP[0]) * t)
        g = int(GRAD_TOP[1] + (GRAD_BOT[1] - GRAD_TOP[1]) * t)
        b = int(GRAD_TOP[2] + (GRAD_BOT[2] - GRAD_TOP[2]) * t)
        span = tile[y]
        if span is None:
            rows.append(row)
            continue
        x0 = max(0, int(span[0]))
        x1 = min(size, int(span[1]) + 1)
        if x1 <= x0:
            rows.append(row)
            continue
        # top highlight (fades out by 30% height)
        fade = max(0.0, 1.0 - y / (size * 0.30))
        alpha = hi_a * fade + hi_b
        if alpha > 0.004:
            ir, ig, ib = (int(r + (255 - r) * alpha), int(g + (255 - g) * alpha), int(b + (255 - b) * alpha))
        else:
            ir, ig, ib = r, g, b
        for off in range(x0 * 4, x1 * 4, 4):
            row[off] = ir
            row[off + 1] = ig
            row[off + 2] = ib
            row[off + 3] = 255
        # letter (white) — paint after the tile, clipped to the tile span
        for shp in shapes:
            sp = shp[y]
            if sp is None:
                continue
            lx0 = max(x0, int(sp[0]))
            lx1 = min(x1, int(sp[1]) + 1)
            if lx1 <= lx0:
                continue
            for off in range(lx0 * 4, lx1 * 4, 4):
                row[off] = 255
                row[off + 1] = 255
                row[off + 2] = 255
        rows.append(row)
    return rows


def downsample(rows: list[bytearray], src: int, dst: int) -> list[bytearray]:
    f = src // dst
    out = []
    for oy in range(dst):
        line = bytearray(dst * 4)
        for ox in range(dst):
            r = g = b = a = 0
            for sy in range(oy * f, (oy + 1) * f):
                srcrow = rows[sy]
                for sx in range(ox * f, (ox + 1) * f):
                    off = sx * 4
                    r += srcrow[off]
                    g += srcrow[off + 1]
                    b += srcrow[off + 2]
                    a += srcrow[off + 3]
            n = f * f
            off = ox * 4
            line[off] = r // n
            line[off + 1] = g // n
            line[off + 2] = b // n
            line[off + 3] = a // n
        out.append(line)
    return out


def write_png(path: Path, size: int, rows: list[bytearray]) -> None:
    raw = bytearray()
    for row in rows:
        raw += b"\x00" + bytes(row)
    chunks = [
        (b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)),
        (b"IDAT", zlib.compress(bytes(raw), 9)),
        (b"IEND", b""),
    ]
    buf = bytearray(b"\x89PNG\r\n\x1a\n")
    for ctype, payload in chunks:
        buf += struct.pack(">I", len(payload)) + ctype + payload
        buf += struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(buf))
    print(f"[logo] {path.relative_to(REPO)}  ({size}x{size})")


def main() -> int:
    # Regular tile: full-bleed rounded square, letter at full presence.
    tile = render_master(tile_radius=232, letter_scale=1.0, cx=500, cy=500)
    i512 = downsample(tile, MASTER, 512)
    write_png(ICONS / "icon-512.png", 512, i512)
    write_png(ICONS / "icon-192.png", 192, downsample(tile, MASTER, 192))

    # Maskable/adaptive foreground: SQUARE full-bleed canvas, letter pulled
    # into the central 66% safe zone so every launcher mask keeps it whole.
    mask = render_master(tile_radius=0, letter_scale=0.68, cx=500, cy=500)
    write_png(ICONS / "maskable-512.png", 512, downsample(mask, MASTER, 512))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
