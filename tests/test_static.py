#!/usr/bin/env python3
"""Static acceptance checks for the CTViewer multi-car project.

Runs on the Python standard library alone: the GLB header is read directly,
so `npm test` works on a fresh machine without extra packages.
"""
from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
MODELS = ASSETS / "models"
errors: list[str] = []
checks: list[tuple[str, bool, str]] = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    if not cond:
        errors.append(f"{name}: {detail}")


def read_glb_json(path: Path) -> dict:
    """Return the JSON chunk of a binary glTF (.glb) file."""
    with path.open("rb") as f:
        magic, _version, _length = struct.unpack("<III", f.read(12))
        if magic != 0x46546C67:
            raise ValueError(f"not a GLB: {path}")
        chunk_length, _chunk_type = struct.unpack("<II", f.read(8))
        return json.loads(f.read(chunk_length).decode("utf-8"))


catalog = json.loads((MODELS / "catalog.json").read_text(encoding="utf-8"))
check("车型数量为 34", len(catalog) == 34, f"count={len(catalog)}")
check("车型 ID 唯一", len({c['id'] for c in catalog}) == len(catalog))
check("零件总数 >= 3200", sum(c["partCount"] for c in catalog) >= 3200,
      str(sum(c["partCount"] for c in catalog)))
check("总三角面 > 600 万", sum(c["triangles"] for c in catalog) > 6_000_000,
      str(sum(c["triangles"] for c in catalog)))

for car in catalog:
    cid = car["id"]
    glb = MODELS / f"{cid}.glb"
    lod = MODELS / f"{cid}.lod.glb"
    check(f"{cid} 主模型存在", glb.exists(), str(glb))
    check(f"{cid} LOD 存在", lod.exists(), str(lod))
    if not glb.exists():
        continue
    check(f"{cid} 零件数 >= 12", car["partCount"] >= 12, str(car["partCount"]))
    check(f"{cid} 压缩率 < 80%", car["compressedBytes"] < car["sourceBytes"] * 0.8,
          f"{car['compressedBytes']}/{car['sourceBytes']}")
    check(f"{cid} 许可信息完整", all(car.get(k) for k in ("author", "license", "licenseUrl", "sourcePage")))
    if str(car.get("license", "")).startswith("未声明"):
        check(f"{cid} 未声明许可已标注", "未声明" in car["license"] and car["licenseUrl"].startswith("http"))
    doc = read_glb_json(glb)
    check(f"{cid} 使用 Draco", "KHR_draco_mesh_compression" in (doc.get("extensionsUsed") or []),
          str(doc.get("extensionsUsed")))

viewer_src = (ROOT / "js/viewer.js").read_text(encoding="utf-8")
paint_src = (ROOT / "js/paint.js").read_text(encoding="utf-8")
config_src = (ROOT / "js/config.js").read_text(encoding="utf-8")
main_src = (ROOT / "js/main.js").read_text(encoding="utf-8")
parts_src = (ROOT / "js/parts.js").read_text(encoding="utf-8")
catalog_js = (ROOT / "js/catalog.js").read_text(encoding="utf-8")
css_src = (ROOT / "css/style.css").read_text(encoding="utf-8")

check("使用 MeshPhysicalMaterial", "MeshPhysicalMaterial" in paint_src)
check("车漆过渡 460ms", "paintTransitionMs: 460" in config_src)
for paint in ["原厂色", "金属漆", "珠光漆", "哑光漆", "糖果漆", "变色龙", "液态铬", "缎面黑", "拉丝钛", "熔岩橙", "霓虹紫", "英伦绿"]:
    check(f"包含车漆 {paint}", paint in config_src)
check("自定义车漆底色", "paint-color" in (ROOT / "index.html").read_text(encoding="utf-8") and "setColor" in paint_src)
check("菲涅尔壳层着色器", "Fresnel" in viewer_src and "pow(1.0 - abs(dot" in viewer_src)
check("多车型加载入口", "loadCar(carId" in viewer_src and "CARS" in viewer_src)
check("模型坐标统一化", "_flattenAndNormalize" in viewer_src)
check("零件语义分类", "classifyPart" in parts_src and "PART_CATEGORIES" in parts_src)
check("零件语义查表", "const SEMANTIC" in parts_src and "door_lf" in parts_src and "wheels_lf" in parts_src)
check("爆炸拆解逻辑", "explodeOffsets" in viewer_src and "setExplode" in viewer_src)
check("自动构图", "fitView" in viewer_src and "getWorldBounds" in viewer_src)
check("车型目录 JS 已生成", all(x in catalog_js for x in ("ferrari-f430", "bmw-m4", "lamborghini-revuelto")))
check("车型切换 UI", "car-strip" in (ROOT / "index.html").read_text(encoding="utf-8") and "car-chip" in main_src)
check("车型库与视角预设", "library-body" in (ROOT / "index.html").read_text(encoding="utf-8")
      and "view-presets" in (ROOT / "index.html").read_text(encoding="utf-8")
      and "buildLibrary" in main_src and "setView" in viewer_src)
