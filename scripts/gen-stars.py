#!/usr/bin/env python3
"""Generate starfield + nebula SVG snippets for the new background stage."""
import random

rng = random.Random(20261124)

def sparkle_star(x, y, s, color, op):
    q = s * 0.16
    return (f'<path d="M{x} {y-s} Q{x+q} {y-q} {x+s} {y} Q{x+q} {y+q} {x} {y+s} '
            f'Q{x-q} {y+q} {x-s} {y} Q{x-q} {y-q} {x} {y-s} Z" fill="{color}" opacity="{op}"/>')

# layer A: tiny far stars (drift slowly up)
a = []
for _ in range(46):
    x, y = rng.uniform(0, 1440), rng.uniform(0, 900)
    r = rng.uniform(0.7, 1.4)
    o = rng.uniform(0.25, 0.6)
    a.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r:.1f}" fill="#dfe8ff" opacity="{o:.2f}"/>')

# layer B: nearer stars, a few twinkle
b = []
for i in range(22):
    x, y = rng.uniform(0, 1440), rng.uniform(0, 900)
    r = rng.uniform(1.5, 2.4)
    o = rng.uniform(0.5, 0.9)
    if i % 3 == 0:
        d = rng.uniform(2.4, 5.2)
        b.append(f'<circle class="tw" style="--d:{d:.1f}s" cx="{x:.0f}" cy="{y:.0f}" r="{r:.1f}" fill="#ffffff" opacity="{o:.2f}"/>')
    else:
        b.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r:.1f}" fill="#eaf0ff" opacity="{o:.2f}"/>')

# accent sparkles (4-point, biome accent colored)
c = [sparkle_star(*p) for p in [
    (rng.uniform(60, 380), rng.uniform(60, 320), rng.uniform(4, 6), 'var(--accent)', 0.85),
    (rng.uniform(950, 1380), rng.uniform(90, 360), rng.uniform(4, 7), 'var(--accent)', 0.75),
    (rng.uniform(200, 620), rng.uniform(560, 840), rng.uniform(4, 6), 'var(--accent)', 0.7),
    (rng.uniform(820, 1300), rng.uniform(560, 850), rng.uniform(4, 6), 'var(--accent)', 0.8),
]]

print('<!-- stars A -->')
print(''.join(a))
print()
print('<!-- stars B -->')
print(''.join(b))
print()
print('<!-- sparkles -->')
print(''.join(c))
