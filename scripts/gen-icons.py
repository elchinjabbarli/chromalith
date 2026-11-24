#!/usr/bin/env python3
"""Generate all Chromalith icons + OG image — v1.2 obsidian prism design.

The icon mirrors the menu logo: an obsidian monolith splitting a single
white beam into a four-color spectrum, on a deep-space gradient.
"""
from PIL import Image, ImageDraw, ImageFilter
import math
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'docs')
os.makedirs(OUT, exist_ok=True)

BG_TOP = (37, 49, 92)     # --bg3
BG_MID = (20, 29, 56)     # --bg2
BG_BOT = (11, 16, 32)     # --bg1
RED = (255, 85, 102)
GOLD = (255, 210, 63)
TEAL = (46, 230, 214)
BLUE = (77, 157, 255)
VIOLET = (183, 139, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_bg(size):
    img = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / size
        if t < 0.5:
            c = lerp(BG_TOP, BG_MID, t * 2)
        else:
            c = lerp(BG_MID, BG_BOT, (t - 0.5) * 2)
        d.line([(0, y), (size, y)], fill=c)
    return img


def add_nebula(img, cx, cy, r, color, strength):
    """soft radial glow"""
    size = img.size[0]
    glow = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(glow)
    steps = 24
    for i in range(steps, 0, -1):
        rr = r * i / steps
        v = int(255 * strength * (1 - i / steps) ** 2)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=v)
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.03))
    tint = Image.new('RGB', (size, size), color)
    img.paste(tint, (0, 0), glow)


def add_stars(img, seed, n, bright_n):
    import random
    rng = random.Random(seed)
    size = img.size[0]
    d = ImageDraw.Draw(img)
    for _ in range(n):
        x = rng.uniform(0.05, 0.95) * size
        y = rng.uniform(0.05, 0.95) * size
        r = rng.uniform(0.003, 0.008) * size
        o = rng.uniform(60, 140)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(int(223 * o / 255), int(232 * o / 255), int(255 * o / 255)))
    for _ in range(bright_n):
        x = rng.uniform(0.08, 0.92) * size
        y = rng.uniform(0.08, 0.92) * size
        r = rng.uniform(0.008, 0.014) * size
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255))


def draw_monolith(d, s):
    """monolith prism: front-left lit face, dark side face, top face."""
    Ax, Ay = 0.30, 0.34   # front-left top
    Bx, By = 0.46, 0.42   # center ridge top
    Ex, Ey = 0.62, 0.42   # right bottom of top face
    Cx, Cy = 0.62, 0.31   # top back
    Dx, Dy = 0.46, 0.50   # top ridge peak
    P = lambda fx, fy: (fx * s, fy * s)

    # side face (darkest)
    d.polygon([P(Bx, By), P(Ex, Ey), P(Ex, Ey + 0.30), P(Bx, By + 0.30)], fill=(14, 19, 38))
    # front face (lit gradient simulated with two tones)
    d.polygon([P(Ax, Ay), P(Bx, By), P(Bx, By + 0.30), P(Ax, Ay + 0.30)], fill=(52, 68, 122))
    d.polygon([P(Ax, Ay), P(Ax, Ay + 0.30), P(Ax + 0.08, Ay + 0.34), P(Ax + 0.08, Ay + 0.04)], fill=(84, 104, 168))
    # top face
    d.polygon([P(Ax, Ay), P(Dx, Dy - 0.02), P(Cx, Cy)], fill=(96, 116, 180))
    # top face back hint
    d.polygon([P(Dx, Dy - 0.02), P(Cx, Cy), P(Cx, Cy + 0.05)], fill=(20, 27, 52))
    # edge highlight
    d.line([P(Ax, Ay), P(Bx, By), P(Bx, By + 0.30)], fill=(158, 176, 232), width=max(1, int(s * 0.008)))
    # inner glow slot
    d.polygon([P(Bx - 0.025, By + 0.02), P(Bx - 0.005, By + 0.03), P(Bx - 0.005, By + 0.28), P(Bx - 0.025, By + 0.27)], fill=(127, 168, 255))


def draw_beams(d, s):
    """white beam in from left; spectrum out to the right"""
    P = lambda fx, fy: (fx * s, fy * s)
    iny = 0.40
    d.polygon([P(0.0, iny - 0.012), P(0.46, iny + 0.012), P(0.46, iny + 0.028), P(0.0, iny + 0.004)], fill=(255, 255, 255))
    beams = [
        (RED,   0.42, -0.16),
        (GOLD,  0.44, -0.055),
        (TEAL,  0.46, 0.05),
        (BLUE,  0.48, 0.16),
    ]
    for color, y0, dy in beams:
        d.polygon([
            P(0.46, y0), P(1.0, y0 + dy - 0.016), P(1.0, y0 + dy + 0.016)
        ], fill=color)


