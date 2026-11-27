/**
 * The city the garage stands in - the Unity racing project's Classical_city.
 *
 * The block is baked into an in-project GLB (assets/scenes/city/city.glb) by
 * tools/fbx2glb.html + scripts/city_glb.mjs: the Unity FBX is parsed once at
 * build time, its Phong materials rebuilt as PBR, its ~1700 meshes merged to
 * ten (one per texture), the vertices welded, quantized and meshopt-compressed.
 * What was 21 MB of FBX plus ~2 s of parsing is 7.7 MB of GLB that is ready to
 * draw the moment it arrives.
 *
 * Layout: one block is centred on the garage and the garage sits in the plaza
 * carved out of the middle of it, so the city surrounds the building instead of
 * ringing it at a distance. Five more copies, scaled up and pushed out to where
 * the centred block ends, carry the skyline to the horizon - they share the same
 * geometry and materials, so they cost draw calls and nothing else.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const BLOCK_SPAN = 620;     // metres across, as baked by scripts/city_glb.mjs
const RING_COPIES = 5;      // filler blocks beyond the centred one
const RING_SCALE = 1.65;
// Chosen so the ring's inner edge meets the centred block's outer edge: the
// block is square and is turned to face the middle, so its nearest face sits at
// radius - span*scale/2. Any closer and the two sets of buildings interpenetrate.
const RING_RADIUS = BLOCK_SPAN / 2 + (BLOCK_SPAN * RING_SCALE) / 2 - 12;
// A hair under the deck, so the garage's own floor and bay markings win the
// depth test without a visible step.
const DECK_Y = -0.04;

export class CityController {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'City';
    this.group.position.y = DECK_Y;
    this.root = null;
    this.rings = [];
    this.ringsVisible = true;
    this.ready = false;
    scene.add(this.group);
    this._buildGround();
  }

  /** Asphalt apron, so the gaps between the blocks are not sky. */
  _buildGround() {
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(2400, 96),
      new THREE.MeshStandardMaterial({
        color: 0x1a1f26,
        roughness: 0.95,
        metalness: 0.0,
        envMapIntensity: 0.3,
      }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.06;
    apron.name = 'CityGround';
    this.apron = apron;
    this.group.add(apron);
  }

  async load(url) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    const block = gltf.scene;
    block.name = 'CityBlock';

    const box = new THREE.Box3().setFromObject(block);
    const size = box.getSize(new THREE.Vector3());
    // The bake already put the walkable deck at y=0 and centred the block; this
    // only reports, so a rebuild with different numbers shows up in the console.
    console.info(
      `city ${size.x.toFixed(0)}×${size.y.toFixed(0)}×${size.z.toFixed(0)} m`
      + ` · y ${box.min.y.toFixed(1)}…${box.max.y.toFixed(1)}`,
    );

    this._tintScene(block);

    const root = new THREE.Group();
    root.name = 'CityRoot';
    root.add(block);

    for (let i = 0; i < RING_COPIES; i++) {
      const angle = (i / RING_COPIES) * Math.PI * 2 + Math.PI / RING_COPIES;
      // clone() shares geometry and materials - only the transform is new.
      const copy = block.clone(true);
      copy.position.set(Math.cos(angle) * RING_RADIUS, 0, Math.sin(angle) * RING_RADIUS);
      copy.rotation.y = -angle + Math.PI / 2;
      copy.scale.multiplyScalar(RING_SCALE);
      copy.name = `CityRing${i}`;
      root.add(copy);
      this.rings.push(copy);
    }

    this.root = root;
    this.group.add(root);
    this.ready = true;
    this._buildNav(block);
    if (this._pendingSky) this.applySky(this._pendingSky);
  }

  /**
   * A 1 m occupancy grid for the walking controller.
   *
   * The block is merged into ten draw calls, so there are no per-building
   * meshes left to collide against.  Roof and wall triangles are all above
   * head height, while the walkable deck sits at y=0, so every triangle with
   * any vertex above 2.4 m is stamped into its XZ footprint.  It runs once
   * after the block is on screen; until it finishes the player simply walks
   * unobstructed.
   */
  _buildNav(block) {
    const t0 = performance.now();
    const box = new THREE.Box3().setFromObject(block);
    const cell = 1;
    const pad = 4;
    const minX = Math.floor(box.min.x) - pad;
    const minZ = Math.floor(box.min.z) - pad;
    const cols = Math.ceil(box.max.x - box.min.x) + pad * 2;
    const rows = Math.ceil(box.max.z - box.min.z) + pad * 2;
    const grid = new Uint8Array(cols * rows);
    const v = new THREE.Vector3();
    let triangles = 0;
    block.updateMatrixWorld(true);
    block.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      const geo = obj.geometry;
      const pos = geo.attributes.position;
      if (!pos) return;
      const index = geo.index;
      const tris = index ? index.count / 3 : pos.count / 3;
      const mw = obj.matrixWorld;
      for (let t = 0; t < tris; t++) {
        let maxY = -Infinity;
        let loX = Infinity;
        let hiX = -Infinity;
        let loZ = Infinity;
        let hiZ = -Infinity;
        for (let k = 0; k < 3; k++) {
          const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
          v.fromBufferAttribute(pos, vi).applyMatrix4(mw);
          if (v.y > maxY) maxY = v.y;
          if (v.x < loX) loX = v.x;
          if (v.x > hiX) hiX = v.x;
          if (v.z < loZ) loZ = v.z;
          if (v.z > hiZ) hiZ = v.z;
        }
        if (maxY < 2.4) continue;
        triangles++;
        const i0 = Math.max(0, Math.floor((loX - minX) / cell));
        const i1 = Math.min(cols - 1, Math.floor((hiX - minX) / cell));
        const j0 = Math.max(0, Math.floor((loZ - minZ) / cell));
        const j1 = Math.min(rows - 1, Math.floor((hiZ - minZ) / cell));
        for (let j = j0; j <= j1; j++) {
          const row = j * cols;
          for (let i = i0; i <= i1; i++) grid[row + i] = 1;
        }
      }
    });
    this.nav = { minX, minZ, cell, cols, rows, grid };
    console.info(`city nav ${cols}x${rows} cells from ${triangles} elevated triangles`
      + ` · ${(performance.now() - t0).toFixed(0)} ms`);
  }

  /** True where a building (or a tall prop) occupies the cell. */
  isBlocked(x, z) {
    const n = this.nav;
    if (!n) return false;
    const i = Math.floor((x - n.minX) / n.cell);
    const j = Math.floor((z - n.minZ) / n.cell);
    if (i < 0 || j < 0 || i >= n.cols || j >= n.rows) return false;
    return n.grid[j * n.cols + i] === 1;
  }

  /** Static, unlit by shadows, and never blowing out the car through the glass. */
  _tintScene(root) {
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = false;
      obj.frustumCulled = true;
      for (const m of [].concat(obj.material || [])) {
        if (!m) continue;
        // Remember the authored albedo: applySky() dims the whole block after
        // dark and needs something to dim back to.
        if (m.color && !m.userData.__base) m.userData.__base = m.color.clone();
        if ('envMapIntensity' in m) m.envMapIntensity = 0.45;
        // The bake ships the Unity night light maps in the emissive slot. They
        // are driven entirely by applySky(); without a preset they must be off.
        if ('emissiveIntensity' in m) m.emissiveIntensity = 0;
        m.needsUpdate = true;
      }
    });
  }

  /**
   * Tie the city to the hour.
   *
   * Unity's set ships a night window-light map per facade; the bake wired those
   * into the emissive channel, so night is a matter of turning that channel up
   * rather than lighting 1700 windows by hand.
   */
  applySky(preset) {
    this._pendingSky = preset;
    if (!this.root) return;
    const night = preset.cityEmissive ?? 0;
    const dim = preset.cityDim ?? 1;
    this.root.traverse((obj) => {
      if (!obj.isMesh) return;
      for (const m of [].concat(obj.material || [])) {
        if (!m) continue;
        if (m.color && m.userData.__base) m.color.copy(m.userData.__base).multiplyScalar(dim);
        if ('emissiveIntensity' in m) m.emissiveIntensity = 0.04 + night * 1.15;
        // Daytime glass wants the sky in it; at night the window map carries it.
        if ('envMapIntensity' in m) m.envMapIntensity = 0.5 + (1 - Math.min(1, night)) * 0.5;
        m.needsUpdate = true;
      }
    });
    if (this.apron) {
      this.apron.material.color.set(0x1a1f26).lerp(new THREE.Color(0x070a0e), Math.min(1, night));
    }
  }

  setVisible(on) {
    this.group.visible = on;
  }

  /**
   * The five filler blocks sit ~810 m out and carry five sixths of the city's
   * triangles (5 x 336k of 2.0M). From the garage - and from the plaza the
   * player spawns on - the centred 620 m block is between the eye and them, so
   * they render fully occluded. Hiding them whenever the eye is near the
   * centre is visually free and removes ~1.7M triangles from the frame.
   */
  setRingsVisible(on) {
    if (on === this.ringsVisible) return;
    this.ringsVisible = on;
    for (const ring of this.rings) ring.visible = on;
  }

  dispose() {
    if (!this.root) return;
    this.group.remove(this.root);
    this.root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.geometry?.dispose?.();
      for (const m of [].concat(obj.material || [])) {
        if (!m) continue;
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
          if (m[k]) m[k].dispose?.();
        }
        m.dispose?.();
      }
    });
    this.root = null;
    this.ready = false;
  }
}
