#!/usr/bin/env python3
"""
Scale a GLB so its largest dimension is 1.0, its base sits on y = 0 and it is
centred on x and z.

The sandbox does not normalise models when it loads them: it multiplies the raw
coordinates by the machine's `scale` and nothing else. Hotspot positions in
data/machines.json are written as if every model were one unit across, so a
model that is 1.9 units tall puts its machine at nearly twice the intended size
and every hotspot in the wrong place.

gltfpack and shrinktex.py both leave the coordinates alone, so run this after
them on any single-piece model. For a parts model, scripts/pose.py does the
same thing as part of posing, across all the parts at once.

Usage:
  python3 scripts/normalise.py in.glb out.glb
  python3 scripts/normalise.py --check in.glb      # report, change nothing
"""
import json
import struct
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from hotspots import node_matrix, triangles  # noqa: E402
from pose import write_glb  # noqa: E402


def read_glb(path):
    with open(path, "rb") as fh:
        data = fh.read()
    pos, js, blob = 12, None, b""
    while pos + 8 <= len(data):
        length, kind = struct.unpack("<II", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        if kind == 0x4E4F534A:
            js = json.loads(body)
        elif kind == 0x004E4942:
            blob = body
        pos += 8 + length + ((4 - length % 4) % 4 if length % 4 else 0)
    return js, blob


def main():
    args = sys.argv[1:]
    check = args and args[0] == "--check"
    if check:
        args = args[1:]
    if not args or (not check and len(args) < 2):
        print(__doc__)
        return 2

    src = args[0]
    tris = triangles(src)
    pts = tris.reshape(-1, 3)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    span = hi - lo
    biggest = float(span.max())

    print(f"{src}")
    print(f"  size {np.round(span, 3)}   largest {biggest:.3f}")
    if check:
        if abs(biggest - 1.0) < 0.01 and abs(lo[1]) < 0.01:
            print("  already normalised")
        else:
            print("  NOT normalised - hotspots for this model will be wrong")
        return 0

    s = 1.0 / biggest
    shift = np.array([-(lo[0] + hi[0]) / 2 * s, -lo[1] * s, -(lo[2] + hi[2]) / 2 * s])

    gltf, blob = read_glb(src)
    scene = gltf.get("scenes", [{}])[gltf.get("scene", 0)]
    roots = scene.get("nodes", list(range(len(gltf.get("nodes", [])))))

    for index in roots:
        node = gltf["nodes"][index]
        # Fold the existing transform into the new one rather than replacing it.
        m = node_matrix(node)
        m[:3, 3] = m[:3, 3] * s + shift
        m[:3, :3] *= s
        node.pop("rotation", None)
        node.pop("translation", None)
        node.pop("scale", None)
        node["matrix"] = [round(float(v), 8) for v in m.T.reshape(-1)]

    write_glb(args[1], gltf, blob)
    print(f"  -> {args[1]}  scaled by {s:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