def draw_gem(d, s):
    cx, cy, r = 0.80, 0.70, 0.055
    pts = []
    for k in range(4):
        a = math.pi / 2 * k + math.pi / 4
        pts.append(((cx + math.cos(a) * r) * s, (cy + math.sin(a) * r * 0.9) * s))
    d.polygon(pts, fill=(255, 255, 255))
    d.polygon([pts[0], pts[1], (cx * s, cy * s)], fill=(230, 239, 255))


def icon(size, seed):
    img = make_bg(size)
    add_nebula(img, size * 0.25, size * 0.28, size * 0.34, VIOLET, 0.55)
    add_nebula(img, size * 0.78, size * 0.24, size * 0.30, BLUE, 0.5)
    add_nebula(img, size * 0.20, size * 0.80, size * 0.30, TEAL, 0.4)
    add_nebula(img, size * 0.82, size * 0.78, size * 0.28, RED, 0.4)
    add_stars(img, seed + 1, 34, 8)

    beams_glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    dg = ImageDraw.Draw(beams_glow)
    draw_beams(dg, size)
    beams_glow = beams_glow.filter(ImageFilter.GaussianBlur(size * 0.012))
    img = Image.alpha_composite(img.convert('RGBA'), beams_glow)

    d = ImageDraw.Draw(img)
    draw_beams(d, size)
    draw_monolith(d, size)
    draw_gem(d, size)
    return img.convert('RGB')


def favicon(size=64):
    img = make_bg(size)
    d = ImageDraw.Draw(img)
    P = lambda fx, fy: (fx * size, fy * size)
    d.polygon([P(0.34, 0.30), P(0.50, 0.40), P(0.50, 0.78), P(0.34, 0.68)], fill=(58, 74, 130))
    d.polygon([P(0.50, 0.40), P(0.66, 0.30), P(0.66, 0.68), P(0.50, 0.78)], fill=(18, 24, 46))
    d.polygon([P(0.34, 0.30), P(0.42, 0.24), P(0.58, 0.34), P(0.50, 0.40)], fill=(100, 120, 184))
    d.line([P(0.34, 0.30), P(0.50, 0.40), P(0.50, 0.78)], fill=(170, 188, 240), width=2)
    d.polygon([P(0.0, 0.36), P(0.50, 0.43), P(0.50, 0.47), P(0.0, 0.40)], fill=(255, 255, 255))
    d.polygon([P(0.50, 0.44), P(1.0, 0.24), P(1.0, 0.30)], fill=RED)
    d.polygon([P(0.50, 0.46), P(1.0, 0.62), P(1.0, 0.68)], fill=TEAL)
    return img


def make_bg_h(W, H):
    img = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        if t < 0.5:
            c = lerp(BG_TOP, BG_MID, t * 2)
        else:
            c = lerp(BG_MID, BG_BOT, (t - 0.5) * 2)
        d.line([(0, y), (W, y)], fill=c)
    return img


def og():
    W, H = 1200, 630
    img = make_bg_h(W, H)
    add_nebula(img, W * 0.22, H * 0.30, W * 0.30, VIOLET, 0.5)
    add_nebula(img, W * 0.80, H * 0.26, W * 0.26, BLUE, 0.45)
    add_nebula(img, W * 0.30, H * 0.85, W * 0.26, TEAL, 0.35)
    add_nebula(img, W * 0.85, H * 0.82, W * 0.22, RED, 0.35)
    add_stars(img, 99, 90, 22)

    art = icon(1200, seed=7)
    img.paste(art, (int(W * 0.06), int((H - 1200) / 2) + 60))

    d = ImageDraw.Draw(img)
    try:
        from PIL import ImageFont
        font_main = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 92)
        font_sub = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 30)
    except Exception:
        font_main = font_sub = None
    tx = int(W * 0.60)
    ty = int(H * 0.30)
    d.text((tx, ty), 'CHROMALITH', fill=(238, 242, 255), font=font_main)
    d.text((tx + 6, ty + 116), 'WEAVE THE LIGHT', fill=(127, 168, 255), font=font_sub)
    d.text((tx + 6, ty + 180), '1000 levels - 10 biomes', fill=(150, 165, 205), font=font_sub)
    return img


if __name__ == '__main__':
    for size, name in [(1024, 'icon-1024.png'), (512, 'icon-512.png'), (192, 'icon-192.png')]:
        icon(size, seed=size).save(os.path.join(OUT, name))
        print(f'{name} saved')
    favicon(64).save(os.path.join(OUT, 'favicon.png'))
    print('favicon.png saved')
    og().save(os.path.join(OUT, 'og-image.png'))
    print('og-image.png saved')