check("可选 jsDelivr 配置", "jsDelivr" in config_src or "jsdelivr" in config_src.lower())
check("本地 Draco 路径", "vendor/draco/" in config_src)
check("车库场景资源", (ROOT / "assets/scenes/garage.glb").exists()
      and (ROOT / "assets/scenes/garage.glb").stat().st_size < 3_000_000,
      str((ROOT / "assets/scenes/garage.glb").stat().st_size if (ROOT / "assets/scenes/garage.glb").exists() else "missing"))
check("车库/影棚切换", "sceneStyle" in config_src and "btn-scene" in (ROOT / "index.html").read_text(encoding="utf-8")
      and "setSceneStyle" in viewer_src)
check("车库地面标定", "floorY" in viewer_src and "this.garage.position.y -= floorY" in viewer_src,
      "车库以模型自带的灯箱地面为 y=0，轮胎不再嵌入")
check("车库地面材质", "MeshLambertMaterial" in viewer_src and "_makeFloorTexture" in viewer_src
      and "_makeLightPoolTexture" in viewer_src)
check("车库工位标线", "_makeBayMarksTexture" in viewer_src and "BAY 01" in viewer_src)
check("车库陈设", all(k in viewer_src for k in ("_addGarageProps", "rackTyre", "chest", "cone(", "drum("))
      and "GarageSign" in viewer_src)
check("视角按方向构图", "_fitDistanceForBox" in viewer_src and "_fitDistance(" not in viewer_src
      and "PADDING" in viewer_src)
check("视角贴顶处理", "_clampToRoom" in viewer_src and "_updateGarageCeiling" in viewer_src
      and "_garageClipPlane" in viewer_src)
check("预设打断自动旋转", "toggleAutoRotate(false)" in main_src)

for rel in [
    "vendor/three/three.module.js",
    "vendor/three/addons/loaders/GLTFLoader.js",
    "vendor/three/addons/loaders/DRACOLoader.js",
    "vendor/three/addons/controls/OrbitControls.js",
    "vendor/draco/draco_decoder.js",
    "vendor/draco/draco_decoder.wasm",
    "vendor/draco/draco_wasm_wrapper.js",
    "sw.js",
]:
    check(f"本地资源 {rel}", (ROOT / rel).exists())

index_html = (ROOT / "index.html").read_text(encoding="utf-8")
check("HTML 使用本地 importmap", '"./vendor/three/three.module.js"' in index_html)
check("HTML 不依赖外部脚本", not re.search(r'(?:src|href)="https?://', index_html))

check("旧概念车资源已移除", not (ASSETS / "concept_car.draco.glb").exists())

# --- 城市：Unity Classical_city 烘焙成的单个 GLB --------------------------
CITY_GLB = ASSETS / "scenes" / "city" / "city.glb"
check("城市 GLB 存在", CITY_GLB.exists(), str(CITY_GLB))
if CITY_GLB.exists():
    city = read_glb_json(CITY_GLB)
    exts = set(city.get("extensionsUsed", []))
    check("城市 GLB 体积 < 20MB", CITY_GLB.stat().st_size < 20_000_000,
          f"{CITY_GLB.stat().st_size} bytes")
    check("城市已 meshopt 压缩", "EXT_meshopt_compression" in exts, str(sorted(exts)))
    check("城市已量化顶点", "KHR_mesh_quantization" in exts, str(sorted(exts)))
    # The Unity FBX arrives as ~1700 meshes; the bake merges one per texture.
    check("城市按材质合并", len(city.get("meshes", [])) == 10,
          f"meshes={len(city.get('meshes', []))}")
    check("城市材质数", len(city.get("materials", [])) == 10,
          f"materials={len(city.get('materials', []))}")
    check("城市贴图数", len(city.get("textures", [])) == 12,
          f"textures={len(city.get('textures', []))}")
    lit = [m for m in city.get("materials", []) if "emissiveTexture" in m]
    check("城市含夜景窗光贴图", len(lit) >= 3, f"emissive materials={len(lit)}")
    cutout = [m for m in city.get("materials", []) if m.get("alphaMode") == "MASK"]
    check("绿化使用剪切透明", len(cutout) >= 1, f"mask materials={len(cutout)}")

