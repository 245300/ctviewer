#!/usr/bin/env bash
# Build assets/props/*.glb from Poly Haven CC0 models.
#
# Downloads the 1k glTF package for each asset named below, downscales its
# textures to 512 px, then packs a Draco-compressed GLB. All paths are fixed
# here; build/prop_urls.py only prints the file list for an allow-listed host.
set -euo pipefail
cd "$(dirname "$0")/.."

ASSETS=(
  metal_tool_chest
  steel_frame_shelves_01
  steel_frame_shelves_02
  tool_cart
  old_drill_press
  old_tyre
  rusted_wheel_rim_01
  barrel_03
  oil_tin
  hand_truck
  ladder_sectioned_01
  plastic_crate_01
  cardboard_box_01
  portable_generator
  bench_vice_01
  small_oil_can_01
  spray_paint_bottles
  metal_trash_can
  korean_fire_extinguisher_01
  WetFloorSign_01
  worn_metal_rack
)

mkdir -p build/_dl/polyhaven assets/props

for asset in "${ASSETS[@]}"; do
  echo "== $asset"
  python -I build/prop_urls.py "$asset" > build/_dl/urls.txt
  while IFS=$'\t' read -r url rel; do
    url=${url%$'\r'}
    rel=${rel%$'\r'}
    case "$url" in
      https://dl.polyhaven.org/file/ph-assets/*) ;;
      *) echo "refusing url: $url" >&2; exit 1 ;;
    esac
    case "$rel" in
      *..*|/*) echo "refusing path: $rel" >&2; exit 1 ;;
    esac
    mkdir -p "build/_dl/polyhaven/$(dirname "$rel")"
    if [ ! -s "build/_dl/polyhaven/$rel" ]; then
      curl -sS --fail --retry 2 --max-time 240 -o "build/_dl/polyhaven/$rel" "$url"
    fi
  done < build/_dl/urls.txt

  node -e '
    const sharp = require("sharp");
    const fs = require("fs");
    const path = require("path");
    const name = process.argv[1];
    const dir = path.join("build/_dl/polyhaven", name, "textures");
    (async () => {
      if (!fs.existsSync(dir)) return;
      const names = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f));
      const out = [];
      for (const f of names) {
        const src = path.join(dir, f);
        out.push([src, await sharp(src).resize({ width: 512, height: 512, fit: "inside" })
          .jpeg({ quality: 82 }).toBuffer()]);
      }
      for (const [src, buf] of out) {
        const tmp = src + ".tmp";
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, src);
      }
    })().catch((err) => { console.error(err.message); process.exit(1); });
  ' "$asset"

  npx --no-install gltf-transform copy \
    "build/_dl/polyhaven/$asset/$asset.gltf" "build/_dl/$asset.glb" >/dev/null
  npx --no-install gltf-transform draco \
    "build/_dl/$asset.glb" "assets/props/$asset.glb" >/dev/null
  echo "   $(du -k "assets/props/$asset.glb" | cut -f1) KB"
done
