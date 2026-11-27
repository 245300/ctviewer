/**
 * Lightweight semantic naming for imported GLB car parts.
 *
 * Real-world Sketchfab models rarely ship a clean part taxonomy.  We derive a
 * stable Chinese label + category from the mesh name, its material names and
 * its position inside the car.  No network or model metadata is required.
 */

import * as THREE from 'three';

/**
 * Exact tokens produced by scripts/merge_parts.mjs for the "advanced"
 * pre-split part sets (Purosangue / Lanzador / Elva).  These are authoritative
 * names from the model author, so they are looked up instead of guessed.
 */
const SEMANTIC = {
  bagage: { label: '后备厢盖', category: '外饰' },
  bumper_f: { label: '前保险杠', category: '外饰' },
  bumper_r: { label: '后保险杠', category: '外饰' },
  cap: { label: '油箱盖', category: '外饰' },
  door_lf: { label: '左前车门', category: '外饰' },
  door_lr: { label: '左后车门', category: '外饰' },
  door_rf: { label: '右前车门', category: '外饰' },
  door_rr: { label: '右后车门', category: '外饰' },
  exhaust: { label: '排气系统', category: '底盘' },
  hood: { label: '引擎盖', category: '外饰' },
  headlamp: { label: '前大灯', category: '灯光' },
  tail_light: { label: '尾灯', category: '灯光' },
  tail_light_glass: { label: '尾灯灯罩', category: '灯光' },
  panoramic: { label: '全景天窗', category: '玻璃' },
  sidemirror_l: { label: '左后视镜', category: '外饰' },
  sidemirror_r: { label: '右后视镜', category: '外饰' },
  sideskirt_l: { label: '左侧裙', category: '空气动力学' },
  sideskirt_r: { label: '右侧裙', category: '空气动力学' },
  sideskirt_lr: { label: '左后侧裙', category: '空气动力学' },
  sideskirt_rr: { label: '右后侧裙', category: '空气动力学' },
  sparkboard_lf: { label: '左前轮眉导流板', category: '空气动力学' },
  sparkboard_rf: { label: '右前轮眉导流板', category: '空气动力学' },
  sparkboard_lr: { label: '左后轮眉导流板', category: '空气动力学' },
  sparkboard_rr: { label: '右后轮眉导流板', category: '空气动力学' },
  spoiler: { label: '尾翼', category: '空气动力学' },
  steering: { label: '方向盘', category: '内饰' },
  wheels_lf: { label: '左前轮组', category: '车轮' },
  wheels_rf: { label: '右前轮组', category: '车轮' },
  wheels_lr: { label: '左后轮组', category: '车轮' },
  wheels_rr: { label: '右后轮组', category: '车轮' },
  winshield: { label: '前风挡', category: '玻璃' },
  rear_window: { label: '后窗', category: '玻璃' },
};

/** `door_lf_2_1` -> `door_lf`: the merge keeps a numeric suffix per mesh. */
function semanticKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/(_\d+)+$/, '')
    .trim();
}

