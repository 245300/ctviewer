"""Retarget the Mixamo clips onto the game rig by transferring swing only.

Copying a source bone's *absolute* world orientation gets the limb pointing the
right way but also copies the source's bone *roll*.  Two rigs never share roll:
the Mixamo bind pose and the Girls' Frontline bind pose differ per bone (0.7 deg
on the hips, 180 deg on the upper legs, 120 deg on the arms), and a skinned mesh
reads roll as a twist around the limb - which is why hands, elbows and the waist
came out corkscrewed even though every bone pointed correctly.

Transferring the *delta* instead has the opposite failure: the delta is measured
from Mixamo's T-pose, but this rig binds in an A-pose, so "bring the arms down"
gets applied to arms that are already down.

This baker takes the middle path, which is what a rig-aware retarget does:

    swing = shortest arc from the source bone's rest direction to its posed
            direction (both expressed in glTF axes)
    R_target_world = swing * R_rest_target_world      # target keeps its own roll
    L_anim = R_parent_world^-1 * R_target_world

So the limb goes exactly where the clip puts it, the target's bind roll is
untouched, and the A-pose never double-counts.

    python build/build_anim_swing.py
"""
import json
import math
import struct
from pathlib import Path

CHARS = r'D:\ctviewer\assets\characters\characters.json'
CHAR_GLB = r'D:\ctviewer\assets\characters\colphne.glb'
ANIMS = r'D:\ctviewer\build\anims_v2.json'
OUT = r'D:\ctviewer\assets\characters\animations.glb'
FPS = 30

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


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def qinv(q):
    x, y, z, w = q
    n = x * x + y * y + z * z + w * w
    return (-x / n, -y / n, -z / n, w / n)


def qnorm(q):
    n = math.sqrt(sum(v * v for v in q)) or 1.0
    return tuple(v / n for v in q)


def qrot(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    tx = 2 * (y * vz - z * vy)
    ty = 2 * (z * vx - x * vz)
    tz = 2 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx))


def qaxis(axis, angle):
    s = math.sin(angle / 2)
    return (axis[0] * s, axis[1] * s, axis[2] * s, math.cos(angle / 2))


def swing_between(a, b):
    """Shortest-arc rotation taking unit vector a onto unit vector b."""
    ax, ay, az = a
    bx, by, bz = b
    d = ax * bx + ay * by + az * bz
    if d > 0.999999:
        return (0.0, 0.0, 0.0, 1.0)
    if d < -0.999999:
        # 180 deg: any perpendicular axis works; pick one deterministically.
        axis = (0.0, 1.0, 0.0) if abs(ax) > 0.9 else (1.0, 0.0, 0.0)
        cx = ay * axis[2] - az * axis[1]
        cy = az * axis[0] - ax * axis[2]
        cz = ax * axis[1] - ay * axis[0]
        n = math.sqrt(cx * cx + cy * cy + cz * cz) or 1.0
        return (cx / n, cy / n, cz / n, 0.0)
    cx = ay * bz - az * by
    cy = az * bx - ax * bz
    cz = ax * by - ay * bx
    return qnorm((cx, cy, cz, 1.0 + d))


def read_glb(path):
    data = Path(path).read_bytes()
    total = struct.unpack_from('<I', data, 8)[0]
    off = 12
    chunks = []
    while off < total:
        clen, ctype = struct.unpack_from('<II', data, off)
        off += 8
        chunks.append((ctype, data[off:off + clen]))
        off += clen
    return json.loads(chunks[0][1]), chunks[1][1]


