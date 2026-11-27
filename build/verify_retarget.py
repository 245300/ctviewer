"""Compare the retargeted pose against the source clip, bone by bone.

    python build/verify_retarget.py

For every mapped bone this recomputes exactly what build_anim_abs.py writes,
then reports the angle between the *source* bone's world direction and the
*target* bone's world direction at the same frame.  A faithful retarget keeps
that angle near zero for every bone; a systematic offset on one limb means the
rest-pose axis correction is wrong, not that the model is broken.

Bone direction is the bone's own +Y axis (both rigs are glTF-standard, so the
along-bone axis is local +Y), expressed in glTF world axes.
"""
import json
import math
import struct
from pathlib import Path

CHAR_GLB = r'D:\ctviewer\assets\characters\colphne.glb'
ANIMS = r'D:\ctviewer\build\anims_v2.json'
for side, mix_side in (('L', 'Left'), ('R', 'Right')):
    for finger, mix_finger in (('Index', 'Index'), ('Middle', 'Middle'), ('Ring', 'Ring'),
                               ('Little', 'Pinky')):
        for seg in (1, 2, 3):
            BONE_MAP[f'{finger}Finger{seg}_{side}'] = f'mixamorig:{mix_side}Hand{mix_finger}{seg}'
    for seg in (0, 1, 2):
        BONE_MAP[f'Thumb{seg}_{side}'] = f'mixamorig:{mix_side}HandThumb{seg + 1}'
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


def qrot(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    tx = 2 * (y * vz - z * vy)
    ty = 2 * (z * vx - x * vz)
    tz = 2 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx))


def angle(a, b):
    na = math.sqrt(sum(v * v for v in a)) or 1.0
    nb = math.sqrt(sum(v * v for v in b)) or 1.0
    d = sum(x * y for x, y in zip(a, b)) / (na * nb)
    return math.degrees(math.acos(max(-1.0, min(1.0, d))))


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
    return json.loads(chunks[0][1])


def main():
    gltf = read_glb(CHAR_GLB)
    nodes = gltf['nodes']
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i
    local_rest = {i: tuple(n.get('rotation', [0, 0, 0, 1])) for i, n in enumerate(nodes)}

    def by_name(name):
        for i, n in enumerate(nodes):
            if n.get('name') == name:
                return i
        return None

    node_of = {b: by_name(b) for b in BONE_MAP}
    node_of = {b: i for b, i in node_of.items() if i is not None}
    bone_of_node = {i: b for b, i in node_of.items()}

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

    clips = json.loads(Path(ANIMS).read_text(encoding='utf-8'))
    c = (-math.sin(math.pi / 4), 0.0, 0.0, math.cos(math.pi / 4))

    for clip_name in ('Idle', 'Walking', 'Running'):
        clip = clips[clip_name]
        rest_world = {b: tuple(q) for b, q in clip['restWorld'].items()}
        frame = len(clip['frames']) // 4
        print(f'\n=== {clip_name} frame {clip["frames"][frame]} ===')
        world = {}
        worst = []
        for idx in order:
            p = parent.get(idx)
            pw = world[p] if p is not None else (0.0, 0.0, 0.0, 1.0)
            bone = bone_of_node.get(idx)
            if bone is None:
                local = local_rest[idx]
            else:
                mix = BONE_MAP[bone]
                d = clip['bones'][mix][frame]
                if d is None:
                    local = local_rest[idx]
                else:
                    qa = qmul(c, qmul(tuple(d), rest_world[mix]))
                    local = qmul(qinv(pw), qa)
            world[idx] = qmul(pw, local)
        for bone, idx in node_of.items():
            mix = BONE_MAP[bone]
            d = clip['bones'][mix][frame]
            if d is None:
                continue
            src = qmul(c, qmul(tuple(d), rest_world[mix]))
            tgt = world[idx]
            sd = qrot(src, (0.0, 1.0, 0.0))
            td = qrot(tgt, (0.0, 1.0, 0.0))
            a = angle(sd, td)
            worst.append((a, bone, sd, td))
        worst.sort(reverse=True)
        for a, bone, sd, td in worst[:8]:
            print(f'  {bone:16s} {a:6.1f}deg   src {tuple(round(v, 2) for v in sd)}'
                  f'   tgt {tuple(round(v, 2) for v in td)}')
        mean = sum(w[0] for w in worst) / max(1, len(worst))
        print(f'  mean {mean:.1f} deg over {len(worst)} bones')


main()
