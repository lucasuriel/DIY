#!/usr/bin/env python3
"""
Shrink the textures embedded in a GLB and re-save it.

Meshy exports 4K textures, which dominate the file size: a model can be 30 MB
of which 28 MB is three images nobody looks at closely. At the size these
models appear on screen, 1024 px is indistinguishable from 4096 px.

Run gltfpack first for the geometry, then this for the textures.

Usage:
  python3 scripts/shrinktex.py in.glb out.glb [max_px] [quality]

  max_px   longest edge of each texture, default 1024
  quality  JPEG quality, default 88

Images with transparency are kept as PNG; everything else becomes JPEG.
"""
import json
import os
import struct
import sys
from io import BytesIO

from PIL import Image

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def read_glb(path):
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != b"glTF":
        raise ValueError(f"{path} is not a .glb")
    pos, js, blob = 12, None, b""
    while pos + 8 <= len(data):
        length, kind = struct.unpack("<II", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        if kind == JSON_CHUNK:
            js = json.loads(body)
        elif kind == BIN_CHUNK:
            blob = body
        pos += 8 + length + ((4 - length % 4) % 4 if length % 4 else 0)
    return js, blob


def write_glb(path, gltf, blob):
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    blob += b"\0" * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as fh:
        fh.write(b"glTF" + struct.pack("<II", 2, total))
        fh.write(struct.pack("<II", len(js), JSON_CHUNK) + js)
        fh.write(struct.pack("<II", len(blob), BIN_CHUNK) + blob)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    max_px = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
    quality = int(sys.argv[4]) if len(sys.argv) > 4 else 88

    gltf, blob = read_glb(src)
    views = gltf.get("bufferViews", [])
    images = gltf.get("images", [])
    if not images:
        print("no embedded images; copying unchanged")
        write_glb(dst, gltf, blob)
        return 0

    # Rebuild the binary chunk, replacing each image's bytes as we go.
    parts = []
    offset = 0

    def place(raw):
        """Append bytes to the new buffer, 4-byte aligned, and return (offset, length)."""
        nonlocal offset
        pad = (4 - offset % 4) % 4
        if pad:
            parts.append(b"\0" * pad)
            offset += pad
        start = offset
        parts.append(raw)
        offset += len(raw)
        return start, len(raw)

    # Non-image views keep their data; image views get the resized bytes.
    image_views = {img["bufferView"]: i for i, img in enumerate(images) if "bufferView" in img}
    new_views = []
    saved = 0

    for index, view in enumerate(views):
        start = view.get("byteOffset", 0)
        raw = blob[start : start + view["byteLength"]]
        if index in image_views:
            before = len(raw)
            try:
                im = Image.open(BytesIO(raw))
                im.load()
                if max(im.size) > max_px:
                    scale = max_px / max(im.size)
                    im = im.resize(
                        (max(1, round(im.width * scale)), max(1, round(im.height * scale))),
                        Image.LANCZOS,
                    )
                out = BytesIO()
                if im.mode in ("RGBA", "LA", "P") and "transparency" in im.info:
                    im.convert("RGBA").save(out, "PNG", optimize=True)
                    mime = "image/png"
                else:
                    im.convert("RGB").save(out, "JPEG", quality=quality, optimize=True)
                    mime = "image/jpeg"
                raw = out.getvalue()
                images[image_views[index]]["mimeType"] = mime
                saved += before - len(raw)
            except Exception as exc:  # a texture that will not decode is left alone
                print(f"  image {image_views[index]}: left as-is ({exc})")
        byte_offset, length = place(raw)
        entry = dict(view)
        entry["byteOffset"] = byte_offset
        entry["byteLength"] = length
        entry.pop("byteStride", None) if index in image_views else None
        new_views.append(entry)

    gltf["bufferViews"] = new_views
    new_blob = b"".join(parts)
    gltf["buffers"] = [{"byteLength": len(new_blob)}]
    write_glb(dst, gltf, new_blob)

    print(
        f"{os.path.basename(src)} -> {os.path.basename(dst)}  "
        f"{os.path.getsize(src) / 1e6:.1f} MB -> {os.path.getsize(dst) / 1e6:.1f} MB "
        f"({len(images)} textures, {saved / 1e6:.1f} MB saved)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
