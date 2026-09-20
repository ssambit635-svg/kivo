#!/usr/bin/env python3
"""
Generate the Android launcher icons for the kivo APK from the PWA icons that
already ship in `frontend/icons/`.

Why this exists: the APK needs real, per-density PNG launcher icons plus an
adaptive-icon foreground. Android's PackageInstaller resolves
`android:icon` / `android:roundIcon` from `resources.arsc` while it parses the
package — an icon reference that does not resolve is exactly the kind of thing
that produces "There was a problem parsing the package".

Pure standard library (zlib + struct): decodes the 16-bit RGB/RGBA PNGs the
designer exported, box-filters them down to 8-bit RGBA and re-encodes. No PIL,
no network, no Android SDK — so it runs anywhere, including CI.

Usage:
    python3 android/tools/make_icons.py
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
FRONTEND_ICONS = REPO / "frontend" / "icons"
RES = HERE.parent / "app" / "src" / "main" / "res"

# Launcher icon sizes per density (48dp square).
LEGACY_DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

# Adaptive icon foreground: 108dp canvas (the outer 18dp on each side is the
# mask bleed area), so the source art must keep its safe-zone padding — that is
# what `maskable-512.png` is for.
FOREGROUND_DENSITIES = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}


# --------------------------------------------------------------------------- #
# PNG decode
# --------------------------------------------------------------------------- #
def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def read_png(path: Path) -> tuple[int, int, list[bytearray]]:
    """Decode a non-interlaced PNG into (width, height, rows of RGBA bytes)."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")

    pos = 8
    width = height = bit_depth = color_type = interlace = 0
    idat = bytearray()
    palette: list[tuple[int, int, int]] = []
    transparency = None

    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        pos += 12 + length

        if ctype == b"IHDR":
            width, height, bit_depth, color_type, _comp, _filt, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
        elif ctype == b"PLTE":
            palette = [
                (chunk[i], chunk[i + 1], chunk[i + 2]) for i in range(0, len(chunk), 3)
            ]
        elif ctype == b"tRNS":
            transparency = chunk
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break

    if interlace:
        raise ValueError(f"{path}: interlaced PNGs are not supported by this tool")
    if bit_depth not in (8, 16):
        raise ValueError(f"{path}: unsupported bit depth {bit_depth}")

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    raw = zlib.decompress(bytes(idat))
    bpp = max(1, channels * bit_depth // 8)
    stride = width * bpp

    # Undo the per-scanline filters.
    out = bytearray()
    prev = bytearray(stride)
    idx = 0
    for _y in range(height):
        ftype = raw[idx]
        idx += 1
        line = bytearray(raw[idx : idx + stride])
        idx += stride
        if ftype == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                c = prev[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(a, prev[i], c)) & 0xFF
        elif ftype != 0:
            raise ValueError(f"{path}: unknown filter type {ftype}")
        out += line
        prev = line

    # Normalise everything to 8-bit RGBA rows.
    rows: list[bytearray] = []
    for y in range(height):
        row = out[y * stride : (y + 1) * stride]
        rgba = bytearray(width * 4)
        for x in range(width):
            if color_type in (2, 6):
                shift = 1 if bit_depth == 16 else 0
                step = channels << shift
                off = x * step
                r = row[off]
                g = row[off + (2 if shift else 1)]
                b = row[off + (4 if shift else 2)]
                a = row[off + (6 if shift else 3)] if color_type == 6 else 255
            elif color_type == 3:
                idx8 = row[x]
                r, g, b = palette[idx8] if idx8 < len(palette) else (0, 0, 0)
                a = 255
                if transparency and idx8 < len(transparency):
                    a = transparency[idx8]
            elif color_type == 0:
                shift = 1 if bit_depth == 16 else 0
                v = row[x << shift]
                r = g = b = v
                a = 255
                if transparency and len(transparency) >= 2:
                    gray_t = struct.unpack(">H", transparency[:2])[0]
                    if (v << (8 if shift else 0)) == gray_t:
                        a = 0
            else:  # color_type 4: gray + alpha
                shift = 1 if bit_depth == 16 else 0
                step = 2 << shift
                off = x * step
                v = row[off]
                r = g = b = v
                a = row[off + (2 if shift else 1)]
            base = x * 4
            rgba[base] = r
            rgba[base + 1] = g
            rgba[base + 2] = b
            rgba[base + 3] = a
        rows.append(rgba)
    return width, height, rows


# --------------------------------------------------------------------------- #
# Resize (box filter — good enough and artefact-free for launcher icons)
# --------------------------------------------------------------------------- #
def resize(width: int, height: int, rows: list[bytearray], size: int) -> list[bytearray]:
    out: list[bytearray] = []
    for oy in range(size):
        y0 = oy * height // size
        y1 = max(y0 + 1, (oy + 1) * height // size)
        line = bytearray(size * 4)
        for ox in range(size):
            x0 = ox * width // size
            x1 = max(x0 + 1, (ox + 1) * width // size)
            r = g = b = a = 0
            n = 0
            for sy in range(y0, min(y1, height)):
                src = rows[sy]
                for sx in range(x0, min(x1, width)):
                    off = sx * 4
                    r += src[off]
                    g += src[off + 1]
                    b += src[off + 2]
                    a += src[off + 3]
                    n += 1
            off = ox * 4
            line[off] = r // n
            line[off + 1] = g // n
            line[off + 2] = b // n
            line[off + 3] = a // n
        out.append(line)
    return out


# --------------------------------------------------------------------------- #
# PNG encode
# --------------------------------------------------------------------------- #
def circle_mask(size: int, rows: list[bytearray]) -> list[bytearray]:
    """Clip square art to an anti-aliased circle (legacy `ic_launcher_round`)."""
    radius = size / 2.0
    out: list[bytearray] = []
    for y, row in enumerate(rows):
        line = bytearray(row)
        for x in range(size):
            # 1.5px feather so the edge does not alias on high-density screens.
            d = ((x + 0.5 - radius) ** 2 + (y + 0.5 - radius) ** 2) ** 0.5
            if d >= radius + 0.75:
                alpha = 0.0
            elif d <= radius - 0.75:
                alpha = 1.0
            else:
                alpha = (radius + 0.75 - d) / 1.5
            if alpha < 1.0:
                line[x * 4 + 3] = int(line[x * 4 + 3] * alpha)
        out.append(line)
    return out


def write_png(path: Path, size: int, rows: list[bytearray]) -> None:
    raw = bytearray()
    for row in rows:
        raw += b"\x00" + row
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


def main() -> int:
    brand = FRONTEND_ICONS / "icon-512.png"
    maskable = FRONTEND_ICONS / "maskable-512.png"
    for src in (brand, maskable):
        if not src.exists():
            print(f"[icons] missing source icon: {src}", file=sys.stderr)
            return 1

    bw, bh, brows = read_png(brand)
    mw, mh, mrows = read_png(maskable)
    print(f"[icons] decoded {brand.name} ({bw}x{bh}) and {maskable.name} ({mw}x{mh})")

    written = 0
    for density, size in LEGACY_DENSITIES.items():
        art = resize(bw, bh, brows, size)
        target = RES / f"mipmap-{density}" / "ic_launcher.png"
        write_png(target, size, art)
        print(f"[icons] {target.relative_to(REPO)}  ({size}x{size})")
        written += 1

        # `android:roundIcon` is read on API 25 too, so a round PNG has to exist
        # for every density — otherwise the reference does not resolve and the
        # installer rejects the package.
        round_target = RES / f"mipmap-{density}" / "ic_launcher_round.png"
        write_png(round_target, size, circle_mask(size, art))
        print(f"[icons] {round_target.relative_to(REPO)}  ({size}x{size})")
        written += 1

    for density, size in FOREGROUND_DENSITIES.items():
        target = RES / f"mipmap-{density}" / "ic_launcher_foreground.png"
        write_png(target, size, resize(mw, mh, mrows, size))
        print(f"[icons] {target.relative_to(REPO)}  ({size}x{size})")
        written += 1

    print(f"[icons] wrote {written} launcher icon PNGs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
