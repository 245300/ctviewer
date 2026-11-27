#!/usr/bin/env bash
# CTViewer model pipeline
#   1. Download CC-licensed source GLBs from GitHub (cached in models_src/)
#   2. Assemble the "advanced" pre-split part sets into whole cars
#   3. Optimize geometry (Draco) + textures (WebP 1024)
#   4. Build per-car LOD previews and regenerate both catalogs + CREDITS
set -euo pipefail
cd "$(dirname "$0")/.."

RAW_DIR="${1:-models_src}"
OPT_DIR="build/models_opt"
GLTF_CLI="${GLTF_TRANSFORM:-$PWD/node_modules/@gltf-transform/cli/bin/cli.js}"
if [ ! -f "$GLTF_CLI" ]; then
  echo "gltf-transform not found. Run 'npm install', or set GLTF_TRANSFORM=/path/to/@gltf-transform/cli/bin/cli.js" >&2
  exit 1
fi

echo "▸ 1/4  Downloading source models"
python3 scripts/fetch_models.py --out "$RAW_DIR"

echo "▸ 2/4  Assembling pre-split part sets"
python3 - "$RAW_DIR" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

raw = Path(sys.argv[1])
models = json.loads(Path("scripts/models.json").read_text(encoding="utf-8"))
for model in models:
    if not model.get("parts"):
        continue
    out = raw / model["sourceFile"]
    parts = raw / "_parts" / model["id"]
    if out.exists() and out.stat().st_size > 10000:
        print(f"  = {model['id']} (merged, cached)")
        continue
    print(f"  → {model['id']}")
    subprocess.run(["node", "scripts/merge_parts.mjs", str(out), str(parts)], check=True)
PY

echo "▸ 3/4  Draco + WebP optimization"
mkdir -p "$OPT_DIR"
for src in "$RAW_DIR"/*.glb; do
  base="$(basename "$src")"
  out="$OPT_DIR/$base"
  if [ -f "$out" ]; then
    echo "  = $base (cached)"
    continue
  fi
  echo "  → $base"
  # Textures go first, through sharp with an explicit sRGB conversion: the CLI
  # texture pass dies on unset libvips colourspaces (Windows), the geometry
  # pass then runs without touching them.
  tex="$OPT_DIR/.$base.tex.glb"
  node scripts/compress_textures.mjs "$src" "$tex" --size 1024 --quality 82
  node "$GLTF_CLI" optimize "$tex" "$out" \
    --compress draco --texture-compress false \
    --flatten false --join false --instance false --palette false
  rm -f "$tex"
done

echo "▸ 4/4  Building catalog + LOD previews"
python3 scripts/build_models.py --raw-dir "$RAW_DIR" --opt-dir "$OPT_DIR" --tool "$GLTF_CLI"

echo "✅ Models ready in assets/models/"
