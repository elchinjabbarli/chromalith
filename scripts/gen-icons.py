#!/usr/bin/env python3
"""Generate all Chromalith icons + OG image procedurally with PIL."""
from PIL import Image, ImageDraw, ImageFilter
import math
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'docs')
os.makedirs(OUT, exist_ok=True)

# palette
BG1 = (13, 18, 32)
BG2 = (26, 36, 64)
RED = (255, 85, 102)
GREEN = (43, 217, 123)
BLUE = (77, 157, 255)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def bg(size):
    img = Image.new('RGB', (size, size), BG1)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / size
        d.line([(0, y), (size, y)], fill=lerp(BG2, BG1, t))
    # radial glow center
    glow = Image.new('L', (size, size), 0)
    gd = ImageDraw.Draw(glow)
    cx = cy = size // 2
    r = int(size * 0.62)
    for i in range(r, 0, -2):
        a = int(90 * (1 - i / r))
        gd.ellipse([cx - i, cy - i, cx + i, cy + i], fill=a)
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.05))
    tint = Image.new('RGB', (size, size), (74, 93, 158))
    img = Image.composite(Image.blend(img, tint, 0.35), img, glow)
    return img


def draw_beams(d, cx, cy, size, width_scale=1.0):
    """three beams converging into a crystal: red, green, blue"""
    L = size * 0.30
    w = max(3, int(size * 0.045 * width_scale))
    # red from left
    d.line([(cx - L, cy - L * 0.52), (cx, cy)], fill=RED, width=w)
    # green from bottom
    d.line([(cx + L * 0.55, cy + L * 0.8), (cx, cy)], fill=GREEN, width=w)
    # blue from right
    d.line([(cx + L, cy - L * 0.52), (cx, cy)], fill=BLUE, width=w)


def draw_crystal(img, d, cx, cy, size):
    """hexagonal crystal, white core with facet"""
    r = size * 0.21
    pts = []
    for k in range(6):
        a = math.pi / 3 * k - math.pi / 6
        pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    # glow
    glow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gr = r * 2.2
    gd.ellipse([cx - gr, cy - gr, cx + gr, cy + gr], fill=(255, 255, 255, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.06))
    img.paste(Image.alpha_composite(img.convert('RGBA'), glow).convert('RGB'), (0, 0))
    d.polygon(pts, fill=(255, 255, 255), outline=None)
    # facet triangle
    f = []
    for k in range(3):
        a = math.pi * 2 / 3 * k - math.pi / 6
        f.append((cx + math.cos(a) * r * 0.5, cy + math.sin(a) * r * 0.5))
    d.polygon(f, fill=(210, 230, 255))


def draw_mirror(d, x, y, size, angle_deg, col):
    """small diagonal mirror tick"""
    L = size * 0.11
    a = math.radians(angle_deg)
    dx, dy = math.cos(a) * L, math.sin(a) * L
    w = max(2, int(size * 0.022))
    d.line([(x - dx, y - dy), (x + dx, y + dy)], fill=col, width=w)


def make_icon(size, path, with_mirrors=True, rounded=False):
    img = bg(size)
    d = ImageDraw.Draw(img)
    cx, cy = size * 0.5, size * 0.46
    if with_mirrors:
        s = size
        draw_mirror(d, s * 0.24, s * 0.30, s, -45, (200, 214, 240))
        draw_mirror(d, s * 0.76, s * 0.30, s, 45, (200, 214, 240))
        draw_mirror(d, s * 0.22, s * 0.72, s, 45, (160, 180, 214))
        draw_mirror(d, s * 0.78, s * 0.74, s, -45, (160, 180, 214))
    draw_beams(d, cx, cy, size)
    draw_crystal(img, d, cx, cy, size)
    d = ImageDraw.Draw(img)
    # title letter mark
    if size >= 192:
        try:
            from PIL import ImageFont
            font = ImageFont.truetype(
                '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(size * 0.13))
            d.text((size * 0.5, size * 0.855), 'CHROMALITH', font=font,
                   anchor='mm', fill=(238, 242, 255))
        except Exception:
            pass
    if rounded:
        # mask rounded squircle for App Store style preview (kept square for upload)
        mask = Image.new('L', (size, size), 0)
        md = ImageDraw.Draw(mask)
        md.rounded_rectangle([0, 0, size, size], radius=int(size * 0.225), fill=255)
        out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        out.save(path)
    else:
        img.save(path)
    print('wrote', path, size)


def make_og(path):
    W, H = 1200, 630
    img = Image.new('RGB', (W, H), BG1)
    d = ImageDraw.Draw(img)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=lerp(BG2, BG1, y / H))
    # soft glow center-left
    glow = Image.new('L', (W, H), 0)
    gd = ImageDraw.Draw(glow)
    cx, cy = W * 0.30, H * 0.5
    for i in range(int(H * 0.7), 0, -3):
        a = int(80 * (1 - i / (H * 0.7)))
        gd.ellipse([cx - i, cy - i, cx + i, cy + i], fill=a)
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    tint = Image.new('RGB', (W, H), (74, 93, 158))
    img = Image.composite(Image.blend(img, tint, 0.3), img, glow)
    d = ImageDraw.Draw(img)

    # beams + crystal
    draw_beams(d, cx, cy, H * 1.05, width_scale=1.3)
    draw_crystal(img, d, cx, cy, H * 1.05)
    d = ImageDraw.Draw(img)

    from PIL import ImageFont
    font_big = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 92)
    font_sub = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 30)
    tx = W * 0.52
    d.text((tx, H * 0.40), 'CHROMALITH', font=font_big, anchor='lm', fill=(238, 242, 255))
    d.text((tx, H * 0.53), 'Weave the light', font=font_sub, anchor='lm', fill=(159, 180, 216))
    d.text((tx, H * 0.63), '1000 levels · 10 biomes', font=font_sub, anchor='lm', fill=(127, 168, 255))
    img.save(path)
    print('wrote', path)


make_icon(1024, os.path.join(OUT, 'icon-1024.png'))
make_icon(512, os.path.join(OUT, 'icon-512.png'))
make_icon(192, os.path.join(OUT, 'icon-192.png'))
make_icon(64, os.path.join(OUT, 'favicon.png'), with_mirrors=False)
make_og(os.path.join(OUT, 'og-image.png'))
print('ALL ICONS DONE')
