"""Extract Mixamo animation deltas relative to the animation rig's rest pose.

Run with:  blender -b --factory-startup --python build/extract_anims.py -- <anim_dir>

The JSON is printed to stdout between CLIPJSON_BEGIN / CLIPJSON_END markers (the
build folder is the only consumer, and the Blender process never writes files).
For every clip we store, per mapped bone, the armature-space rotation delta
(pose @ rest^-1) at every source frame, plus the hips head position in world
space.  The deltas are rig-independent, so they can be baked onto any humanoid
skeleton that has the same limb layout (see build/build_characters.py).
"""
import bpy
import json
import os
import sys

ANIM_DIR = sys.argv[sys.argv.index('--') + 1]


def clip_path(name):
    """Resolve one clip inside ANIM_DIR, refusing anything that escapes it."""
    if os.path.basename(name) != name or name in ('', '.', '..'):
        raise ValueError(f'unsafe clip name: {name!r}')
    root = os.path.realpath(ANIM_DIR) + os.sep
    path = os.path.realpath(os.path.join(ANIM_DIR, name))
    if not path.startswith(root):
        raise ValueError(f'clip outside the animation folder: {path}')
    return path


# Mixamo bone names are the keys; the character-side mapping lives in
# build_characters.py.
WANTED = [
    'mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2',
    'mixamorig:Neck', 'mixamorig:Head',
    'mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand',
    'mixamorig:RightShoulder', 'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:RightHand',
    'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:LeftToeBase',
    'mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:RightFoot', 'mixamorig:RightToeBase',
    'mixamorig:LeftHandThumb1', 'mixamorig:LeftHandThumb2', 'mixamorig:LeftHandThumb3',
    'mixamorig:LeftHandIndex1', 'mixamorig:LeftHandIndex2', 'mixamorig:LeftHandIndex3',
    'mixamorig:LeftHandMiddle1', 'mixamorig:LeftHandMiddle2', 'mixamorig:LeftHandMiddle3',
    'mixamorig:LeftHandRing1', 'mixamorig:LeftHandRing2', 'mixamorig:LeftHandRing3',
    'mixamorig:LeftHandPinky1', 'mixamorig:LeftHandPinky2', 'mixamorig:LeftHandPinky3',
    'mixamorig:RightHandThumb1', 'mixamorig:RightHandThumb2', 'mixamorig:RightHandThumb3',
    'mixamorig:RightHandIndex1', 'mixamorig:RightHandIndex2', 'mixamorig:RightHandIndex3',
    'mixamorig:RightHandMiddle1', 'mixamorig:RightHandMiddle2', 'mixamorig:RightHandMiddle3',
    'mixamorig:RightHandRing1', 'mixamorig:RightHandRing2', 'mixamorig:RightHandRing3',
    'mixamorig:RightHandPinky1', 'mixamorig:RightHandPinky2', 'mixamorig:RightHandPinky3',
]

clips = {}
for name in sorted(os.listdir(ANIM_DIR)):
    if not name.lower().endswith('.fbx'):
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=clip_path(name))
    arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    action = arm.animation_data.action if arm and arm.animation_data else None
    if not arm or not action:
        print('skip (no action):', name)
        continue
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    rest_rot = {}
    for b in arm.data.bones:
        rest_rot[b.name] = b.matrix_local.to_quaternion()
    # The FBX importer leaves a +90 deg X on the armature object, so armature
    # space is Y-up while a character imported the same way is Z-up.  Deltas
    # are exported in *world* coordinates so the retargeter never has to know
    # which rig it is looking at.
    obj_rot = arm.matrix_world.to_quaternion()
    inv_obj_rot = obj_rot.inverted()
    # Rest world orientation of every wanted bone.  Absolute-pose retargeting
    # needs these: a delta alone cannot tell a T-pose from an A-pose, which is
    # exactly why the first pass folded the arms behind the back.
    rest_world = {}
    for b in arm.data.bones:
        rest_world[b.name] = obj_rot @ b.matrix_local.to_quaternion()
    f0, f1 = [int(round(v)) for v in action.frame_range]
    frames = list(range(f0, f1 + 1))
    data = {b: [] for b in WANTED}
    hips = []
    for f in frames:
        scene.frame_set(f)
        for bone_name in WANTED:
            pb = arm.pose.bones.get(bone_name)
            if pb is None:
                data[bone_name].append(None)
                continue
            q = pb.matrix.to_quaternion() @ rest_rot[bone_name].inverted()
            q = obj_rot @ q @ inv_obj_rot
            data[bone_name].append([round(q.x, 6), round(q.y, 6), round(q.z, 6), round(q.w, 6)])
        hp = arm.pose.bones['mixamorig:Hips']
        w = (arm.matrix_world @ hp.matrix).translation
        hips.append([round(w.x, 5), round(w.y, 5), round(w.z, 5)])
    rest_hips = (arm.matrix_world @ arm.data.bones['mixamorig:Hips'].head_local)
    clip = {
        'file': name,
        'fps': round(fps, 3),
        'frames': frames,
        'bones': data,
        'hips': hips,
        'hipsRest': [round(rest_hips.x, 5), round(rest_hips.y, 5), round(rest_hips.z, 5)],
        'restWorld': {b: [round(q.x, 6), round(q.y, 6), round(q.z, 6), round(q.w, 6)]
                      for b, q in rest_world.items() if b in WANTED},
        'armScale': list(arm.scale),
    }
    clips[os.path.splitext(name)[0]] = clip
    drift = ((hips[-1][0] - hips[0][0]) ** 2 + (hips[-1][1] - hips[0][1]) ** 2) ** 0.5
    print(f'{name:36s} {len(frames):4d} frames  fps {fps:5.1f}  drift {drift:.3f}')

print('CLIPJSON_BEGIN')
print(json.dumps(clips, ensure_ascii=False))
print('CLIPJSON_END')