# The runtime must not go back to parsing the FBX, or the 2 s stall returns.
city_js = (ROOT / "js" / "city.js").read_text(encoding="utf-8")
check("城市走 GLTFLoader", "GLTFLoader" in city_js)
check("城市启用 meshopt 解码", "MeshoptDecoder" in city_js and "setMeshoptDecoder" in city_js)
check("城市不再运行时解析 FBX", "FBXLoader" not in city_js and "mergeGeometries" not in city_js)
check("城市以车库为中心", "BLOCK_SPAN" in city_js and "RING_RADIUS" in city_js)
# The ring has to start where the centred block ends, or the two sets of
# buildings interpenetrate; deriving it from the span keeps them in step.
m_radius = re.search(r"const RING_RADIUS = ([^;]+);", city_js)
radius_expr = m_radius.group(1) if m_radius else ""
check("远景环由街区尺寸推导",
      "BLOCK_SPAN" in radius_expr and "RING_SCALE" in radius_expr, radius_expr)
check("远景环至少五份", "RING_COPIES = 5" in city_js)
# Build inputs stay out of the shipped payload: assets/ carries only the GLB.
# models_src/ itself is git-ignored (1.5 GB of source assets), so a fresh clone
# is expected not to have it; this only guards the shipped folder.
check("城市构建源不在 assets 内",
      not (ASSETS / "scenes" / "city" / "city.fbx").exists())

# --- 天空：Unity 项目自带的三张 HDRI --------------------------------------
sky_js = (ROOT / "js" / "sky.js").read_text(encoding="utf-8")
sky_ids = re.findall(r"^\s{4}id: '(\w+)'", sky_js, re.M)
check("三档天光预设", sky_ids == ["day", "dusk", "night"], str(sky_ids))
check("天光带亮度增益", sky_js.count("bgIntensity") >= 4, str(sky_js.count("bgIntensity")))
check("天光带城市压暗", "cityDim" in sky_js)
for name in ("day_sky.hdr", "overcast_sky.hdr", "night_sky.hdr"):
    hdr = ASSETS / "scenes" / name
    check(f"天空资源 {name}", hdr.exists() and hdr.stat().st_size > 1_000_000, name)
check("天空走 RGBELoader", "RGBELoader" in sky_js and "PMREMGenerator" in sky_js)
for sid in ("day", "dusk", "night"):
    check(f"天光按钮 {sid}", f'data-sky="{sid}"' in index_html)
sw_js = (ROOT / "sw.js").read_text(encoding="utf-8")
check("SW 预缓存城市 GLB", "./assets/scenes/city/city.glb" in sw_js)
check("SW 预缓存 meshopt 解码器",
      "./vendor/three/addons/libs/meshopt_decoder.module.js" in sw_js)
check("天光可用 URL 指定", "skyTime" in (ROOT / "js" / "config.js").read_text(encoding="utf-8"))

# --- 朝向：34 台车统一车头朝 +X（前视相机在 +X，零件命名读 +X 为「前」）----
# 用 tools/car_orient.html 逐台出侧视与正面图审出来的：源资产的朝向不一致，
# 这三台车的车头原指 −X，靠 models.json 的 flip 翻过来。
FLIPPED = {"ferrari-812", "lamborghini-huracan", "lamborghini-temerario"}
models_src_json = json.loads((ROOT / "scripts" / "models.json").read_text(encoding="utf-8"))
src_flip = {m["id"] for m in models_src_json if m.get("flip")}
check("翻转车型与朝向审查一致", src_flip == FLIPPED, str(sorted(src_flip)))
cat_flip = {c["id"] for c in catalog if c.get("flip")}
check("catalog.json 携带翻转标记", cat_flip == FLIPPED, str(sorted(cat_flip)))


def read_catalog_js() -> list:
    """js/catalog.js is the generated `Object.freeze(<json>)` literal."""
    text = (ROOT / "js" / "catalog.js").read_text(encoding="utf-8")
    start = text.index("Object.freeze(") + len("Object.freeze(")
    end = text.rindex("]") + 1          # the array's own closing bracket
    return json.loads(text[start:end])


