#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Генератор PNG-иконок для J.A.R.V.I.S. Без внешних зависимостей.

    python tools/make-icons.py

Создаёт:
    icons/icon-192.png
    icons/icon-512.png
    icons/icon-maskable-512.png
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
SIZE = 768  # рендерим с запасом, затем уменьшаем


def clamp(value, low=0.0, high=1.0):
    return low if value < low else high if value > high else value


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def over(dst, src, alpha):
    return tuple(dst[i] * (1 - alpha) + src[i] * alpha for i in range(3))


def smoothstep(edge0, edge1, x):
    if edge0 == edge1:
        return 0.0 if x < edge0 else 1.0
    t = clamp((x - edge0) / (edge1 - edge0))
    return t * t * (3 - 2 * t)


def rounded_rect_alpha(x, y, radius, edge):
    cx = clamp(x, radius, 1 - radius)
    cy = clamp(y, radius, 1 - radius)
    d = math.hypot(x - cx, y - cy)
    if d <= radius - edge:
        return 1.0
    if d >= radius + edge:
        return 0.0
    return smoothstep(radius + edge, radius - edge, d)


def render(maskable):
    rows = []
    edge = 1.6 / SIZE
    tau = 2 * math.pi

    for j in range(SIZE):
        y = (j + 0.5) / SIZE
        row = bytearray()
        for i in range(SIZE):
            x = (i + 0.5) / SIZE
            dx, dy = x - 0.5, y - 0.5
            dist = math.hypot(dx, dy)
            angle = math.atan2(dy, dx)

            bg_alpha = 1.0 if maskable else rounded_rect_alpha(x, y, 0.22, edge)
            if bg_alpha <= 0.002:
                row.extend((0, 0, 0, 0))
                continue

            radial = clamp(dist / 0.62)
            color = mix((11, 38, 52), (3, 6, 11), radial)

            # внешнее тонкое кольцо
            ring1 = smoothstep(0.004 + edge, 0.004 - edge, abs(dist - 0.293))
            color = over(color, (53, 230, 255), ring1 * 0.30)

            # пунктирное кольцо
            if abs(dist - 0.234) < 0.012:
                seg = (angle % tau) / tau
                if (seg * 24) % 1 < 0.32:
                    ring2 = smoothstep(0.011 + edge, 0.011 - edge, abs(dist - 0.234))
                    color = over(color, (53, 230, 255), ring2 * 0.55)

            # золотые штрихи
            if abs(dist - 0.191) < 0.003:
                seg = (angle % tau) / tau
                if (seg * 12) % 1 < 0.16:
                    color = over(color, (255, 181, 69), 0.35)

            # свечение
            glow = math.exp(-((dist / 0.20) ** 2) * 2.2)
            color = over(color, (53, 230, 255), glow * 0.30)

            # сфера
            if dist < 0.153:
                t = clamp(dist / 0.153)
                if t < 0.22:
                    orb = mix((244, 254, 255), (169, 246, 255), t / 0.22)
                elif t < 0.48:
                    orb = mix((169, 246, 255), (69, 216, 242), (t - 0.22) / 0.26)
                elif t < 0.72:
                    orb = mix((69, 216, 242), (20, 135, 166), (t - 0.48) / 0.24)
                elif t < 0.9:
                    orb = mix((20, 135, 166), (8, 54, 69), (t - 0.72) / 0.18)
                else:
                    orb = mix((8, 54, 69), (6, 34, 45), (t - 0.9) / 0.1)
                orb_alpha = smoothstep(0.153 + edge, 0.153 - edge, dist)
                color = over(color, orb, orb_alpha)

            # ядро
            core = smoothstep(0.058 + edge, 0.058 - edge, dist)
            color = over(color, (234, 255, 255), core * 0.85)
            hot = smoothstep(0.030 + edge, 0.030 - edge, dist)
            color = over(color, (255, 255, 255), hot * 0.95)

            row.extend(
                (
                    int(clamp(color[0], 0, 255)),
                    int(clamp(color[1], 0, 255)),
                    int(clamp(color[2], 0, 255)),
                    int(round(bg_alpha * 255)),
                )
            )
        rows.append(row)
    return rows


def resize(rows, dst_size):
    src_size = len(rows)
    scale = src_size / dst_size
    out = []
    for j in range(dst_size):
        y0 = int(j * scale)
        y1 = max(y0 + 1, int((j + 1) * scale))
        row = bytearray()
        for i in range(dst_size):
            x0 = int(i * scale)
            x1 = max(x0 + 1, int((i + 1) * scale))
            r = g = b = a = count = 0
            for y in range(y0, y1):
                source = rows[y]
                for x in range(x0, x1):
                    idx = x * 4
                    r += source[idx]
                    g += source[idx + 1]
                    b += source[idx + 2]
                    a += source[idx + 3]
                    count += 1
            row.extend((r // count, g // count, b // count, a // count))
        out.append(row)
    return out


def write_png(path, rows):
    height = len(rows)
    width = len(rows[0]) // 4

    raw = bytearray()
    for row in rows:
        raw.append(0)
        raw.extend(row)

    def chunk(tag, data):
        payload = tag + data
        return (
            struct.pack(">I", len(data))
            + payload
            + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    path.write_bytes(png)
    print("  %-24s %dx%d  %.1f КБ" % (path.name, width, height, len(png) / 1024))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("Рендер иконок J.A.R.V.I.S. …")

    normal = render(maskable=False)
    maskable = render(maskable=True)

    write_png(OUT / "icon-512.png", resize(normal, 512))
    write_png(OUT / "icon-192.png", resize(normal, 192))
    write_png(OUT / "icon-maskable-512.png", resize(maskable, 512))

    print("Готово.")


if __name__ == "__main__":
    main()