def main():
    gltf, _bin = read_glb(CHAR_GLB)
    nodes = gltf['nodes']
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i

    order = []
    seen = set()

    def visit(i):
        if i in seen:
            return
        seen.add(i)
        order.append(i)
        for c in nodes[i].get('children', []):
            visit(c)

    for i in range(len(nodes)):
        if i not in parent:
            visit(i)
    for i in range(len(nodes)):
        visit(i)

    def by_name(name):
        for i, n in enumerate(nodes):
            if n.get('name') == name:
                return i
        return None

    local_rest = {i: tuple(n.get('rotation', [0, 0, 0, 1])) for i, n in enumerate(nodes)}
    node_of = {}
    for b in BONE_MAP:
        idx = by_name(b)
        if idx is None:
            print('missing node for bone', b)
        else:
            node_of[b] = idx
    bone_of_node = {v: k for k, v in node_of.items()}

    # Target bind-pose world rotations.
    target_rest_world = {}
    for idx in order:
        p = parent.get(idx)
        pw = target_rest_world[p] if p is not None else (0.0, 0.0, 0.0, 1.0)
        target_rest_world[idx] = qmul(pw, local_rest[idx])

    hips_gltf = node_of.get('Hips')
    hip_height = nodes[hips_gltf]['translation'][1]

    clips = json.loads(Path(ANIMS).read_text(encoding='utf-8'))
    # Blender world (Z-up) -> glTF world (Y-up).
    c = (-math.sin(math.pi / 4), 0.0, 0.0, math.cos(math.pi / 4))

    out_nodes = []
    for n in nodes:
        out = {k: n[k] for k in ('name', 'children', 'translation', 'rotation', 'scale', 'matrix')
               if k in n}
        out_nodes.append(out)

    buf = bytearray()
    accessors = []
    buffer_views = []
    animations = []
    clip_info = []

    def add_accessor(values, comp, target):
        while len(buf) % 4:
            buf.append(0)
        offset = len(buf)
        for v in values:
            buf.extend(struct.pack('<%df' % comp, *v))
        buffer_views.append({'buffer': 0, 'byteOffset': offset,
                             'byteLength': len(buf) - offset})
        acc = {'bufferView': len(buffer_views) - 1, 'componentType': 5126,
               'count': len(values), 'type': target}
        if target == 'SCALAR':
            acc['min'] = [min(v[0] for v in values)]
            acc['max'] = [max(v[0] for v in values)]
        accessors.append(acc)
        return len(accessors) - 1

    for name in sorted(clips):
        clip = clips[name]
        frames = clip['frames']
        n_frames = len(frames)
        times = [((f - frames[0]) / FPS,) for f in frames]
        sx, sy, sz = clip['hips'][0]
        ex, ey, ez = clip['hips'][-1]
        src_rest = {b: tuple(q) for b, q in clip['restWorld'].items()}

        # Rest direction of every mapped *target* bone, in glTF axes.  The
        # swing has to start from here, not from the source rest direction:
        # this rig binds in an A-pose (arms already 45 deg down), so rotating
        # the source T-pose arc onto it would aim the limb past the body.
        tgt_rest_dir = {}
        for bone, idx in node_of.items():
            tgt_rest_dir[bone] = qrot(target_rest_world[idx], (0.0, 1.0, 0.0))

        channels = []
        samplers = []
        time_acc = None
        local_tracks = {}

        for fi in range(n_frames):
            world = {}
            for idx in order:
                p = parent.get(idx)
                pw = world[p] if p is not None else (0.0, 0.0, 0.0, 1.0)
                bone = bone_of_node.get(idx)
                if bone is None:
                    local = local_rest[idx]
                else:
                    mix = BONE_MAP[bone]
                    d = clip['bones'][mix][fi]
                    if d is None or bone not in tgt_rest_dir:
                        local = local_rest[idx]
                    else:
                        posed = qmul(c, qmul(tuple(d), src_rest[mix]))
                        posed_dir = qrot(posed, (0.0, 1.0, 0.0))
                        # Swing the target's own rest direction onto the
                        # direction the clip asks for.  Only the direction is
                        # borrowed; the target keeps its bind roll, so no limb
                        # gets corkscrewed.
                        sw = swing_between(tgt_rest_dir[bone], posed_dir)
                        if bone in ('Left arm', 'Left elbow', 'Left wrist',
                                    'Right arm', 'Right elbow', 'Right wrist'):
                            # Arms hanging straight down sit inside this rig's
                            # wide thighs; swing them out a little while they
                            # are near vertical, fading out as they lift.
                            down = -posed_dir[1]
                            t = max(0.0, min(1.0, (down - 0.90) / 0.085))
                            t = t * t * (3 - 2 * t)
                            sign = 1.0 if bone.startswith('Left') else -1.0
                            sw = qmul(qaxis((0.0, 0.0, 1.0), sign * math.radians(8.0) * t), sw)
                        target_world = qmul(sw, target_rest_world[idx])
                        local = qmul(qinv(pw), target_world)
                world[idx] = qmul(pw, local)
                if bone is not None:
                    local_tracks.setdefault(idx, []).append(local)

        for idx in order:
            if idx not in local_tracks:
                continue
            quats = []
            prev = None
            for q in local_tracks[idx]:
                if prev is not None and sum(a * b for a, b in zip(q, prev)) < 0:
                    q = tuple(-v for v in q)
                prev = q
                quats.append(qnorm(q))
            out_acc = add_accessor(quats, 4, 'VEC4')
            if time_acc is None:
                time_acc = add_accessor(times, 1, 'SCALAR')
            samplers.append({'input': time_acc, 'output': out_acc, 'interpolation': 'LINEAR'})
            channels.append({'sampler': len(samplers) - 1,
                             'target': {'node': idx, 'path': 'rotation'}})

        # Hips translation: de-trended horizontally, vertical measured from the
        # rig's rest hip height (Mixamo clips often start with soft knees).
        ratio = hip_height / clip['hipsRest'][2]
        rest_t = nodes[hips_gltf].get('translation', [0, 0, 0])
        rest_z = clip['hipsRest'][2]
        trans = []
        for i in range(n_frames):
            t = i / (n_frames - 1) if n_frames > 1 else 0.0
            dx = clip['hips'][i][0] - (sx + (ex - sx) * t)
            dy = clip['hips'][i][1] - (sy + (ey - sy) * t)
            dz = clip['hips'][i][2] - rest_z
            gx, gy, gz = dx * ratio, dz * ratio, -dy * ratio
            trans.append((rest_t[0] + gx, rest_t[1] + gy, rest_t[2] + gz))
        out_acc = add_accessor(trans, 3, 'VEC3')
        samplers.append({'input': time_acc, 'output': out_acc, 'interpolation': 'LINEAR'})
        channels.append({'sampler': len(samplers) - 1,
                         'target': {'node': hips_gltf, 'path': 'translation'}})

        animations.append({'name': name, 'channels': channels, 'samplers': samplers})
        clip_info.append({'name': name, 'seconds': round((n_frames - 1) / FPS, 3)})
        print(f'{name:34s} {n_frames:4d} frames  {len(channels)} channels')

    while len(buf) % 4:
        buf.append(0)
    root = next(i for i, n in enumerate(out_nodes) if n.get('name') == 'Armature')
    doc = {
        'asset': {'version': '2.0', 'generator': 'ctviewer anim baker (swing)'},
        'scene': 0,
        'scenes': [{'name': 'Scene', 'nodes': [root]}],
        'nodes': out_nodes,
        'accessors': accessors,
        'bufferViews': buffer_views,
        'buffers': [{'byteLength': len(buf)}],
        'animations': animations,
    }
    js = json.dumps(doc, separators=(',', ':')).encode('utf-8')
    while len(js) % 4:
        js += b' '
    blob = (struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(buf))
            + struct.pack('<II', len(js), 0x4E4F534A) + js
            + struct.pack('<II', len(buf), 0x004E4942) + bytes(buf))
    Path(OUT).write_bytes(blob)
    print('wrote', OUT, len(blob), 'bytes')

    catalog = json.loads(Path(CHARS).read_text(encoding='utf-8'))
    catalog['clips'] = clip_info
    Path(CHARS).write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n',
                           encoding='utf-8')
    print('catalog clips updated:', CHARS)


main()
