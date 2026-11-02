#!/usr/bin/env python3
"""Generate the PWA icon set.

Pure standard library: a small PNG writer plus signed-distance-field shapes, so
the icons are reproducible from source with no image toolchain to install.

    python scripts/make_icons.py

Writes into web/public/icons/ plus a favicon. Re-run after changing the mark.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parents[1] / "public" / "icons"
PUBLIC_DIR = Path(__file__).resolve().parents[1] / "public"

# Matches the accent colours in src/styles.css.
BG_TOP = (0x3C, 0x6F, 0xFF)
BG_BOTTOM = (0x21, 0x3F, 0xC4)
MARK = (0xFF, 0xFF, 0xFF)
DOT = (0x3D, 0xDC, 0x97)


def write_png(path: Path, width: int, height: int, pixels: list[bytearray]) -> None:
    """Write 8-bit RGB pixel rows as a PNG."""
    raw = b"".join(b"\x00" + bytes(row) for row in pixels)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def smoothstep(edge: float, width: float, value: float) -> float:
    """1 inside the shape, 0 outside, with a soft edge `width` px wide."""
    t = (edge - value) / width + 0.5
    return max(0.0, min(1.0, t))


def rounded_rect_sdf(px: float, py: float, half: float, radius: float) -> float:
    dx = abs(px) - (half - radius)
    dy = abs(py) - (half - radius)
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    return outside + min(max(dx, dy), 0.0) - radius


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[float, float, float]:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def triangle_sdf(along: float, across: float, height: float, half_base: float) -> float:
    """Isoceles triangle with its base at along=0 and its tip at along=height."""
    edge = (abs(across) * height + along * half_base - height * half_base) / math.hypot(
        height, half_base
    )
    return max(edge, -along)


def render(size: int, *, maskable: bool) -> list[bytearray]:
    """Draw a clockwise sync ring with an arrowhead, plus a dot for 'in sync'.

    Maskable icons get a full-bleed square background and a smaller mark so the
    launcher can crop to a circle without clipping anything that matters.
    """
    aa = max(1.0, size / 256)
    centre = size / 2
    scale = size / 2  # mark coordinates are in units of half the canvas

    inset = 0.74 if maskable else 0.92
    ring_radius = 0.58 * inset * scale
    ring_half_thickness = 0.115 * inset * scale
    corner = 0.0 if maskable else size * 0.215
    gap_centre = math.radians(58.0)
    gap_half = math.radians(26.0)

    # Arrowhead sits at the trailing edge of the gap, pointing clockwise.
    head_angle = gap_centre + gap_half
    head_x = centre + ring_radius * math.cos(head_angle)
    head_y = centre - ring_radius * math.sin(head_angle)
    head_height = ring_half_thickness * 2.6
    head_half_base = ring_half_thickness * 2.1
    # Clockwise motion is decreasing angle, so the tangent is (sin, -cos).
    tangent = (math.sin(head_angle), -math.cos(head_angle))

    dot_radius = ring_radius * 0.30

    rows: list[bytearray] = []
    for y in range(size):
        row = bytearray()
        py = y + 0.5
        for x in range(size):
            px = x + 0.5

            # Background: vertical gradient, rounded unless maskable.
            base = mix(BG_TOP, BG_BOTTOM, y / max(1, size - 1))
            bg_alpha = (
                1.0
                if maskable
                else smoothstep(0.0, aa, rounded_rect_sdf(px - centre, py - centre, centre, corner))
            )
            r, g, b = (base[0] * bg_alpha, base[1] * bg_alpha, base[2] * bg_alpha)

            # Work in maths coordinates (y up) so the angles read normally.
            dx, dy = px - centre, centre - py
            dist = math.hypot(dx, dy)

            # Ring, with an angular gap for the arrow to come out of.
            ring_alpha = smoothstep(0.0, aa, abs(dist - ring_radius) - ring_half_thickness)
            if ring_alpha > 0.0 and dist > 1e-6:
                angle = math.atan2(dy, dx)
                delta = abs((angle - gap_centre + math.pi) % (2 * math.pi) - math.pi)
                # Soften the cut over roughly a pixel of arc length.
                ring_alpha *= 1.0 - smoothstep(0.0, aa / dist, delta - gap_half)

            # Arrowhead: a triangle straddling the ring, tip along the tangent.
            tx, ty = px - head_x, head_y - py
            along = tx * tangent[0] + ty * tangent[1]
            across = -tx * tangent[1] + ty * tangent[0]
            head_alpha = smoothstep(
                0.0, aa, triangle_sdf(along, across, head_height, head_half_base)
            )

            mark_alpha = max(ring_alpha, head_alpha)
            if mark_alpha > 0.0:
                r = r + (MARK[0] - r) * mark_alpha
                g = g + (MARK[1] - g) * mark_alpha
                b = b + (MARK[2] - b) * mark_alpha

            # Centre dot: the "in sync" tick of colour.
            dot_alpha = smoothstep(0.0, aa, dist - dot_radius)
            if dot_alpha > 0.0:
                r = r + (DOT[0] - r) * dot_alpha
                g = g + (DOT[1] - g) * dot_alpha
                b = b + (DOT[2] - b) * dot_alpha

            row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5)))
        rows.append(row)
    return rows


def main() -> None:
    targets = [
        (OUT_DIR / "icon-192.png", 192, False),
        (OUT_DIR / "icon-512.png", 512, False),
        (OUT_DIR / "maskable-512.png", 512, True),
        (OUT_DIR / "apple-touch-icon.png", 180, False),
        (PUBLIC_DIR / "favicon.png", 48, False),
    ]
    for path, size, maskable in targets:
        write_png(path, size, size, render(size, maskable=maskable))
        print(f"wrote {path.relative_to(PUBLIC_DIR.parent)} ({size}x{size})")


if __name__ == "__main__":
    main()
