#!/usr/bin/env python3
"""
Give the named nodes of a parts GLB the positions they hold in the assembled
machine, and write the posed file.

A Meshy parts sheet has every piece laid out flat with arbitrary rotations. The
sandbox expects the opposite: each part sitting where it belongs in the finished
machine, so that "assembled" is the parts at rest and the exploded view just
slides them apart. This script bakes that pose.

Poses are written in a small JSON file:

  {
    "model_part1": {"align": [-0.04, -0.995, 0.09], "flip": true,
                    "centre": "xz", "base": 0.25},
    "model_part0": {"align": [0.712, -0.702, 0.008], "roll": 90,
                    "centre": "xz", "base": 1.30}
  }

  align   a direction in the part's own space that should end up pointing up (+Y).
          scripts/pose.py --axes prints each part's principal axis to start from.
  flip    reverse that direction, when the part comes out upside down
  roll    degrees to spin about Y afterwards, to face the part the right way
  centre  "xz" puts the part's centre on the Y axis; omit to leave it where it is
  base    where the bottom of the part sits on the Y axis after all that
  offset  [x, y, z] nudge applied last

Usage:
  python3 scripts/pose.py --axes parts.glb            # what are the parts?
  python3 scripts/pose.py parts.glb poses.json out.glb
"""
import json
import struct
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from hotspots import accessor, node_matrix, read_glb  # noqa: E402

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def write_glb(path, gltf, blob):
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    blob += b"\0" * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as fh:
        fh.write(b"glTF" + struct.pack("<II", 2, total))
        fh.write(struct.pack("<II", len(js), JSON_CHUNK) + js)
        fh.write(struct.pack("<II", len(blob), BIN_CHUNK) + blob)


def mesh_nodes(gltf):
    """Map the name a part is addressed by to the node that carries its mesh.

    Meshy wraps each mesh in a named parent, so the name and the geometry sit on
    different nodes. Walking down from each named node finds the pair.
    """
    nodes = gltf["nodes"]
    out = {}
    for i, n in enumerate(nodes):
        name = n.get("name")
        if not name:
            continue
        stack = [i]
        seen = set()
        while stack:
            j = stack.pop()
            if j in seen:
                continue
            seen.add(j)
            if "mesh" in nodes[j]:
                out[name] = (i, j)
                break
            stack.extend(nodes[j].get("children", []))
    # A named node with no children of its own still counts if it has the mesh.
    for i, n in enumerate(nodes):
        if n.get("name") and n.get("name") not in out and "mesh" in n:
            out[n["name"]] = (i, i)
    return out


def points(gltf, blob, named_node, mesh_node):
    """Mesh vertices in the named node's own space.

    gltfpack stores positions as quantised integers and puts the scale on the
    mesh node's matrix, so the raw accessor values mean nothing on their own.
    Everything from below the named node down to the mesh has to be applied.
    """
    nodes = gltf["nodes"]
    chain = []

    def find(i, path):
        if i == mesh_node:
            chain.extend(path + [i])
            return True
        return any(find(c, path + [i]) for c in nodes[i].get("children", []))

    find(named_node, [])
    world = np.eye(4)
    # The named node's own transform is what we are replacing, so skip it.
    for i in chain[1:] if len(chain) > 1 else chain:
        world = world @ node_matrix(nodes[i])

    n = nodes[mesh_node]
    prim = gltf["meshes"][n["mesh"]]["primitives"][0]
    pts = accessor(gltf, blob, prim["attributes"]["POSITION"])[:, :3]
    return (world[:3, :3] @ pts.T).T + world[:3, 3]


def rotation_to(v, target=(0.0, 1.0, 0.0)):
    """Quaternion (x, y, z, w) rotating direction v onto target."""
    a = np.asarray(v, dtype=float)
    a /= np.linalg.norm(a)
    b = np.asarray(target, dtype=float)
    b /= np.linalg.norm(b)
    d = float(np.dot(a, b))
    if d > 0.999999:
        return [0.0, 0.0, 0.0, 1.0]
    if d < -0.999999:
        # opposite: spin half a turn about any perpendicular axis
        axis = np.cross(a, [1.0, 0.0, 0.0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0.0, 0.0, 1.0])
        axis /= np.linalg.norm(axis)
        return [*axis, 0.0]
    axis = np.cross(a, b)
    q = np.array([*axis, 1.0 + d])
    return list(q / np.linalg.norm(q))


