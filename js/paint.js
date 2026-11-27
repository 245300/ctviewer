import * as THREE from 'three';
import { PAINTS } from './config.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Applies a configurable car-paint material stack to a set of meshes and
 * animates every parameter over CONFIG.paintTransitionMs (460 ms).
 */
export class PaintController {
  constructor(meshes, { duration = 460, onChange = null, preserveLivery = false } = {}) {
    this.meshes = meshes;
    this.duration = duration;
    this.onChange = onChange;
    this.preserveLivery = preserveLivery;
    this.index = 0;
    this.materials = [];
    this.state = this._presetState(PAINTS[0]);
    this.target = { ...this.state };
    this.transition = null;
    this._setupMaterials();
  }

  _presetState(p) {
    return {
      color: new THREE.Color(p.color),
      metalness: p.metalness,
      roughness: p.roughness,
      clearcoat: p.clearcoat,
      clearcoatRoughness: p.clearcoatRoughness,
      iridescence: p.iridescence,
      iridescenceIOR: p.iridescenceIOR,
      sheen: p.sheen,
      sheenColor: new THREE.Color(p.sheenColor),
      envMapIntensity: p.envMapIntensity,
    };
  }

  _setupMaterials() {
    for (const mesh of this.meshes) {
      // Start from the authored material so normal / AO / clearcoat maps
      // survive the repaint.  Base color and the physical finish values are
      // then driven by the preset.
      const source = mesh.userData.originalMaterial || mesh.material;
      const mat = new THREE.MeshPhysicalMaterial();
      if (source && source.isMaterial) {
        // Copy only the maps / common channels shared by all material types.
        // MeshPhysicalMaterial.copy() expects a physical source and would
        // crash on a plain MeshStandardMaterial (clearcoatNormalScale etc.).
        if (source.color) mat.color.copy(source.color);
        if (source.emissive) mat.emissive.copy(source.emissive);
        mat.map = source.map || null;
        mat.normalMap = source.normalMap || null;
        if (source.normalScale && mat.normalScale) mat.normalScale.copy(source.normalScale);
        mat.roughnessMap = source.roughnessMap || null;
        mat.metalnessMap = source.metalnessMap || null;
        mat.aoMap = source.aoMap || null;
        mat.aoMapIntensity = source.aoMapIntensity ?? 1;
        mat.emissiveMap = source.emissiveMap || null;
        mat.alphaMap = source.alphaMap || null;
        mat.vertexColors = source.vertexColors || false;
        mat.side = source.side ?? THREE.FrontSide;
      }
      mat.name = 'CTViewer_CarPaint';
      mat.color.copy(this.state.color);
      mat.metalness = this.state.metalness;
      mat.roughness = this.state.roughness;
      mat.clearcoat = this.state.clearcoat;
      mat.clearcoatRoughness = this.state.clearcoatRoughness;
      mat.iridescence = this.state.iridescence;
      mat.iridescenceIOR = this.state.iridescenceIOR;
      mat.sheen = this.state.sheen;
      mat.sheenColor.copy(this.state.sheenColor);
      mat.envMapIntensity = this.state.envMapIntensity;
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      mat.side = THREE.FrontSide;
      mat.transmission = 0;
      mat.thickness = 0;
      mat.attenuationDistance = Infinity;
      // Most paint materials are flat-color; keeping a livery map is opt-in
      // per car (e.g. the McLaren F1 LM).
      if (!this.preserveLivery) {
        mat.map = null;
        mat.emissiveMap = null;
      }
      mat.needsUpdate = true;
      mesh.material = mat;
      this.materials.push(mat);
    }
  }

  apply(index, { immediate = false } = {}) {
    const p = PAINTS[index];
    if (!p) return;
    this.index = index;
    this.target = this._presetState(p);
    if (immediate || this.duration <= 0) {
      this.state = this._cloneState(this.target);
      this._writeState();
      this.transition = null;
    } else {
      this.transition = {
        from: this._cloneState(this.state),
        to: this._cloneState(this.target),
        start: performance.now(),
        duration: this.duration,
      };
    }
    this.onChange?.(index, p);
  }

  /** Recolour the current finish, keeping its metalness / clearcoat / sheen. */
  setColor(hex) {
    if (!hex) return;
    this.target = { ...this.target, color: new THREE.Color(hex) };
    this.transition = {
      from: this._cloneState(this.state),
      to: this._cloneState(this.target),
      start: performance.now(),
      duration: this.duration,
    };
  }

  _cloneState(s) {
    return {
      color: s.color.clone(),
      metalness: s.metalness,
      roughness: s.roughness,
      clearcoat: s.clearcoat,
      clearcoatRoughness: s.clearcoatRoughness,
      iridescence: s.iridescence,
      iridescenceIOR: s.iridescenceIOR,
      sheen: s.sheen,
      sheenColor: s.sheenColor.clone(),
      envMapIntensity: s.envMapIntensity,
    };
  }

  update() {
    if (!this.transition) return;
    const tr = this.transition;
    const t = clamp01((performance.now() - tr.start) / tr.duration);
    const e = easeInOutCubic(t);
    this.state.color.lerpColors(tr.from.color, tr.to.color, e);
    this.state.sheenColor.lerpColors(tr.from.sheenColor, tr.to.sheenColor, e);
    for (const key of [
      'metalness', 'roughness', 'clearcoat', 'clearcoatRoughness',
      'iridescence', 'iridescenceIOR', 'sheen', 'envMapIntensity',
    ]) {
      this.state[key] = THREE.MathUtils.lerp(tr.from[key], tr.to[key], e);
    }
    this._writeState();
    if (t >= 1) {
      this.state = this._cloneState(tr.to);
      this._writeState();
      this.transition = null;
    }
  }

  _writeState() {
    for (const mat of this.materials) {
      mat.color.copy(this.state.color);
      mat.metalness = this.state.metalness;
      mat.roughness = this.state.roughness;
      mat.clearcoat = this.state.clearcoat;
      mat.clearcoatRoughness = this.state.clearcoatRoughness;
      mat.iridescence = this.state.iridescence;
      mat.iridescenceIOR = this.state.iridescenceIOR;
      mat.sheen = this.state.sheen;
      mat.sheenColor.copy(this.state.sheenColor);
      mat.envMapIntensity = this.state.envMapIntensity;
      mat.needsUpdate = true;
    }
  }

  getState() {
    return {
      index: this.index,
      id: PAINTS[this.index].id,
      color: '#' + this.state.color.getHexString(),
      metalness: this.state.metalness,
      roughness: this.state.roughness,
      clearcoat: this.state.clearcoat,
      transitioning: Boolean(this.transition),
    };
  }
}
