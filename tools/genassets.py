#!/usr/bin/env python3
"""Generate the Homey App Store images for Additional User Statuses.

    python3 tools/genassets.py                 # driver images, from each driver's icon.svg
    python3 tools/genassets.py --photo SRC     # app images, cropped to 10:7 from a photo

Driver images are the driver's own icon, drawn in the brand colour on white, so
they can never drift from the SVG. App images must be a photo (Athom rejects a
flat mark on a plain background), so they are cropped from one instead.

Requires ImageMagick (`magick`) for the SVGs and Pillow for the photo crop.
"""

import argparse
import pathlib
import subprocess
import tempfile

BRAND = "#3D5A96"
ROOT = pathlib.Path(__file__).resolve().parent.parent

DRIVER_SIZES = {"small": 75, "large": 500, "xlarge": 1000}
APP_SIZES = {"small": (250, 175), "large": (500, 350), "xlarge": (1000, 700)}

# Share of the square the mark fills; the rest is white margin.
MARK_SCALE = 0.72


def driver_images():
    for svg in sorted(ROOT.glob("drivers/*/assets/icon.svg")):
        # The icon is white for Homey's mask rendering; recolour it for a white background.
        coloured = svg.read_text().replace("#FFFFFF", BRAND)
        with tempfile.NamedTemporaryFile("w", suffix=".svg") as tmp:
            tmp.write(coloured)
            tmp.flush()
            for name, size in DRIVER_SIZES.items():
                out = svg.parent / "images" / f"{name}.png"
                mark = round(size * MARK_SCALE)
                subprocess.run([
                    "magick", "-background", "white", "-density", "600", tmp.name,
                    "-resize", f"{mark}x{mark}", "-gravity", "center",
                    "-extent", f"{size}x{size}", "-alpha", "remove", "-strip", str(out),
                ], check=True)
                print(f"wrote {out.relative_to(ROOT)} ({size}x{size})")


def app_images(src):
    from PIL import Image

    im = Image.open(src).convert("RGB")
    w, h = im.size
    tw = round(h * 10 / 7)
    if tw <= w:
        box = ((w - tw) // 2, 0, (w - tw) // 2 + tw, h)
    else:
        th = round(w * 0.7)
        box = (0, (h - th) // 2, w, (h - th) // 2 + th)
    crop = im.crop(box)
    for name, size in APP_SIZES.items():
        out = ROOT / "assets" / "images" / f"{name}.jpg"
        crop.resize(size, Image.LANCZOS).save(out, quality=88, optimize=True)
        print(f"wrote {out.relative_to(ROOT)} ({size[0]}x{size[1]})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--photo", help="source photo for the three app images")
    args = ap.parse_args()
    if args.photo:
        app_images(args.photo)
    else:
        driver_images()


if __name__ == "__main__":
    main()
