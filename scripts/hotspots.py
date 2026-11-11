#!/usr/bin/env python3
"""
Check and snap hotspot positions against the real geometry of a GLB.

The app normalises every model the same way: largest dimension scaled to 1.0,
centred on x and z, base sitting at y = 0. This script reproduces that exactly,
so the numbers it prints are the numbers that go into data/machines.json.

  check   how far each hotspot in machines.json sits from the model surface
  snap    move each hotspot onto the nearest surface, pushed out along the normal
  box     print the model's bounding box and some reference heights

Usage:
  python3 scripts/hotspots.py check                 every machine
  python3 scripts/hotspots.py check computer        one machine
  python3 scripts/hotspots.py snap computer         print snapped coordinates
  python3 scripts/hotspots.py box computer

A hotspot more than ~0.04 from the surface is either floating in mid-air or
buried inside the model; either way its label will not line up with anything.
"""
import json
import os
import struct
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "data", "machines.json")
PUBLIC = os.path.join(ROOT, "public")

# A hotspot further than this from the surface is reported as misplaced.
TOLERANCE = 0.04
# How far outside the surface a snapped hotspot is placed, so its dot is visible.
STANDOFF = 0.015

_COMPONENT = {
    5120: ("b", 1, 127.0),
    5121: ("B", 1, 255.0),
    5122: ("h", 2, 32767.0),
    5123: ("H", 2, 65535.0),
    5125: ("I", 4, None),
    5126: ("f", 4, None),
}
_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path):
    """Return (gltf json, binary chunk) for a .glb file."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != b"glTF":
        raise ValueError(f"{path} is not a binary glTF (.glb)")
    pos, js, bin_chunk = 12, None, b""
    while pos + 8 <= len(data):
        length, kind = struct.unpack("<II", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        if kind == 0x4E4F534A:
            js = json.loads(body)
        elif kind == 0x004E4942:
            bin_chunk = body
        pos += 8 + length + ((4 - length % 4) % 4 if length % 4 else 0)
    if js is None:
        raise ValueError(f"{path} has no JSON chunk")
    return js, bin_chunk


def accessor(gltf, blob, index):
    """Decode one accessor into an (n, components) float array."""
    acc = gltf["accessors"][index]
    fmt, size, norm_div = _COMPONENT[acc["componentType"]]
    comps = _COUNT[acc["type"]]
    count = acc["count"]
    out = np.zeros((count, comps), dtype=np.float64)
    if "bufferView" not in acc:
        return out
    view = gltf["bufferViews"][acc["bufferView"]]
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride") or size * comps
    raw = np.frombuffer(blob, dtype=np.uint8)
    rows = np.lib.stride_tricks.as_strided(
        raw[base:], shape=(count, size * comps), strides=(stride, 1)
    ).copy()
    vals = rows.view(np.dtype("<" + fmt)).reshape(count, comps).astype(np.float64)
    # KHR_mesh_quantization stores positions as normalised integers.
    if acc.get("normalized") and norm_div:
        vals = np.maximum(vals / norm_div, -1.0)
    return vals


def node_matrix(node):
    """Local transform of a node, as a 4x4 matrix."""
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in node:
        m = np.diag(list(node["scale"]) + [1.0]) @ m
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        rot = np.array(
            [
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
                [0, 0, 0, 1],
            ]
        )
        m = rot @ m
    if "translation" in node:
        t = np.eye(4)
        t[:3, 3] = node["translation"]
        m = t @ m
    return m


def triangles(path):
    """Every triangle in the file, in world space, as an (n, 3, 3) array."""
    gltf, blob = read_glb(path)
    nodes = gltf.get("nodes", [])
    tris = []

    def walk(index, parent):
        node = nodes[index]
        world = parent @ node_matrix(node)
        if "mesh" in node:
            for prim in gltf["meshes"][node["mesh"]].get("primitives", []):
                if prim.get("mode", 4) != 4 or "POSITION" not in prim.get("attributes", {}):
                    continue
                pos = accessor(gltf, blob, prim["attributes"]["POSITION"])[:, :3]
                pos = (world[:3, :3] @ pos.T).T + world[:3, 3]
                if "indices" in prim:
                    idx = accessor(gltf, blob, prim["indices"]).astype(np.int64).ravel()
                else:
                    idx = np.arange(len(pos))
                idx = idx[: (len(idx) // 3) * 3]
                if len(idx):
                    tris.append(pos[idx].reshape(-1, 3, 3))
        for child in node.get("children", []):
            walk(child, world)

    scene = gltf.get("scenes", [{}])[gltf.get("scene", 0)]
    for index in scene.get("nodes", range(len(nodes))):
        walk(index, np.eye(4))
    if not tris:
        raise ValueError(f"{path} has no triangles")
    return np.concatenate(tris, axis=0)


def normalise(tris):
    """Scale to largest dimension 1.0, centre x/z, sit the base at y = 0."""
    pts = tris.reshape(-1, 3)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    span = float((hi - lo).max())
    if span <= 0:
        raise ValueError("model has no size")
    out = tris / span
    lo, hi = out.reshape(-1, 3).min(axis=0), out.reshape(-1, 3).max(axis=0)
    shift = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    return out - shift


def nearest(tris, point):
    """Closest point on the triangle soup, and its distance.

    Projects onto each triangle's plane, clamps to the triangle by
    barycentric coordinates, then falls back to the edges when outside.
    """
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    ab, ac, ap = b - a, c - a, point - a

    d1 = np.einsum("ij,ij->i", ab, ap)
    d2 = np.einsum("ij,ij->i", ac, ap)
    bp = point - b
    d3 = np.einsum("ij,ij->i", ab, bp)
    d4 = np.einsum("ij,ij->i", ac, bp)
    cp = point - c
    d5 = np.einsum("ij,ij->i", ab, cp)
    d6 = np.einsum("ij,ij->i", ac, cp)

    vc = d1 * d4 - d3 * d2
    vb = d5 * d2 - d1 * d6
    va = d3 * d6 - d5 * d4
    denom = va + vb + vc
    with np.errstate(divide="ignore", invalid="ignore"):
        v = np.where(denom != 0, vb / denom, 0.0)
        w = np.where(denom != 0, vc / denom, 0.0)
    v = np.clip(np.nan_to_num(v), 0.0, 1.0)
    w = np.clip(np.nan_to_num(w), 0.0, 1.0)
    over = v + w > 1.0
    total = np.where(over, v + w, 1.0)
    v, w = v / total, w / total

    closest = a + ab * v[:, None] + ac * w[:, None]
    dist = np.linalg.norm(closest - point, axis=1)
    i = int(np.argmin(dist))
    normal = np.cross(ab[i], ac[i])
    length = np.linalg.norm(normal)
    normal = normal / length if length > 0 else np.array([0.0, 0.0, 1.0])
    return closest[i], float(dist[i]), normal


def load_config():
    with open(CONFIG) as fh:
        return json.load(fh)


def machine_tris(entry):
    path = os.path.join(PUBLIC, entry["complete"].lstrip("/"))
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    return normalise(triangles(path))


def cmd_check(names):
    config = load_config()
    bad = 0
    for name in names:
        entry = config[name]
        if "spots" not in entry:
            print(f"{name}: step-by-step teardown, no hotspots to check")
            continue
        tris = machine_tris(entry)
        print(f"\n{name}  ({len(tris):,} triangles)")
        for part, spot in entry["spots"].items():
            point = np.array(spot[:3], dtype=np.float64)
            _, dist, _ = nearest(tris, point)
            flag = "  <-- MISPLACED" if dist > TOLERANCE else ""
            if dist > TOLERANCE:
                bad += 1
            print(f"  {part:<12} {dist:6.3f} from surface{flag}")
    print(f"\n{bad} hotspot(s) outside tolerance ({TOLERANCE})")
    return 1 if bad else 0


def cmd_snap(names):
    config = load_config()
    for name in names:
        entry = config[name]
        if "spots" not in entry:
            continue
        tris = machine_tris(entry)
        print(f'\n"{name}": spots (snapped)')
        for part, spot in entry["spots"].items():
            point = np.array(spot[:3], dtype=np.float64)
            surface, dist, normal = nearest(tris, point)
            if np.dot(point - surface, normal) < 0:
                normal = -normal
            moved = surface + normal * STANDOFF
            angle = spot[3] if len(spot) > 3 else 0
            print(
                f'  "{part}": [{moved[0]:.3f}, {moved[1]:.3f}, {moved[2]:.3f}, {angle}],'
                f"   (was {dist:.3f} away)"
            )
    return 0


def cmd_box(names):
    config = load_config()
    for name in names:
        tris = machine_tris(config[name])
        pts = tris.reshape(-1, 3)
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        print(f"\n{name}")
        print(f"  x {lo[0]:+.3f} .. {hi[0]:+.3f}   width  {hi[0] - lo[0]:.3f}")
        print(f"  y {lo[1]:+.3f} .. {hi[1]:+.3f}   height {hi[1] - lo[1]:.3f}")
        print(f"  z {lo[2]:+.3f} .. {hi[2]:+.3f}   depth  {hi[2] - lo[2]:.3f}")
    return 0


def main():
    args = sys.argv[1:]
    if not args or args[0] not in {"check", "snap", "box"}:
        print(__doc__)
        return 2
    action, rest = args[0], args[1:]
    config = load_config()
    names = rest or [k for k in config if not k.startswith("_")]
    missing = [n for n in names if n not in config]
    if missing:
        print(f"unknown machine(s): {', '.join(missing)}")
        return 2
    return {"check": cmd_check, "snap": cmd_snap, "box": cmd_box}[action](names)


if __name__ == "__main__":
    sys.exit(main())
