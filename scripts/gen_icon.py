#!/usr/bin/env python3
"""生成 PostHub 应用图标源 PNG（1024x1024），仅用标准库。

设计：品牌蓝渐变圆角方块 + 白色「P」字形（发布 PostHub 首字母）。
输出经 `tauri icon` 生成全尺寸 iconset（32/128/@2x/.icns/.ico）。
"""

from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

SIZE = 1024


def sd_rounded_box(x: float, y: float, cx: float, cy: float, hw: float, hh: float, r: float) -> float:
    qx = abs(x - cx) - (hw - r)
    qy = abs(y - cy) - (hh - r)
    ax = max(qx, 0.0)
    ay = max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - r


def sd_circle(x: float, y: float, cx: float, cy: float, r: float) -> float:
    return math.hypot(x - cx, y - cy) - r


def p_coverage(x: float, y: float) -> float:
    """'P' 字形内部返回 1，外部返回 0。"""
    bar = sd_rounded_box(x, y, 360, 500, 80, 260, 42)
    if bar <= 0:
        return 1.0
    outer = sd_circle(x, y, 545, 405, 185)
    if outer > 0:
        return 0.0
    inner = sd_circle(x, y, 545, 405, 92)
    if inner < 0:
        return 0.0
    return 1.0


def coverage_at(x: float, y: float, ss: int) -> float:
    total = 0.0
    for i in range(ss):
        for j in range(ss):
            sx = x + (i + 0.5) / ss
            sy = y + (j + 0.5) / ss
            if sd_rounded_box(sx, sy, SIZE / 2, SIZE / 2, 480, 480, 200) > 0:
                continue
            total += p_coverage(sx, sy)
    return total / (ss * ss)


def pixel(x: int, y: int) -> tuple[int, int, int, int]:
    a = coverage_at(x, y, 4)
    t = y / SIZE
    bg = (
        int(round(74 + (94 - 74) * t)),
        int(round(117 + (90 - 117) * t)),
        int(round(255 + (235 - 255) * t)),
        255,
    )
    fg = (255, 255, 255, 255)
    return tuple(int(round(bg[i] + (fg[i] - bg[i]) * a)) for i in range(4))


def write_png(path: Path, size: int) -> None:
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            row.extend(pixel(x, y))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(typ: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + typ + data
        c += struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("app-icon.png")
    write_png(out, SIZE)
    print(f"wrote {out} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