js_flip = {c["id"] for c in read_catalog_js() if c.get("flip")}
check("catalog.js 携带翻转标记", js_flip == FLIPPED, str(sorted(js_flip)))
check("翻转在归一化里生效", "car?.flip" in viewer_src and "makeRotationY(Math.PI)" in viewer_src)
check("朝向审查页存在", (ROOT / "tools" / "car_orient.html").exists()
      and "car?.flip" in (ROOT / "tools" / "car_orient.html").read_text(encoding="utf-8"))

# --- 车库：钢板地面层 / 玻璃幕墙 / 天花板彩灯 --------------------------------
# 材质与 HDRI 都是取来的实拍素材（ambientCG DiamondPlate008D、Poly Haven
# neon_photostudio），不是 canvas 画的；文件缺失就等于这两个功能没有素材。
GARAGE_TEX = ASSETS / "scenes" / "garage"
for name, lo in (("plate_color.jpg", 120_000), ("plate_normal.jpg", 150_000),
                 ("plate_rough.jpg", 100_000), ("plate_metal.jpg", 120_000)):
    f = GARAGE_TEX / name
    check(f"地板贴图 {name}", f.exists() and f.stat().st_size > lo,
          f"{f.stat().st_size if f.exists() else 'missing'} bytes")
NEON = ASSETS / "scenes" / "neon_studio.hdr"
check("彩灯 HDRI 存在", NEON.exists() and NEON.stat().st_size > 1_000_000,
      f"{NEON.stat().st_size if NEON.exists() else 'missing'} bytes")
check("钢板地面比地面高出一层", "GARAGE_FLOOR_TOP" in viewer_src and "_addGarageFloor" in viewer_src)
check("加地板后车与陈设一起抬升", "_applyFloorLift" in viewer_src
      and "this.modelGroup.position.y = deck" in viewer_src
      and "this.garageProps.position.y = deck" in viewer_src)
check("地板走 PBR 四张图", all(k in viewer_src for k in
      ("plate_color.jpg", "plate_normal.jpg", "plate_rough.jpg", "plate_metal.jpg")))
check("玻璃墙加窗框", "_frameGarageGlass" in viewer_src and "GarageGlassFrame" in viewer_src)
check("玻璃仍可透视（半透明）", "opacity: 0.44" in viewer_src and "depthWrite: false" in viewer_src)
check("天花板彩灯组", "_loadPartyRig" in viewer_src and "_updatePartyLights" in viewer_src
      and "SpotLight" in viewer_src)
check("彩灯开关 API", "setPartyLights" in viewer_src and "partyLightsOn" in viewer_src
      and "btn-lights" in (ROOT / "js" / "main.js").read_text(encoding="utf-8"))
check("彩灯按钮在界面上", 'id="btn-lights"' in index_html)
check("彩灯可深链", "partyLights" in config_src and "?lights=1" in (ROOT / "README.md").read_text(encoding="utf-8"))
check("彩灯会压暗中性灯与日照", "_mixGarageLights" in viewer_src and "_mixSkyLights" in viewer_src)
check("SW 预缓存车库新素材", all(p in sw_js for p in (
    "./assets/scenes/garage/plate_color.jpg", "./assets/scenes/garage/plate_normal.jpg",
    "./assets/scenes/garage/plate_rough.jpg", "./assets/scenes/garage/plate_metal.jpg",
    "./assets/scenes/neon_studio.hdr")))

# --- 2.16 车库：左墙镂空 / 真实道具 / 人物物理 ------------------------------
# The left (+X) and front (+Z) sides are deliberately open: the character walks
# in from the plaza and out through either side.  Only the two glazed walls
# (-X and -Z) are solid, plus the furniture and the car itself.
chars_src = (ROOT / "js" / "characters.js").read_text(encoding="utf-8")
check("左侧补墙已撤掉", "_mirrorGarageGlass" not in viewer_src
      and "_garageLeftGlass" not in viewer_src)
check("左墙与正面完全通透", "GARAGE_DOOR_HALF_WIDTH" not in chars_src
      and "nearFrontWall" not in chars_src and "nearSideWall" not in chars_src
      and "x < room.min.x + wall || z < room.min.z + wall" in chars_src)
