#!/usr/bin/env python3
"""
Combine several GLB files into one, keeping each file's geometry and textures.

The sandbox loads exactly one parts file per machine, so anything that should
appear beside a machine - a battery pack, a sensor band, a tool - has to live
in that same file. This merges them and gives every top-level node a name, so
scripts/pose.py can place each one and the app can address it as a part.

Usage:
  python3 scripts/merge.py out.glb arm=parts.glb battery=battery.glb emg=emg.glb

Each argument is <name>=<file>. A file with one top-level node gets that name.
A file with several gets name0, name1, ... in the order they appear, which is
what a parts sheet produces.

Everything is re-indexed as it is copied: buffer views, accessors, materials,
textures and images all shift by the number already in the output, so nothing
from one file can point at another file's data.
"""
import json
import struct
import sys

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942

# Properties that hold an index into another top-level array, by the array they index.
LINKS = {
    "bufferView": "bufferViews",
    "buffer": "buffers",
    "indices": "accessors",
    "sampler": "samplers",
    "source": "images",
    "index": "textures",
    "mesh": "meshes",
    "material": "materials",
    "camera": "cameras",
    "skin": "skins",
}


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


def shift(value, offsets, key=None):
    """Walk a JSON value, adding the right offset to every index it holds."""
    if isinstance(value, dict):
        # A primitive's "attributes" (and a morph target) is a dict whose every
        # value is an accessor index, keyed by POSITION, NORMAL, TEXCOORD_0 and
        # so on. The keys carry no clue that they are indices, so they have to be
        # handled here or each merged file keeps pointing at the first one's mesh.
        if key in {"attributes", "targets"} and all(isinstance(v, int) for v in value.values()):
            return {k: v + offsets["accessors"] for k, v in value.items()}
        return {
            k: (v + offsets[LINKS[k]] if k in LINKS and isinstance(v, int) else shift(v, offsets, k))
            for k, v in value.items()
        }
    if isinstance(value, list):
        # "children" and "nodes" are lists of node indices; "joints" too.
        if key in {"children", "nodes", "joints"} and all(isinstance(v, int) for v in value):
            return [v + offsets["nodes"] for v in value]
        return [shift(v, offsets, key) for v in value]
    return value


def main():
    args = sys.argv[1:]
    if len(args) < 2 or "=" not in args[-1]:
        print(__doc__)
        return 2

    out_path, sources = args[0], args[1:]
    merged = {
        "asset": {"version": "2.0", "generator": "DIY merge.py"},
        "scene": 0,
        "scenes": [{"nodes": []}],
        "nodes": [],
        "meshes": [],
        "materials": [],
        "accessors": [],
        "bufferViews": [],
        "textures": [],
        "images": [],
        "samplers": [],
    }
    blob = bytearray()
    extensions_used = []
    extensions_required = []

    for spec in sources:
        name, _, path = spec.partition("=")
        gltf, data = read_glb(path)

        offsets = {k: len(merged.get(k, [])) for k in merged if isinstance(merged.get(k), list)}
        offsets["buffers"] = 0  # everything ends up in the single merged buffer

        # Pad so this file's data starts 4-byte aligned, then note where it went.
        pad = (4 - len(blob) % 4) % 4
        blob.extend(b"\0" * pad)
        base = len(blob)
        blob.extend(data)

        for key in ("meshes", "materials", "accessors", "textures", "images", "samplers"):
            for item in gltf.get(key, []):
                merged[key].append(shift(item, offsets))

        for view in gltf.get("bufferViews", []):
            copy = shift(view, offsets)
            copy["buffer"] = 0
            copy["byteOffset"] = view.get("byteOffset", 0) + base
            merged["bufferViews"].append(copy)

        scene = gltf.get("scenes", [{}])[gltf.get("scene", 0)]
        roots = scene.get("nodes", list(range(len(gltf.get("nodes", []))))) or []

        for node in gltf.get("nodes", []):
            merged["nodes"].append(shift(node, offsets))

        single = len(roots) == 1
        for order, index in enumerate(roots):
            new_index = index + offsets["nodes"]
            merged["nodes"][new_index]["name"] = name if single else f"{name}{order}"
            merged["scenes"][0]["nodes"].append(new_index)

        for ext in gltf.get("extensionsUsed", []):
            if ext not in extensions_used:
                extensions_used.append(ext)
        for ext in gltf.get("extensionsRequired", []):
            if ext not in extensions_required:
                extensions_required.append(ext)

        print(f"  {path}: {len(roots)} top-level node(s) -> {name}")

    merged["buffers"] = [{"byteLength": len(blob)}]
    if extensions_used:
        merged["extensionsUsed"] = extensions_used
    if extensions_required:
        merged["extensionsRequired"] = extensions_required
    for key in [k for k, v in merged.items() if isinstance(v, list) and not v]:
        del merged[key]

    write_glb(out_path, merged, bytes(blob))
    names = [merged["nodes"][i]["name"] for i in merged["scenes"][0]["nodes"]]
    print(f"wrote {out_path}: {', '.join(names)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
