#!/usr/bin/env python3
"""Generate the Homey App Store images for Extra User Statuses.

The three store images are the same original mark as assets/icon.svg - a house
with two people cut out of it - drawn on the app's brand colour. Redraw them
with:  python3 tools/genassets.py

Requires Pillow only. Sizes are fixed by Homey: 250x175, 500x350, 1000x700.
"""

from PIL import Image, ImageDraw

BRAND = (61, 90, 150)
WHITE = (255, 255, 255)

SIZES = {"small": (250, 175), "large": (500, 350), "xlarge": (1000, 700)}

# Supersampling factor. The mark is all diagonals and circles, so drawing big and
# downscaling is what keeps the edges clean at 250x175.
SS = 4

# Geometry in the same 512x512 space as assets/icon.svg, so the two stay in sync.
HOUSE = [(256, 48), (480, 250), (424, 250), (424, 464), (88, 464), (88, 250), (32, 250)]
HEADS = [(196, 318), (316, 318)]
HEAD_R = 32
SHOULDERS = [(196, 444), (316, 444)]
SHOULDER_R = 50


def draw_mark(size):
    """Return an RGB image of the mark, centred, on the brand colour."""
    width, height = size[0] * SS, size[1] * SS
    img = Image.new("RGB", (width, height), BRAND)
    draw = ImageDraw.Draw(img)

    # Fit the 512x512 mark into the frame with a margin, then centre it.
    scale = min(width, height) / 512 * 0.62
    offset_x = (width - 512 * scale) / 2
    offset_y = (height - 512 * scale) / 2

    def pt(x, y):
        return (offset_x + x * scale, offset_y + y * scale)

    draw.polygon([pt(x, y) for x, y in HOUSE], fill=WHITE)

    # The people are cut out of the house, so they are drawn in the brand colour.
    for cx, cy in HEADS:
        draw.ellipse([pt(cx - HEAD_R, cy - HEAD_R), pt(cx + HEAD_R, cy + HEAD_R)], fill=BRAND)

    for cx, cy in SHOULDERS:
        box = [pt(cx - SHOULDER_R, cy - SHOULDER_R), pt(cx + SHOULDER_R, cy + SHOULDER_R)]
        draw.pieslice(box, start=180, end=360, fill=BRAND)

    return img.resize(size, Image.LANCZOS)


def main():
    for name, size in SIZES.items():
        path = f"assets/images/{name}.png"
        draw_mark(size).save(path)
        print(f"wrote {path} ({size[0]}x{size[1]})")


if __name__ == "__main__":
    main()
