"""Draw the app icons: a check mark in a ring on the app background.

Run from the repo root: python tools/make_icons.py
The artwork sits inside the central 60% so the same files work as maskable icons.
"""
from pathlib import Path

from PIL import Image, ImageDraw

BG = (14, 17, 22)        # --bg
ACCENT = (94, 194, 160)  # --accent
OUT = Path(__file__).resolve().parent.parent / "icons"
SCALE = 4  # draw large, then downsample for smooth edges


def draw(size: int) -> Image.Image:
    s = size * SCALE
    img = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(img)
    c = s / 2
    r = s * 0.30
    ring = s * 0.045
    d.ellipse([c - r, c - r, c + r, c + r], outline=ACCENT, width=round(ring))
    w = round(s * 0.055)
    pts = [(c - r * 0.45, c + r * 0.02), (c - r * 0.10, c + r * 0.38), (c + r * 0.50, c - r * 0.34)]
    d.line(pts, fill=ACCENT, width=w, joint="curve")
    for x, y in (pts[0], pts[2]):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
        draw(size).save(OUT / name, optimize=True)
        print("wrote", OUT / name)


if __name__ == "__main__":
    main()