check("人物可从正面走进车库", "inFootprint && (x < room.min.x + wall" in chars_src)
check("道具碰撞盒参与行走判定", "_garagePropBoxes" in chars_src and "_garagePropBoxes" in viewer_src)
check("整车也是实体", "_modelBox" in chars_src and "const inset = 0.12" in chars_src)
PROPS = ASSETS / "props"
prop_files = sorted(PROPS.glob("*.glb"))
prop_bytes = sum(p.stat().st_size for p in prop_files)
check("车库道具模型 >= 20 件", len(prop_files) >= 20, f"count={len(prop_files)}")
check("道具总体积 < 8MB", prop_bytes < 8_000_000, f"{prop_bytes / 1024:.0f} KB")
check("每件道具 < 1MB", all(p.stat().st_size < 1_000_000 for p in prop_files))
check("道具使用 Draco", all("KHR_draco_mesh_compression" in (read_glb_json(p).get("extensionsUsed") or [])
                             for p in prop_files))
check("道具按包围盒底部中心落地", "_loadGaragePropModels" in viewer_src
      and "-(box.min.x + box.max.x) / 2" in viewer_src and "-box.min.y" in viewer_src)
check("道具随影棚切换隐藏", "garageProps.visible = on" in viewer_src)
check("货架层板摆件", "(shelves_02: 0.11/0.62/1.13/1.63/2.11 m" in viewer_src)
check("物理按固定子步积分", "1 / 120" in chars_src and "remaining -= step" in chars_src)
check("帧钳放宽到 1/12 秒", "1 / 12" in viewer_src)
check("奔跑 2 倍 / 跳跃 1.5 倍", "RUN_SPEED = 8.8" in chars_src
      and "JUMP_SPEED = 4.5 * Math.sqrt(1.5)" in chars_src)
credits_md = (ROOT / "CREDITS.md").read_text(encoding="utf-8")
check("道具 CC0 来源已标注", "Poly Haven" in credits_md and "CC0" in credits_md
      and all(name in credits_md for name in ("metal_tool_chest", "old_tyre", "tool_cart")))
check("道具构建脚本可复现", (ROOT / "build" / "build_props.sh").exists()
      and (ROOT / "build" / "prop_urls.py").exists())

# --- 2.17 性能与加载 ---------------------------------------------------------
# The frame was 2.7M triangles / 534 calls at 17-22 fps. The five filler ring
# blocks (5 x 336k) are now hidden near the centre, the city ships simplified
# and at 512 px textures, props are 40 % and batched, a stray transmissive pane
# no longer forces a second full-scene pass, and dynamic resolution holds 45+.
city_src = (ROOT / "js" / "city.js").read_text(encoding="utf-8")


def glb_triangles(path: Path) -> int:
    doc = read_glb_json(path)
    accessors = doc.get("accessors", [])
    total = 0
    for mesh in doc.get("meshes", []):
        for prim in mesh.get("primitives", []):
            idx = prim.get("indices")
            if idx is not None:
                total += accessors[idx].get("count", 0) // 3
            else:
                pos = prim.get("attributes", {}).get("POSITION")
                if pos is not None:
                    total += accessors[pos].get("count", 0) // 3
    return total


city_glb = ASSETS / "scenes" / "city" / "city.glb"
city_bytes = city_glb.stat().st_size if city_glb.exists() else 0
check("城市 GLB 已减重（< 6MB）", 0 < city_bytes < 6_000_000, f"{city_bytes / 1048576:.1f} MB")
check("城市三角面 < 25 万", 0 < glb_triangles(city_glb) < 250_000, str(glb_triangles(city_glb)))
check("远景环可整体隐藏", "setRingsVisible" in city_src and "this.rings" in city_src)
check("室内自动隐藏远景环", "_updateCityRings" in viewer_src and "city.setRingsVisible" in viewer_src)
check("关闭车模透射通道", "m.transmission = 0" in viewer_src)
check("关闭道具透射通道", "material.transmission = 0" in viewer_src)
check("道具按材质合批", "_mergeGarageProps" in viewer_src and "GaragePropBatch" in viewer_src)
check("窗框合批", "GarageGlassFrameBatch" in viewer_src)
check("动态分辨率控制器", "_updateRenderScale" in viewer_src and "_applyRenderScale" in viewer_src
      and "renderScale" in viewer_src and "0.55" in viewer_src)
