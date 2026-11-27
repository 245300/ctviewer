"""Bake the Mixamo locomotion/action clips onto the Girls' Frontline 2 characters.

Run with Blender (no arguments):

    blender -b -noaudio --factory-startup --python build/build_characters.py

Inputs
  build/anims.json                       (from build/extract_anims.py)
  <Unity project>/8FastCars/少女前线2/...  source FBX + textures

Output
  assets/characters/<id>.glb             one skinned GLB per character, with
                                         all 15 clips as glTF animations
  assets/characters/characters.json      catalog for the web app

The two rigs do not share bone names (Mixamo "LeftUpLeg" vs the game's
"Left leg"), so the animations are retargeted the only way that survives a
different rest pose: every source bone's rotation is turned into a delta from
*its own* rest pose, that delta is applied to the target bone's rest rotation,
and the target bone's local basis is solved from its parent chain.  Hips
translation is carried over in world space, scaled by the ratio of hip heights
and de-trended (Mixamo's walk/run clips contain root motion; the player is
moved by the controller instead).
"""
import bpy
import json
import os
import re
import sys
from mathutils import Matrix, Quaternion, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANIMS = os.path.join(ROOT, 'build', 'anims.json')
SRC = os.path.join(
    r'D:\Project\unity 赛车游戏\My project\天天赛车\Assets',
    '8FastCars', '少女前线2', '少女前线2',
)
OUT_DIR = os.path.join(ROOT, 'assets', 'characters')
MAX_TEX = 1024
FPS = 30
# The character whose rig the shared animation library is baked against.
REF_ID = 'colphne'

# id, folder, fbx, 中文名, 英文名
CHARS = [
    ('colphne', '【少女前线2：追放】寇尔芙', 'GirlsFrontline ColphneDefault.fbx', '寇尔芙', 'Colphne'),
    ('charolic-training', '【少女前线2：追放】克罗丽科（训练服）', 'GirlsFrontline CharolicBattleSuit.fbx', '克罗丽科·训练服', 'Charolic (Training)'),
    ('charolic-skin', '【少女前线2：追放】克罗丽科（跃行脱兔）', 'GirlsFrontline CharolicSkin001.fbx', '克罗丽科·跃行脱兔', 'Charolic (Leaping Hare)'),
    ('tololo', '【少女前线2：追放】托洛洛', 'GirlsFrontline TololoDefault.fbx', '托洛洛', 'Tololo'),
    ('qiongjiu', '【少女前线2：追放】琼玖', 'GirlsFrontline QiongJiuDefault.fbx', '琼玖', 'QiongJiu'),
    ('ksenia', '【少女前线2：追放】科谢尼娅', 'GirlsFrontline KseniaDefault.fbx', '科谢尼娅', 'Ksenia'),
    ('littara', '【少女前线2：追放】莉塔拉', 'GirlsFrontline LittaraDefault.fbx', '莉塔拉', 'Littara'),
    ('mosin', '【少女前线2：追放】莫辛纳甘', 'GirlsFrontline MosinnagantDefault.fbx', '莫辛纳甘', 'Mosin-Nagant'),
    ('groza', '【少女前线2：追放】闪电（商城皮肤）', 'GirlsFrontline GrozaSkin001.fbx', '闪电·商城皮肤', 'Groza (Shop Skin)'),
    ('daiyan', '【少女前线2：追放】黛烟', 'GirlsFrontline DaiYanDefault Ver 2.1.fbx', '黛烟', 'DaiYan'),
]

# Character bone -> Mixamo bone.
BONE_MAP = {
    'Hips': 'mixamorig:Hips',
    'Spine': 'mixamorig:Spine',
    'Chest': 'mixamorig:Spine2',
    'Neck': 'mixamorig:Neck',
    'Head': 'mixamorig:Head',
    'Left shoulder': 'mixamorig:LeftShoulder',
    'Left arm': 'mixamorig:LeftArm',
    'Left elbow': 'mixamorig:LeftForeArm',
    'Left wrist': 'mixamorig:LeftHand',
    'Right shoulder': 'mixamorig:RightShoulder',
    'Right arm': 'mixamorig:RightArm',
    'Right elbow': 'mixamorig:RightForeArm',
    'Right wrist': 'mixamorig:RightHand',
    'Left leg': 'mixamorig:LeftUpLeg',
    'Left knee': 'mixamorig:LeftLeg',
    'Left ankle': 'mixamorig:LeftFoot',
    'Left toe': 'mixamorig:LeftToeBase',
    'Right leg': 'mixamorig:RightUpLeg',
    'Right knee': 'mixamorig:RightLeg',
    'Right ankle': 'mixamorig:RightFoot',
    'Right toe': 'mixamorig:RightToeBase',
}
for side, mix_side in (('L', 'Left'), ('R', 'Right')):
    for finger, mix_finger in (('Index', 'Index'), ('Middle', 'Middle'), ('Ring', 'Ring'),
                               ('Little', 'Pinky')):
        for seg in (1, 2, 3):
            BONE_MAP[f'{finger}Finger{seg}_{side}'] = f'mixamorig:{mix_side}Hand{mix_finger}{seg}'
    for seg in (0, 1, 2):
        BONE_MAP[f'Thumb{seg}_{side}'] = f'mixamorig:{mix_side}HandThumb{seg + 1}'


