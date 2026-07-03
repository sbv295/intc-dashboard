"""
Process CEO cartoon images:
- Resize to consistent square dimensions
- Compress as PNG
- Output to ceo_cartoon/ folder

Assumes input images are already cropped to 1:1 aspect ratio manually.

Usage:
    python process_ceo_cartoons.py

Configuration (adjust as needed):
"""
from PIL import Image
import os

# --- Configuration ---
INPUT_DIR = "ceo_cartoon_raw"
OUTPUT_DIR = "ceo_cartoon"
OUTPUT_SIZE = 400          # Final square dimension in pixels
PNG_COMPRESS_LEVEL = 6     # 0-9, higher = smaller file but slower
# ---------------------


def process_image(input_path, output_path):
    """Resize and compress a single image."""
    img = Image.open(input_path).convert("RGBA")
    img = img.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)
    img.save(output_path, "PNG", optimize=True, compress_level=PNG_COMPRESS_LEVEL)


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    input_dir = os.path.join(script_dir, INPUT_DIR)
    output_dir = os.path.join(script_dir, OUTPUT_DIR)

    os.makedirs(output_dir, exist_ok=True)

    images = sorted([f for f in os.listdir(input_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg'))])

    print(f"Processing {len(images)} images from '{INPUT_DIR}' -> '{OUTPUT_DIR}'")
    print(f"Output: {OUTPUT_SIZE}x{OUTPUT_SIZE}px PNG\n")

    for img_name in images:
        input_path = os.path.join(input_dir, img_name)
        out_name = os.path.splitext(img_name)[0].lower() + ".png"
        output_path = os.path.join(output_dir, out_name)

        process_image(input_path, output_path)

        in_size = os.path.getsize(input_path) / 1024
        out_size = os.path.getsize(output_path) / 1024
        print(f"  {img_name:25s} -> {out_name:25s} ({in_size:.0f}KB -> {out_size:.0f}KB)")

    print(f"\nDone! {len(images)} images saved to '{OUTPUT_DIR}/'")


if __name__ == "__main__":
    main()