check("画质档位参数", "quality:" in config_src and "?q=low|medium|high" in config_src)
check("固定 DPR 逃生口", "dpr: Math.max" in config_src and "CONFIG.dpr" in viewer_src)
check("城市贴图降采样脚本", (ROOT / "scripts" / "city_resize.mjs").exists()
      and "sharp" in (ROOT / "scripts" / "city_resize.mjs").read_text(encoding="utf-8"))
check("道具已减面（单件 < 400KB）", all(p.stat().st_size < 400_000 for p in prop_files))

# --- 人物与城市探索 ---------------------------------------------------------
CHAR_DIR = ASSETS / "characters"
char_catalog_path = CHAR_DIR / "characters.json"
char_catalog = json.loads(char_catalog_path.read_text(encoding="utf-8")) if char_catalog_path.exists() else {}
characters = char_catalog.get("characters", [])
check("人物目录有 10 位角色", len(characters) == 10, f"count={len(characters)}")
check("人物目录带动画库入口", char_catalog.get("animationsUrl") == "assets/characters/animations.glb"
      and float(char_catalog.get("refHipHeight") or 0) > 0.5)
check("人物目录带 15 段动作", len(char_catalog.get("clips", [])) == 15,
      str([c.get("name") for c in char_catalog.get("clips", [])]))
present = [c for c in characters if (ROOT / c["url"]).exists() and (ROOT / c["url"]).stat().st_size > 200_000]
check("10 个人物 GLB 齐全", len(present) == 10, f"{len(present)}/10")
check("人物都带骨骼与贴图", all(c.get("triangles", 0) > 10_000 and c.get("bytes", 0) > 200_000
                                for c in characters))
ANIM_GLB = CHAR_DIR / "animations.glb"
anim_doc = read_glb_json(ANIM_GLB) if ANIM_GLB.exists() else {}
anim_names = [a.get("name") for a in anim_doc.get("animations", [])]
check("共享动画库有 15 段动作", len(anim_names) == 15, str(anim_names))
check("动画库不重复打包网格", len(anim_doc.get("meshes", [])) == 0
      and len(anim_doc.get("skins", [])) == 0)
check("动画库体积 < 3MB", ANIM_GLB.exists() and ANIM_GLB.stat().st_size < 3_000_000,
      f"{ANIM_GLB.stat().st_size if ANIM_GLB.exists() else 'missing'} bytes")
ONE_CHAR = read_glb_json(ROOT / characters[0]["url"]) if characters else {}
check("人物 GLB 是蒙皮模型且不内嵌动画", len(ONE_CHAR.get("skins", [])) == 1
      and not ONE_CHAR.get("animations"))
char_src = (ROOT / "js" / "characters.js").read_text(encoding="utf-8")
check("探索控制器存在", all(k in char_src for k in
      ("class CharacterMode", "SPAWN", "WALK_SPEED", "RUN_SPEED", "playAction", "respawn")))
check("自然待机与走跑切换", "'Idle'" in char_src and "Walking" in char_src
      and "Running" in char_src and "finished" in char_src)
check("15 段动作都有中文名", len(re.findall(r"^\s{2}(?:'[^']+'|[A-Za-z]+): '", char_src, re.M)) >= 15,
      "CLIP_LABELS")
check("出生点有可见标记", "出生点 · SPAWN" in char_src and "RingGeometry" in char_src
      and "marker.visible = true" in char_src)
check("城市碰撞网格", "_buildNav" in city_js and "isBlocked" in city_js)
check("viewer 接入探索模式", "CharacterMode" in viewer_src and "enterExplore" in viewer_src
      and "exitExplore" in viewer_src and "this.exploreActive" in viewer_src)
check("探索入口在界面上", 'id="btn-explore"' in index_html and 'id="character-modal"' in index_html
      and 'id="explore-hud"' in index_html and 'id="explore-action-list"' in index_html)
check("探索可深链", "?explore=" in (ROOT / "README.md").read_text(encoding="utf-8")
      and "bootParams.get('explore')" in main_src)
check("SW 预缓存人物资源", all(p in sw_js for p in (
    "./js/characters.js", "./js/character-clips.js",
    "./assets/characters/characters.json", "./assets/characters/ground.json",
    "./assets/characters/animations.glb", "./assets/characters/colphne.glb")))
# The ceiling clip plane used to be inverted: pulling the orbit above the roof
# line discarded the whole room instead of its top, so the glass wall and its
# mullions vanished exactly when the camera zoomed out.
check("屋顶裁剪平面方向正确", "new THREE.Vector3(0, 1, 0), this._garageCeilY" in viewer_src
      and "new THREE.Vector3(0, -1, 0), -this._garageCeilY" not in viewer_src)