def load_anims():
    with open(ANIMS, encoding='utf-8') as f:
        return json.load(f)


def quat_str(q):
    return [q.x, q.y, q.z, q.w]


def resize_images():
    for img in bpy.data.images:
        w, h = img.size
        if not w or not h or max(w, h) <= MAX_TEX:
            continue
        scale = MAX_TEX / max(w, h)
        img.scale(max(1, round(w * scale)), max(1, round(h * scale)))
        print(f'  tex {os.path.basename(img.filepath) or img.name}: {w}x{h} -> '
              f'{img.size[0]}x{img.size[1]}')


def repair_materials():
    """Drop textures the FBX points at but that do not exist, and stop the
    importer's alpha=0 from making whole outfits invisible.

    The game's EyeShadow material references a ``Textures`` folder as if it
    were a file; the glTF exporter then writes a texture entry with no image
    source and three's loader throws on it.  Every material also arrives with
    Principled Alpha = 0 (Unity's TransparencyFactor), which would make the
    clothing fully transparent in glTF.
    """
    for mat in bpy.data.materials:
        if not mat.use_nodes or not mat.node_tree:
            continue
        nt = mat.node_tree
        for node in list(nt.nodes):
            if node.type != 'TEX_IMAGE':
                continue
            img = node.image
            if img is None or img.size[0] == 0 or img.size[1] == 0:
                for out in node.outputs:
                    for link in list(out.links):
                        nt.links.remove(link)
                print(f'  drop texture {mat.name}: {img.name if img else "(none)"}')
        for node in nt.nodes:
            if node.type != 'BSDF_PRINCIPLED':
                continue
            alpha = node.inputs.get('Alpha')
            if alpha is not None and not alpha.is_linked:
                alpha.default_value = 1.0


def bake_clip(arm, clip):
    scene = bpy.context.scene
    frames = clip['frames']
    count = len(frames)
    rest_q = {}
    rest_m = {}
    parent = {}
    for b in arm.data.bones:
        rest_q[b.name] = b.matrix_local.to_quaternion()
        rest_m[b.name] = b.matrix_local.copy()
        parent[b.name] = b.parent.name if b.parent else None

    # Target rest hip height, in world space, for scaling Mixamo's translation.
    hips_bone = arm.data.bones.get('Hips')
    if hips_bone is None:
        raise RuntimeError('character rig has no Hips bone')
    hip_world = arm.matrix_world @ hips_bone.head_local
    ratio = hip_world.z / clip['hipsRest'][2]
    set_world = arm.matrix_world.inverted()
    # Clip deltas are stored in world coordinates; bring them into this
    # character's armature space (its object rotation is usually identity but
    # the retarget must not depend on that).
    obj_rot = arm.matrix_world.to_quaternion()
    obj_rot_inv = obj_rot.inverted()

    missing = [c for c in BONE_MAP if c not in arm.data.bones]
    if missing:
        print('  missing target bones:', missing)

    # Detrend the horizontal hips motion (Mixamo walk/run carry root motion).
    hips = clip['hips']
    sx, sy, sz = hips[0]
    ex, ey, ez = hips[-1]
    use = [b for b in BONE_MAP if b in arm.data.bones]
    order = []
    seen = set()

    def visit(name):
        if name in seen:
            return
        p = parent.get(name)
        if p:
            visit(p)
        seen.add(name)
        order.append(name)

    for b in use:
        visit(b)

    # Solve every frame first, then write fcurves in one pass.
    quats = {b: [] for b in use}
    hip_loc = []
    prev_q = {}
    for i in range(count):
        pose_q = {}
        for name in order:
            mix = BONE_MAP.get(name)
            if mix is None:
                pose_q[name] = rest_q[name]
                continue
            q = clip['bones'][mix][i]
            delta = Quaternion((q[3], q[0], q[1], q[2]))
            delta = obj_rot_inv @ delta @ obj_rot
            pose_q[name] = delta @ rest_q[name]
        for name in order:
            p = parent.get(name)
            if p is None:
                basis = rest_q[name].inverted() @ pose_q[name]
            else:
                basis = (pose_q[p] @ rest_q[p].inverted() @ rest_q[name]).inverted() @ pose_q[name]
            basis.normalize()
            prev = prev_q.get(name)
            if prev is not None and prev.dot(basis) < 0:
                basis.negate()
            prev_q[name] = basis
            quats[name].append(quat_str(basis))

        if 'Hips' in use:
            t = i / (count - 1) if count > 1 else 0.0
            dx = hips[i][0] - (sx + (ex - sx) * t)
            dy = hips[i][1] - (sy + (ey - sy) * t)
            dz = hips[i][2] - sz
            desired = Vector((dx, dy, dz)) * ratio
            world_head = hip_world + desired
            head_arm = set_world @ world_head
            pose_m = Matrix.Translation(head_arm) @ pose_q['Hips'].to_matrix().to_4x4()
            basis_m = rest_m['Hips'].inverted() @ pose_m
            hip_loc.append([basis_m.translation.x, basis_m.translation.y, basis_m.translation.z])

    action = bpy.data.actions.new(clip['file'][:-4])
    action.use_fake_user = True
    for name in use:
        for idx in range(4):
            fc = action.fcurves.new(
                data_path=f'pose.bones["{name}"].rotation_quaternion', index=idx,
                action_group=name)
            fc.keyframe_points.add(count)
            for k in range(count):
                kp = fc.keyframe_points[k]
                kp.co = (float(frames[k]), quats[name][k][idx])
                kp.interpolation = 'LINEAR'
            fc.update()
    if hip_loc and 'Hips' in use:
        for idx in range(3):
            fc = action.fcurves.new(
                data_path='pose.bones["Hips"].location', index=idx, action_group='Hips')
            fc.keyframe_points.add(count)
            for k in range(count):
                kp = fc.keyframe_points[k]
                kp.co = (float(frames[k]), hip_loc[k][idx])
                kp.interpolation = 'LINEAR'
            fc.update()
    print(f'  clip {action.name:32s} {count:4d} frames  {len(use)} bones')
    return action