def quat_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


def quat_matrix(q):
    x, y, z, w = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def principal(pts):
    c = pts - pts.mean(axis=0)
    _, _, vt = np.linalg.svd(c[:: max(1, len(c) // 4000)], full_matrices=False)
    return vt[0]


def main():
    args = sys.argv[1:]
    if args and args[0] == "--axes":
        gltf, blob = read_glb(args[1])
        for name, (named, mesh_node) in sorted(mesh_nodes(gltf).items()):
            pts = points(gltf, blob, named, mesh_node)
            lo, hi = pts.min(axis=0), pts.max(axis=0)
            print(f"{name}")
            print(f"  size {np.round(hi - lo, 3)}   axis {np.round(principal(pts), 3)}")
        return 0

    if len(args) < 3:
        print(__doc__)
        return 2

    src, poses_path, dst = args[0], args[1], args[2]
    gltf, blob = read_glb(src)
    with open(poses_path) as fh:
        poses = json.load(fh)
    found = mesh_nodes(gltf)
    placed = {}

    for name, pose in poses.items():
        if name.startswith("_"):
            continue
        if name not in found:
            print(f"  {name}: not in this file (have: {', '.join(sorted(found))})")
            continue
        named_node, mesh_node = found[name]
        pts = points(gltf, blob, named_node, mesh_node)

        q = [0.0, 0.0, 0.0, 1.0]
        if "align" in pose:
            axis = np.asarray(pose["align"], dtype=float)
            if pose.get("flip"):
                axis = -axis
            q = rotation_to(axis)
        if pose.get("roll"):
            a = np.radians(pose["roll"]) / 2
            q = quat_mul([0.0, float(np.sin(a)), 0.0, float(np.cos(a))], q)
        # "rotate" is a plain x, y, z nudge in degrees, applied after the rest.
        # Principal-axis alignment gets a part standing up but says nothing about
        # which way it faces or how it leans, and that is what this corrects.
        for axis, degrees in enumerate(pose.get("rotate", [0, 0, 0])):
            if not degrees:
                continue
            a = np.radians(degrees) / 2
            v = [0.0, 0.0, 0.0]
            v[axis] = float(np.sin(a))
            q = quat_mul([*v, float(np.cos(a))], q)

        turned = (quat_matrix(q) @ pts.T).T
        lo, hi = turned.min(axis=0), turned.max(axis=0)
        t = np.zeros(3)
        if pose.get("centre") == "xz":
            t[0] = -(lo[0] + hi[0]) / 2
            t[2] = -(lo[2] + hi[2]) / 2
        if "base" in pose:
            t[1] = pose["base"] - lo[1]
        t += np.asarray(pose.get("offset", [0, 0, 0]), dtype=float)

        node = gltf["nodes"][named_node]
        node.pop("matrix", None)
        node["rotation"] = [round(v, 6) for v in q]
        node["translation"] = [round(float(v), 6) for v in t]
        placed[name] = (named_node, turned + t)
        size = np.round(hi - lo, 3)
        print(f"  {name}: size {size}  base y={pose.get('base', 0)}")

    # The app applies model.scale to raw GLB coordinates without normalising
    # anything, and hotspot positions are written as if the model were one unit
    # across. So the whole assembly is scaled here, as a group, to largest
    # dimension 1.0 with its base on y = 0 and centred on x and z.
    #
    # The scale has to go on the part nodes themselves, not on a parent: the app
    # reparents each named node to its own group, which would drop any ancestor
    # transform.
    if placed and poses.get("_normalise", True):
        every = np.concatenate([p for _, p in placed.values()])
        lo, hi = every.min(axis=0), every.max(axis=0)
        s = 1.0 / float((hi - lo).max())
        shift = np.array(
            [-(lo[0] + hi[0]) / 2 * s, -lo[1] * s, -(lo[2] + hi[2]) / 2 * s]
        )
        for name, (node_index, _) in placed.items():
            node = gltf["nodes"][node_index]
            t = np.asarray(node["translation"], dtype=float) * s + shift
            node["translation"] = [round(float(v), 6) for v in t]
            node["scale"] = [round(s, 8)] * 3
        print(f"normalised: {np.round(hi - lo, 3)} -> largest dimension 1.0")

    write_glb(dst, gltf, blob)
    print(f"wrote {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