const RULES = [
  { keys: ['frontbumper', 'front bumper', 'bumper front', 'bumper_f'], label: '前保险杠', category: '外饰', paint: true },
  { keys: ['rearbumper', 'rear bumper', 'bumper rear', 'bumper_r'], label: '后保险杠', category: '外饰', paint: true },
  { keys: ['door'], label: '车门', category: '外饰', side: true, paint: true },
  { keys: ['hood', 'bonnet'], label: '引擎盖', category: '外饰', paint: true },
  { keys: ['boot', 'trunk', 'tailgate', 'bagage'], label: '后备厢盖', category: '外饰', paint: true },
  { keys: ['roof'], label: '车顶', category: '外饰', paint: true },
  { keys: ['mirror'], label: '后视镜', category: '外饰', side: true, paint: true },
  { keys: ['spoiler', 'rear wing', 'wing'], label: '尾翼', category: '空气动力学', paint: true },
  { keys: ['diffuser'], label: '扩散器', category: '空气动力学', paint: true },
  { keys: ['sideskirt', 'side skirt'], label: '侧裙', category: '空气动力学', paint: true },
  { keys: ['grille', 'grill'], label: '格栅', category: '外饰' },
  { keys: ['badge', 'logo', 'emblem'], label: '徽标', category: '外饰' },
  { keys: ['plate'], label: '车牌', category: '外饰' },
  { keys: ['headlamp', 'headlight', 'head light'], label: '前大灯', category: '灯光', side: true },
  { keys: ['taillight', 'tail light', 'rear light'], label: '尾灯', category: '灯光', side: true },
  { keys: ['brakelight', 'brake light', 'reverselight', 'reverse light', 'signal'], label: '灯组', category: '灯光', side: true },
  { keys: ['light', 'lamp', 'led'], label: '灯组', category: '灯光', side: true },
  { keys: ['windshield', 'windscreen', 'window', 'glass'], label: '玻璃', category: '玻璃' },
  { keys: ['steering wheel', 'steering'], label: '方向盘', category: '内饰' },
  { keys: ['seat', 'interior', 'cockpit', 'dashboard', 'leather', 'stitching', 'suede', 'alcantara', 'carpet', 'tappetini', 'skin'], label: '内饰组件', category: '内饰' },
  { keys: ['mechanic', 'mechanics', 'engine'], label: '发动机 / 机械组件', category: '底盘' },
  { keys: ['exhaust'], label: '排气系统', category: '底盘' },
  { keys: ['chassis', 'undercarriage', 'underbody'], label: '底盘结构', category: '底盘' },
  { keys: ['suspension', 'shock', 'spring'], label: '悬挂', category: '底盘' },
  { keys: ['tyre', 'tire'], label: '轮胎', category: '车轮', wheel: true },
  { keys: ['rim', 'wheel'], label: '轮毂', category: '车轮', wheel: true },
  { keys: ['rotor', 'brake disc', 'brake disk', 'disc', 'disk'], label: '刹车盘', category: '车轮', wheel: true },
  { keys: ['caliper'], label: '刹车卡钳', category: '车轮', wheel: true },
  { keys: ['brake'], label: '制动系统', category: '车轮', wheel: true },
  { keys: ['chrome', 'chromium'], label: '镀铬饰件', category: '外饰' },
  { keys: ['plastics', 'plastic'], label: '塑料饰件', category: '外饰' },
  { keys: ['stickers', 'sticker', 'decal'], label: '贴纸 / 拉花', category: '外饰' },
  { keys: ['carbon'], label: '碳纤维饰件', category: '外饰' },
  { keys: ['black'], label: '黑色饰件', category: '外饰' },
  { keys: ['wunderbaum', 'freshener'], label: '香薰', category: '内饰' },
  { keys: ['coat'], label: '清漆层', category: '外饰' },
  { keys: ['body', 'shell', 'coachwork', 'carpaint', 'car paint', 'bodypaint'], label: '车身覆盖件', category: '外饰', paint: true },
];

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[:._\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sidePrefix(text) {
  if (/\bleft\b|\blf\b|\blr\b|_left|_lf|_lr/.test(text)) return '左';
  if (/\bright\b|\brf\b|\brr\b|_right|_rf|_rr/.test(text)) return '右';
  return '';
}

function isGenericName(name) {
  return !name || /^(object|mesh|node|polysurface|poly surface|geo|part|group)/i.test(name);
}

function wheelPrefix(nameText, materialText, box, modelBox) {
  const hay = `${nameText} ${materialText}`;
  let front = /\bfront\b|\bfrontal\b|\bf\b|_f\b/.test(hay) ? '前' : '';
  let rear = /\brear\b|\bback\b|\br\b|_r\b/.test(hay) ? '后' : '';
  if (!front && !rear) {
    const c = box ? box.getCenter(box.min.clone()) : null;
    const mc = modelBox ? modelBox.getCenter(modelBox.min.clone()) : null;
    if (c && mc) front = c.x >= mc.x ? '前' : '后';
  }
  let side = sidePrefix(hay);
  if (!side && box && modelBox) {
    const c = box.getCenter(box.min.clone());
    const mc = modelBox.getCenter(modelBox.min.clone());
    side = c.z >= mc.z ? '左' : '右';
  }
  return `${side}${front || rear || ''}`;
}

function bodyPanelLabel(box, modelBox) {
  if (!box || !modelBox) return '车身覆盖件';
  const c = box.getCenter(new THREE.Vector3());
  const mc = modelBox.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const ms = modelBox.getSize(new THREE.Vector3());
  if (s.x > ms.x * 0.65 && s.y > ms.y * 0.35) return '车身壳体';
  if (c.x > mc.x + ms.x * 0.2) return '前部覆盖件';
  if (c.x < mc.x - ms.x * 0.2) return '尾部覆盖件';
  if (Math.abs(c.z - mc.z) > ms.z * 0.25) return '侧围覆盖件';
  if (c.y > mc.y + ms.y * 0.2) return '车顶 / 引擎盖';
  return '车身覆盖件';
}

/**
 * @param {object} opts
 * @param {string} opts.name        mesh / node name from the GLB
 * @param {string[]} opts.materials material names
 * @param {object} opts.car         catalog entry (for paintMaterials)
 * @param {number} opts.index       zero-based traversal index
 * @param {THREE.Box3} opts.box     world-space bounds of this part
 * @param {THREE.Box3} opts.modelBox world-space bounds of the whole car
 * @returns {{id:string,label:string,category:string,paint:boolean,sourceName:string}}
 */
export function classifyPart({ name, materials, car, index, box, modelBox }) {
  const nameText = normalize(name);
  const materialText = normalize((materials || []).join(' '));
  const hay = `${nameText} ${materialText}`;
  const paintedMaterial = (car?.paintMaterials || []).some((m) =>
    materialText.includes(normalize(m)));

  let rule = car?.materialFirst ? null : RULES.find((r) => r.keys.some((k) => nameText.includes(k)));
  if (!rule && (car?.materialFirst || isGenericName(nameText))) {
    rule = RULES.find((r) => r.keys.some((k) => materialText.includes(k)));
  }
  // A painted material is a strong signal even when both names are generic.
  if (!rule && paintedMaterial) {
    rule = RULES.find((r) => r.label === '车身覆盖件');
  }

  const semantic = SEMANTIC[semanticKey(name)];
  let label = semantic?.label || rule?.label || (paintedMaterial ? '车身覆盖件' : '结构件');
  let category = semantic?.category || rule?.category || (paintedMaterial ? '外饰' : '其他');
  if (!semantic && rule?.label === '车身覆盖件') label = bodyPanelLabel(box, modelBox);

  if (!semantic && rule?.wheel) {
    label = `${wheelPrefix(nameText, materialText, box, modelBox)}${label}`;
  } else if (!semantic && rule?.side) {
    label = `${sidePrefix(hay)}${label}`;
  }

  const paintHay = car?.materialFirst ? materialText : hay;
  const noPaint = /glass|window|light|lamp|badge|grille|plate|mirror glass|rim|tyre|tire|caliper|rotor|brake|interior|leather|carbon|chrome/.test(paintHay);
  const paint = Boolean(paintedMaterial && !noPaint);

  return {
    id: `P${String(index + 1).padStart(3, '0')}`,
    label,
    category,
    paint,
    sourceName: name || `part_${index + 1}`,
    materialText: (materials || []).join(' / '),
  };
}

export const PART_CATEGORIES = ['外饰', '玻璃', '灯光', '空气动力学', '车轮', '内饰', '底盘', '其他'];