# ...and the roof itself must only be hidden when the eye is actually over the
# room.  Hiding it on height alone made the roof vanish as soon as the orbit
# zoomed out, which reads as "the garage has no ceiling".
check("屋顶只在相机位于车库正上方时隐藏",
      "const overRoom = !!room" in viewer_src and "&& overRoom" in viewer_src)

# Character clips: swing-only retargeting, hip rebase and the floor bake.
clips_src = (ROOT / "js" / "character-clips.js").read_text(encoding="utf-8")
swing_src = (ROOT / "build" / "build_anim_swing.py").read_text(encoding="utf-8")
check("人物动作按摆动量重定向（保留目标自身卷曲）",
      "swing_between" in swing_src and "target_rest_world" in swing_src)
check("摆动起点用目标静止方向", "tgt_rest_dir" in swing_src and "swing_between(tgt_rest_dir" in swing_src)
check("髋部按各人物身高重定向", "adaptHipsClip" in clips_src and "adaptHipsClip" in char_src)
check("地面贴合表覆盖十个人物与十五段动作",
      (ROOT / "assets" / "characters" / "ground.json").exists())
if (ROOT / "assets" / "characters" / "ground.json").exists():
    ground = json.loads((ROOT / "assets" / "characters" / "ground.json")
                        .read_text(encoding="utf-8"))
    check("贴合表含 10 人物 × 15 动作",
          len(ground.get("characters", {})) == 10
          and all(len(v) == 15 for v in ground["characters"].values()))
    check("贴合表数值有限且非负",
          all(0 <= y <= 0.6 for ch in ground["characters"].values()
              for clip in ch.values() for y in clip.get("y", [])))
check("运行时应用贴合表", "applyGroundLift" in char_src)
check("贴合烘焙页存在", (ROOT / "tools" / "ground_bake.html").exists())

# --- 2.19 玩法：试驾 / 两柱举升机 / 拍照 / 底栏横条 --------------------------
drive_src = (ROOT / "js" / "drive.js").read_text(encoding="utf-8")
photo_src = (ROOT / "js" / "photo.js").read_text(encoding="utf-8")
check("试驾模块与入口", "class DrivingMode" in drive_src
      and "enterDrive" in viewer_src and "exitDrive" in viewer_src
      and "new DrivingMode" in viewer_src)
check("街机物理固定子步", "STEP = 1 / 120" in drive_src
      and "this._step(step, input)" in drive_src)
check("车辆按四角采样碰撞", "HALF_LENGTH" in drive_src and "HALF_WIDTH" in drive_src
      and "_collides" in drive_src and "city?.isBlocked" in drive_src)
check("试驾停在原位，玩家给油才移动", "launch" not in drive_src
      and "The car stays exactly where" in drive_src
      and "group2.position.set(this.pos.x" in drive_src)
check("追尾相机 + 速度表", "_syncCamera" in drive_src
      and 'id="drive-hud"' in index_html and 'id="drive-speed"' in index_html)
check("程序化引擎声", "class EngineAudio" in drive_src and "createOscillator" in drive_src)
check("不再提供车身开合", not (ROOT / "js" / "doors.js").exists()
      and 'id="panels-bar"' not in index_html
      and "DoorController" not in viewer_src and "setPanels" not in main_src
      and "doorGroup" not in viewer_src)
check("换车时等待 compileAsync 结束再释放材质", "_deferredDispose" in viewer_src
      and "compilePending" in viewer_src)
check("两柱举升机", "GarageTwoPostLift" in viewer_src and "_liftCarriages" in viewer_src
      and "setLiftRaised" in viewer_src and "toggleLift" in main_src)
check("底盘视角预设", "preset === 'under'" in viewer_src and 'data-view="under"' in index_html)
check("举升机未升起时隐藏且不挡路", "_syncLiftBoxes" in viewer_src
      and "this.garageLift.visible = show" in viewer_src)
check("拍照模式模块", "class PhotoMode" in photo_src and "PHOTO_FILTERS" in photo_src
      and "enterPhoto" in viewer_src)
check("照片滤镜与 PNG 导出", "toBlob" in photo_src and "ctx.filter" in photo_src)
check("10 秒 WebM 录像", "MediaRecorder" in photo_src and "captureStream" in photo_src
      and "10 - (performance.now()" in photo_src)
