#!/usr/bin/env python3
"""
kivo — opening brand film renderer (frontend/img/intro.mp4).

The Google Flow share link the client sent could not be fetched from this
sandbox (network blocked), so this script authors the intro in-code with the
same beats a Flow clip would hit — all in the kivo "Verdant" palette:

  0.0s  deep-pine stillness, a breathing emerald aurora wakes
  0.5s  a luminous pulse line sweeps through — health data, alive
  1.6s  particles gather to a heartbeat, then bloom outward
  2.8s  the aurora settles — calm, ready for the app

Rendered with PIL frame-by-frame and piped to the imageio-ffmpeg binary
(H.264, yuv420p, faststart, silent — the intro is muted by design).

Usage:
    python3 android/tools/make_intro_video.py
"""
from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "frontend" / "img" / "intro.mp4"

W, H = 720, 1280          # phone-first portrait; the player cover-crops
FPS = 30
SECONDS = 4.2
FRAMES = int(FPS * SECONDS)

# palette (Verdant)
DEEP = (7, 34, 25)        # near-black pine
PINE = (10, 46, 34)
EMERALD = (24, 160, 112)
MINT = (124, 227, 190)
GOLD = (212, 175, 105)


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(int(lerp(c1[i], c2[i], t)) for i in range(3))


def ease_in_out(t):
    return t * t * (3 - 2 * t)


def ease_out(t):
    return 1 - (1 - t) ** 3


def aurora_layer(t, seed_phase):
    """One soft coloured blob, drifting on a lissajous path."""
    img = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = W * (0.5 + 0.30 * math.sin(t * 1.3 + seed_phase))
    cy = H * (0.44 + 0.16 * math.cos(t * 0.9 + seed_phase * 1.7))
    r = int(min(W, H) * (0.34 + 0.05 * math.sin(t * 1.7 + seed_phase)))
    for i in range(r, 0, -max(1, r // 26)):
        f = 1 - i / r
        col = tuple(int(c * f * f * 0.55) for c in EMERALD)
        d.ellipse([cx - i, cy - i * 0.82, cx + i, cy + i * 0.82], fill=col)
    return img.filter(ImageFilter.GaussianBlur(46))


def base_frame(t):
    """Background: deep pine + two breathing auroras + vignette."""
    breathe = 0.5 + 0.5 * math.sin(t * 1.1 - 0.6)
    frame = Image.new("RGB", (W, H), mix(DEEP, PINE, 0.25 + 0.2 * breathe))
    a1 = aurora_layer(t, 0.0)
    a2 = aurora_layer(t + 2.1, 2.4)
    # screen-blend the auroras
    frame = ImageChops.screen(frame, a1)
    frame = ImageChops.screen(frame, a2)
    # vignette
    vig = Image.new("L", (W, H), 0)
    dv = ImageDraw.Draw(vig)
    dv.ellipse([-W * 0.35, -H * 0.25, W * 1.35, H * 1.25], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(120))
    dark = Image.new("RGB", (W, H), (3, 16, 12))
    frame = Image.composite(frame, dark, vig)
    return frame


def draw_pulse(frame_rgba, t):
    """0.5–1.7s: a soft glowing pulse line sweeps across the middle."""
    if t < 0.45 or t > 1.85:
        return
    p = (t - 0.45) / 1.4
    head_x = ease_in_out(min(1, p * 1.25)) * (W + 160) - 80
    alpha = 255 * (1 if p < 0.8 else (1 - p) / 0.2)
    d = ImageDraw.Draw(frame_rgba)
    y0 = H * 0.5
    # trailing wave
    pts = []
    for x in range(0, int(head_x), 6):
        dx = (head_x - x) / W
        amp = 46 * math.exp(-2.6 * dx) * (0.6 + 0.4 * math.sin(t * 5))
        y = y0 + amp * math.sin(x * 0.028 - t * 9)
        pts.append((x, y))
    if len(pts) > 2:
        # glow pass then core pass
        d.line(pts, fill=(124, 227, 190, int(70 * alpha / 255)), width=18)
        d.line(pts, fill=(196, 245, 224, int(alpha)), width=4)


def draw_particles(frame_rgba, t):
    """1.5–3.1s: motes gather to the centre, breathe, then bloom away."""
    if t < 1.4 or t > 3.2:
        return
    p = (t - 1.4) / 1.8
    d = ImageDraw.Draw(frame_rgba)
    cx, cy = W / 2, H * 0.5
    n = 26
    for i in range(n):
        ang = i * (math.pi * 2 / n) + i * 0.7
        # gather in (0-0.45), breathe (0.45-0.7), bloom (0.7-1)
        if p < 0.45:
            q = ease_out(p / 0.45)
            r = lerp(H * 0.42, H * 0.085, q)
        elif p < 0.7:
            q = (p - 0.45) / 0.25
            r = H * 0.085 + math.sin(q * math.pi) * 26
        else:
            q = ease_in_out((p - 0.7) / 0.3)
            r = lerp(H * 0.085, H * 0.5, q)
        tw = 0.55 + 0.45 * math.sin(t * 6 + i * 1.9)
        size = lerp(2.0, 5.0, (i % 3) / 2) * tw
        alpha = int(230 * math.sin(min(1, p) * math.pi) * tw + 18)
        x = cx + r * math.cos(ang) * 0.9
        y = cy + r * math.sin(ang) * 1.15
        col = MINT if i % 4 else GOLD
        d.ellipse([x - size, y - size, x + size, y + size], fill=(*col, max(0, min(255, alpha))))
    # centre glow at the heartbeat moment
    if 0.40 < p < 0.72:
        q = math.sin((p - 0.40) / 0.32 * math.pi)
        glow_r = 10 + 90 * q
        for rr, aa in ((glow_r, int(60 * q)), (glow_r * 0.6, int(90 * q))):
            d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(196, 245, 224, aa))


def frame_rgba(t):
    frame = base_frame(t).convert("RGBA")
    draw_pulse(frame, t)
    draw_particles(frame, t)
    # gentle top-to-bottom cinema grade
    grade = Image.new("L", (1, H))
    for y in range(H):
        f = y / (H - 1)
        grade.putpixel((0, y), int(255 * (1.0 - 0.22 * f)))
    grade = grade.resize((W, H))
    frame = ImageChops.multiply(frame, Image.merge("RGBA", (grade, grade, grade, Image.new("L", (W, H), 255))))
    return frame


def main() -> int:
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg, "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-r", str(FPS),
        "-i", "-",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        str(OUT),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for i in range(FRAMES):
        t = i / FPS
        proc.stdin.write(frame_rgba(t).tobytes())
        if i % 30 == 0:
            print(f"[intro] frame {i}/{FRAMES} (t={t:.2f}s)")
    proc.stdin.close()
    proc.wait()
    size = OUT.stat().st_size
    print(f"[intro] wrote {OUT.relative_to(REPO)}  ({size/1024:.0f} KB, {FRAMES} frames @ {FPS}fps)")
    if proc.returncode != 0:
        print("[intro] ffmpeg failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
