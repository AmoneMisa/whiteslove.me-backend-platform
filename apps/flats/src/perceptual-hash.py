#!/usr/bin/env python3
import io
import sys

from PIL import Image, ImageOps


def dhash64(data: bytes) -> str:
    with Image.open(io.BytesIO(data)) as image:
        image = ImageOps.exif_transpose(image).convert('L').resize((9, 8), Image.Resampling.LANCZOS)
        pixels = list(image.getdata())

    value = 0
    bit = 0
    for row in range(8):
        offset = row * 9
        for col in range(8):
            if pixels[offset + col] > pixels[offset + col + 1]:
                value |= 1 << bit
            bit += 1
    return f'{value:016x}'


def main() -> int:
    data = sys.stdin.buffer.read()
    if not data:
        return 2
    try:
        sys.stdout.write(dhash64(data))
        return 0
    except Exception as exc:
        sys.stderr.write(str(exc)[:240])
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