check("构图线覆盖层", 'id="photo-guides"' in index_html and "toggleGuide" in photo_src)
check("人物只保留上车互动", "canEnterCar" in chars_src and "onEnterCar" in chars_src
      and "POSE_LIBRARY" not in chars_src and "setPose" not in chars_src)
check("上车提示与就近判定", "canEnterCar" in chars_src and 'id="car-hint"' in index_html
      and "onNearCarChange" in chars_src)
check("玩法界面齐全", all(f'id="{i}"' in index_html for i in
      ("drive-hud", "photo-hud", "btn-drive", "btn-photo", "btn-lift", "car-hint")))
check("回形布局 + 单行底栏", "flex-wrap: nowrap" in css_src
      and 'class="action-dock"' in index_html
      and 'class="dock-group dock-group-tools"' in index_html
      and 'class="action-btn"' in index_html)
check("SW 预缓存玩法模块", all(p in sw_js for p in
      ("./js/drive.js", "./js/photo.js")))
check("玩法可深链", "bootParams.get('drive')" in main_src
      and "bootParams.get('photo')" in main_src
      and "bootParams.get('panels')" not in main_src)
# --- 2.19.1 修复：转向方向 / 影棚起步 / 后台标签降档 -------------------------
# +X 是车头，yaw 增大把车头转向 −Z（追尾视角的屏幕左），所以把 D 键的
# steer > 0 直接接成正 yawRate 会让车朝按键反方向拐。这一条钉住物理公式形状。
check("驾驶 D 键向右打方向（yawRate 取负）",
      "-(vf / WHEELBASE) * Math.tan(this.steer)" in drive_src)
# 以 ?scene=studio 启动时影棚是密闭场景，城市与天光从未请求；切回车库必须补上，
# 否则整间车库开在一个没有天空、没有城市的黑背景里。
check("影棚起步切回车库补载城市与天空",
      "_outdoorsStarted" in viewer_src
      and "this._loadOutdoors().catch(() => {})" in viewer_src)
# 后台标签没有动画帧，fps 采样会读成 1；据此降档会让用户切一次标签就永久变低清。
check("后台标签不触发降档", "document.visibilityState === 'visible'" in viewer_src
      and "_resumeGraceUntil" in viewer_src and "inGrace" in viewer_src
      and "_frameGapMax" in viewer_src and "throttled" in viewer_src)
check("自动降档在高帧率稳定后可恢复一次",
      "_qualityAutoFrom" in viewer_src and "_qualityRestored" in viewer_src
      and "_qualityDowngradedAt" in viewer_src and "_lowFpsTicks >= 4" in viewer_src)

config_ver = re.search(r"version: '([0-9.]+)'", config_src)
sw_ver = re.search(r"const VERSION = 'ctviewer-v([0-9.]+)'", sw_js)
html_ver = re.search(r"const BUILD = '([0-9.]+)'", index_html)
pkg_ver = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
check("版本 2.19.1 四处一致",
      config_ver and config_ver.group(1) == "2.19.1"
      and sw_ver and sw_ver.group(1) == "2.19.1"
      and html_ver and html_ver.group(1) == "2.19.1"
      and pkg_ver == "2.19.1",
      f"{config_ver and config_ver.group(1)} / {sw_ver and sw_ver.group(1)} / {html_ver and html_ver.group(1)} / {pkg_ver}")

# Android APK / 安装包（2.17 起只做本地开发，不再随仓库提供 APK）
# The 23 MB WebView APK and the 15 MB d8.jar were removed: the project is a
# personal local-only web app now.  Keep the guard so a stale APK cannot creep
# back into the payload.
stray_apks = list((ROOT / "android").rglob("*.apk")) if (ROOT / "android").exists() else []
check("不再随仓库提供 APK", not stray_apks, str([p.name for p in stray_apks]))
check("Android 工程保留可复现说明", (ROOT / "android" / "README.md").exists()
      and "本地开发" in (ROOT / "android" / "README.md").read_text(encoding="utf-8"))

print("CTViewer static acceptance")
print("=" * 68)
for name, ok, detail in checks:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not ok else ""))
print("=" * 68)
print(f"{sum(1 for _, ok, _ in checks if ok)}/{len(checks)} checks passed")

if errors:
    print("\nFAILED:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print("ALL CHECKS PASSED")
