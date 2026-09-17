#!/usr/bin/env python3
"""Measure design diversity from the rendered layouts themselves.

The qualification report's archetype figure is a label the model reports about its own
output. This script ignores labels and measures the geometry that was actually produced,
so "are the designs really different?" is answered from artifacts, not self-assessment.

Run: python3 measure_layout_diversity.py [briefs_dir]
"""
import json, os, sys, itertools
from collections import Counter

briefs_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'briefs')

def load():
    out = []
    for name in sorted(os.listdir(briefs_dir)):
        p = os.path.join(briefs_dir, name, 'layout.json')
        if os.path.exists(p):
            out.append((name, json.load(open(p))))
    return out

def q(v, total, steps=20):
    """Quantise a coordinate to 1/steps of the canvas dimension."""
    return round(v / total * steps)

def signature(d):
    w, h = d['width'], d['height']
    text = sorted(d.get('text', []), key=lambda t: (t.get('y', 0), t.get('x', 0)))
    blocks = tuple(
        (t.get('role'), t.get('align'), q(t.get('x', 0), w), q(t.get('y', 0), h), q(t.get('width', 0), w))
        for t in text
    )
    shapes = tuple(sorted(Counter(s.get('kind') for s in d.get('shapes', [])).items()))
    bg = 'image' if d.get('background', {}).get('imageUrl') else (
        'gradient' if d.get('background', {}).get('gradient') else 'color')
    return {
        'blocks': blocks,
        'shapes': shapes,
        'bg': bg,
        'aligns': tuple(t.get('align') for t in text),
        'fonts': tuple(sorted({t.get('fontFamily') for t in text})),
        'grid_columns': d.get('grid', {}).get('columns'),
        'genre': d.get('genre'),
        'n_text': len(text),
        'n_shapes': len(d.get('shapes', [])),
        'size': f"{w}x{h}",
    }

def jaccard_blocks(a, b):
    sa, sb = set(a['blocks']), set(b['blocks'])
    return len(sa & sb) / len(sa | sb) if (sa | sb) else 1.0

rows = load()
sigs = [(name, signature(d)) for name, d in rows]
print(f"layouts measured: {len(sigs)}\n")

def tally(label, keyfn):
    c = Counter(keyfn(s) for _, s in sigs)
    print(f"{label}: {len(c)} distinct over {len(sigs)} layouts")
    for k, n in c.most_common():
        print(f"    {n:>2}x  {k}")
    print()

tally('Full geometric signature', lambda s: hash((s['blocks'], s['shapes'], s['bg'])))
tally('Alignment pattern', lambda s: s['aligns'])
tally('Shape vocabulary', lambda s: s['shapes'])
tally('Background treatment', lambda s: s['bg'])
tally('Font set', lambda s: s['fonts'])
tally('Grid columns', lambda s: s['grid_columns'])
tally('Text block count', lambda s: s['n_text'])

print("Pairwise block-position overlap within each canvas size (1.0 = identical placement):")
by_size = {}
for name, s in sigs:
    by_size.setdefault(s['size'], []).append((name, s))
worst = []
for size, group in sorted(by_size.items()):
    if len(group) < 2:
        continue
    pairs = [(a[0], b[0], jaccard_blocks(a[1], b[1])) for a, b in itertools.combinations(group, 2)]
    avg = sum(p[2] for p in pairs) / len(pairs)
    mx = max(pairs, key=lambda p: p[2])
    print(f"  {size}: {len(group)} layouts, mean overlap {avg:.3f}, max {mx[2]:.3f} ({mx[0]} vs {mx[1]})")
    worst.extend(pairs)
if worst:
    identical = [p for p in worst if p[2] >= 0.95]
    print(f"\n  pairs at >= 0.95 overlap (effectively the same skeleton): {len(identical)}")
    for a, b, v in identical:
        print(f"    {v:.3f}  {a} vs {b}")
