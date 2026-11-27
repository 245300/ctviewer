#!/usr/bin/env python3
"""Build the multi-car model catalog and copy optimized GLB assets.

Sources are the CC-licensed GLB files listed in scripts/models.json.  The
script expects two working directories:

  models_src/   original downloads (kept outside the shipped project)
  build/models_opt/  gltf-transform optimized files

It produces:
  assets/models/<id>.glb
  assets/models/<id>.lod.glb
  assets/models/catalog.json
  js/catalog.js
  CREDITS.md
"""
from __future__ import annotations

import argparse
import json
import re
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TOOL = ROOT / "node_modules" / "@gltf-transform" / "cli" / "bin" / "cli.js"
NODE = "node"
TOOL = DEFAULT_TOOL


def read_glb_json(path: Path) -> dict:
    with path.open("rb") as f:
        magic, version, length = struct.unpack("<III", f.read(12))
        if magic != 0x46546C67:
            raise ValueError(f"not a GLB: {path}")
        chunk_len, chunk_type = struct.unpack("<II", f.read(8))
        data = f.read(chunk_len)
    return json.loads(data.decode("utf-8"))


def glb_stats(path: Path) -> dict:
    doc = read_glb_json(path)
    meshes = doc.get("meshes", [])
    accessors = doc.get("accessors", [])
    nodes = doc.get("nodes", [])

    # A mesh may be referenced by several nodes (wheels are usually four
    # instances of one mesh). Count node instances, not unique mesh entries.
    mesh_stats = []
    for mesh in meshes:
        mesh_prims = 0
        mesh_tris = 0
        for prim in mesh.get("primitives", []):
            mesh_prims += 1
            if "indices" in prim:
                mesh_tris += accessors[prim["indices"]].get("count", 0) // 3
            else:
                pos = prim.get("attributes", {}).get("POSITION")
                if pos is not None:
                    mesh_tris += accessors[pos].get("count", 0) // 3
        mesh_stats.append((mesh_prims, mesh_tris))

    primitives = 0
    triangles = 0
    for node in nodes:
        mesh_index = node.get("mesh")
        if mesh_index is None:
            continue
        mesh_prims, mesh_tris = mesh_stats[mesh_index]
        primitives += mesh_prims
        triangles += mesh_tris

    images = doc.get("images", [])
    materials = doc.get("materials", [])
    return {
        "partCount": primitives,
        "triangles": triangles,
        "images": len(images),
        "materials": len(materials),
        "materialNames": [m.get("name") or "" for m in materials],
    }


PAINT_RE = re.compile(r"(car ?paint|paint)", re.I)
NON_PAINT_RE = re.compile(
    r"(glass|window|windscreen|windshield|light|lamp|chrome|interior|leather|"
    r"carbon|tire|tyre|rim|wheel|brake|disc|disk|badge|grille|grill|stitch|"
    r"carpet|dashboard|seat|underbody|exhaust)",
    re.I,
)


def detect_paint_materials(names: list[str]) -> list[str]:
    """Names of the body-paint materials, used to find panels to repaint.

    Sketchfab authors name paint materials inconsistently ("CarPaint",
    "Paint_Material", "MTL_CarPaint_Base.001"), so entries in models.json may
    override this guess with a hand-checked list.
    """
    return [n for n in names if n and PAINT_RE.search(n) and not NON_PAINT_RE.search(n)]