def main():
    clips = load_anims()
    only = set(sys.argv[sys.argv.index('--') + 1].split(',')) if '--' in sys.argv else None
    os.makedirs(OUT_DIR, exist_ok=True)
    catalog = []
    ref_hip = None
    clip_info = []
    for cid, folder, fbx, zh, en in CHARS:
        if only and cid not in only:
            continue
        path = os.path.join(SRC, folder, fbx)
        if not os.path.isfile(path):
            print('MISSING', path)
            continue
        print(f'\n=== {cid}  {zh} ===')
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=path)
        bpy.context.scene.render.fps = FPS
        bpy.context.scene.render.fps_base = 1.0
        arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
        meshes = [o for o in bpy.data.objects if o.type == 'MESH']
        if len(arms) != 1:
            print('  unexpected armatures:', [a.name for a in arms])
        arm = arms[0]
        arm.name = 'Armature'
        arm.data.name = 'Armature'
        for m in meshes:
            if m.name != 'Body' and m.parent is None:
                m.parent = arm
        resize_images()
        repair_materials()
        tris = 0
        for m in meshes:
            m.data.calc_loop_triangles()
            tris += len(m.data.loop_triangles)
        print('  meshes', [m.name for m in meshes], 'tris', tris,
              'bones', len(arm.data.bones))

        hip_height = round((arm.matrix_world @ arm.data.bones['Hips'].head_local).z, 4)
        if not clip_info:
            # The clip list travels with the catalog; the clips themselves are
            # written straight into glTF by build_anim_glb.py (Blender's
            # exporter re-expresses bone rotations in its own node space and
            # mangled every pose, so the animation library is authored against
            # the character GLB's own rest transforms instead).
            for name in sorted(clips):
                c = clips[name]
                clip_info.append({
                    'name': name,
                    'seconds': round((len(c['frames']) - 1) / FPS, 3),
                })

        out = os.path.join(OUT_DIR, f'{cid}.glb')
        bpy.ops.export_scene.gltf(
            filepath=out,
            export_format='GLB',
            export_apply=False,
            export_animations=False,
            export_image_format='WEBP',
            export_image_quality=82,
            export_skins=True,
            export_morph=False,
            export_draco_mesh_compression_enable=True,
            export_draco_mesh_compression_level=6,
        )
        size = os.path.getsize(out)
        print(f'  -> {out}  {size / 1048576:.2f} MB')
        catalog.append({
            'id': cid,
            'zhName': zh,
            'enName': en,
            'url': f'assets/characters/{cid}.glb',
            'bytes': size,
            'triangles': tris,
            'hipHeight': hip_height,
        })

    import pathlib
    ref = next((c for c in catalog if c['id'] == REF_ID), None)
    payload = {
        'animationsUrl': 'assets/characters/animations.glb',
        'refHipHeight': ref['hipHeight'] if ref else 1.0,
        'clips': clip_info,
        'characters': catalog,
    }
    cat_path = pathlib.Path(OUT_DIR) / 'characters.json'
    cat_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('\ncatalog:', cat_path, len(catalog), 'characters')


if __name__ == '__main__':
    main()