def run(cmd: list[str]) -> None:
    print("  $", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def gltf(cmd: list[str]) -> list[str]:
    """Run the glTF Transform CLI through node (works on every platform)."""
    return [NODE, str(TOOL), *cmd]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-dir", default=str(ROOT.parent / "car_models_raw"))
    ap.add_argument("--opt-dir", default=str(ROOT.parent / "car_models_opt"))
    ap.add_argument("--tool", default=str(DEFAULT_TOOL))
    ap.add_argument("--skip-lod", action="store_true")
    args = ap.parse_args()

    global TOOL
    raw_dir = Path(args.raw_dir)
    opt_dir = Path(args.opt_dir)
    TOOL = Path(args.tool)
    out_dir = ROOT / "assets" / "models"
    out_dir.mkdir(parents=True, exist_ok=True)

    models = json.loads((ROOT / "scripts" / "models.json").read_text(encoding="utf-8"))
    catalog = []

    for model in models:
        src = raw_dir / model["sourceFile"]
        opt = opt_dir / model["sourceFile"]
        if not src.exists():
            raise SystemExit(f"missing source: {src}")
        if not opt.exists():
            raise SystemExit(f"missing optimized model: {opt} (run gltf-transform optimize first)")

        target = out_dir / f"{model['id']}.glb"
        shutil.copy2(opt, target)

        # Some game-ripped exports split the car into thousands of one-primitive
        # meshes (Lanzador: 2703 parts). Joining by material brings the part
        # count back to something a draw-call budget and a parts list can carry,
        # then the joined file is re-compressed.
        if model.get("join"):
            joined = out_dir / f".{model['id']}.join.glb"
            joined_opt = out_dir / f".{model['id']}.joinopt.glb"
            run(gltf(["join", str(target), str(joined)]))
            run(gltf(["optimize", str(joined), str(joined_opt),
                      "--compress", "draco", "--texture-compress", "false",
                      "--flatten", "false", "--join", "false",
                      "--instance", "false", "--palette", "false"]))
            os.replace(joined_opt, target)
            joined.unlink(missing_ok=True)

        lod_target = out_dir / f"{model['id']}.lod.glb"
        if not args.skip_lod and not lod_target.exists():
            tmp_simplified = out_dir / f".{model['id']}.lod.tmp.glb"
            run(gltf(["simplify", str(target), str(tmp_simplified),
                      "--ratio", "0.04", "--error", "0.06"]))
            run(gltf(["draco", str(tmp_simplified), str(lod_target),
                      "--encode-speed", "10", "--decode-speed", "10"]))
            tmp_simplified.unlink(missing_ok=True)

        stats = glb_stats(target)
        lod_bytes = lod_target.stat().st_size if lod_target.exists() else 0
        paint = model.get("paintMaterials") or detect_paint_materials(stats["materialNames"])
        entry = {
            **{k: model.get(k) for k in (
                "id", "brand", "model", "fullName", "zhName", "year", "tagline",
                "accent", "sourcePage", "author", "license", "licenseUrl",
                "preserveLivery", "materialFirst", "rotate", "flip", "short") if k in model},
            "paintMaterials": paint,
            "modelUrl": f"assets/models/{model['id']}.glb",
            "lodUrl": f"assets/models/{model['id']}.lod.glb",
            "sourceBytes": src.stat().st_size,
            "compressedBytes": target.stat().st_size,
            "lodBytes": lod_bytes,
            "partCount": stats["partCount"],
            "triangles": stats["triangles"],
            "materialCount": stats["materials"],
            "imageCount": stats["images"],
        }
        catalog.append(entry)
        print(f"✓ {entry['id']:22s} {entry['partCount']:3d} parts · "
              f"{entry['triangles']:7d} tris · {entry['compressedBytes']/1048576:5.2f} MB "
              f"(source {entry['sourceBytes']/1048576:4.1f} MB)", flush=True)

    catalog_path = out_dir / "catalog.json"
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    js = "// Auto-generated by scripts/build_models.py — do not edit by hand.\n"
    js += "export const CARS = Object.freeze(" + json.dumps(catalog, ensure_ascii=False, indent=2) + ");\n\n"
    js += "export const DEFAULT_CAR = " + json.dumps(catalog[0]["id"]) + ";\n"
    (ROOT / "js" / "catalog.js").write_text(js, encoding="utf-8")

    credits = ["# 模型来源与许可 / Model Credits\n",
               "本项目使用的真实车型 GLB 模型来自 GitHub 仓库 "
               "[`supercar3d/supercar_3D_asssets`](https://github.com/supercar3d/supercar_3D_asssets)，"
               "原始模型来自 Sketchfab，按对应 Creative Commons 许可使用并做了压缩与纹理优化。\n",
               "文末另列 3 款未声明许可的第三方模型。",
               "",
               "| 车型 | 作者 | 来源 | 许可 |", "| --- | --- | --- | --- |"]
    for e in catalog:
        credits.append(f"| {e['fullName']} | {e['author']} | [Sketchfab]({e['sourcePage']}) | "
                       f"[{e['license']}]({e['licenseUrl']}) |")
    credits.append("\n> 模型为粉丝制作，与各汽车制造商无隶属关系；所有商标归其各自所有者。"
                   "标注 CC BY-SA 4.0 的模型其模型文件（含本仓库中的压缩版本）按相同许可共享。\n")
    unlicensed = [e for e in catalog if str(e.get("license", "")).startswith("未声明")]
    if unlicensed:
        credits.append("\n## 未声明许可的模型\n")
        credits.append("下列模型来自第三方 GitHub 仓库，**仓库未声明许可**。"
                       "仅适合个人本地学习 / 研究使用，不得对外分发或商用：\n")
        credits.append("| 车型 | 仓库 |")
        credits.append("| --- | --- |")
        for e in unlicensed:
            credits.append(f"| {e['fullName']} | [来源]({e['sourcePage']}) |")
        credits.append("")
    # Scene / material / HDRI credits are hand-written and live in their own
    # file, so a rebuild keeps them instead of overwriting the whole document.
    asset_credits = ROOT / "docs" / "credits-assets.md"
    if asset_credits.exists():
        credits.append("")
        credits.append(asset_credits.read_text(encoding="utf-8").rstrip())
    (ROOT / "CREDITS.md").write_text("\n".join(credits), encoding="utf-8")

    print(f"\nCatalog written: {catalog_path}")
    print(f"JS catalog: {ROOT / 'js' / 'catalog.js'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
