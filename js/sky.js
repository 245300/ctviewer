/**
 * Sky: the Unity racing project's own photographic HDRIs, not a gradient shader.
 *
 * Each preset is an equirectangular HDR capture from
 * `天天赛车/Assets/CineMachines/Classical_city/Textures/*.hdr`, rendered as the
 * scene background *and* prefiltered into the PMREM environment, so the car
 * paint reflects the actual sky - clouds, sunset banding, stars and all.
 *
 * Files live in assets/scenes/ and are decoded by three's RGBELoader. They are
 * loaded lazily and cached, so switching back and forth costs nothing after the
 * first visit to each hour.
 */
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

export const SKY_PRESETS = [
  {
    id: 'day',
    name: '白天',
    en: 'Day',
    hdr: 'assets/scenes/day_sky.hdr',
    credit: '天天赛车 Unity 项目 · Classical_city/day_sky.hdr',
    // Rotates the capture so the sun lands where the garage window looks out.
    rotation: Math.PI * 0.62,
    exposure: 1.0,
    backgroundBlur: 0.0,
    bgIntensity: 1.0,
    cityDim: 1.0,
    // The HDRI carries its own sun; these only top up the indoor fill.
    sunColor: '#fff8ea',
    sunIntensity: 1.5,
    sunPos: [0.42, 0.68, 0.36],
    hemiSky: '#dcecff',
    hemiGround: '#59636f',
    hemiIntensity: 0.55,
    ambient: 0.2,
    envIntensity: 1.0,
    fog: '#b9cde2',
    fogNear: 200,
    fogFar: 1600,
    cityEmissive: 0.05,
    cityColor: '#a8b4c1',
    desc: 'Unity 场景天空 · 晴日',
  },
  {
    id: 'dusk',
    name: '阴天',
    en: 'Overcast',
    hdr: 'assets/scenes/overcast_sky.hdr',
    credit: '天天赛车 Unity 项目 · Classical_city/overcast_sky.hdr',
    rotation: Math.PI * 0.18,
    exposure: 1.05,
    backgroundBlur: 0.0,
    // This capture is stored far darker than the day one in linear light -
    // eyeballed to the pale lead-grey it should read, and it is not a small
    // correction: at 1.0 the overcast hour is indistinguishable from midnight.
    bgIntensity: 9.0,
    cityDim: 0.82,
    sunColor: '#dfe8f2',
    sunIntensity: 0.9,
    sunPos: [0.55, 0.5, 0.42],
    hemiSky: '#cfdae6',
    hemiGround: '#3b3540',
    hemiIntensity: 0.7,
    ambient: 0.2,
    envIntensity: 1.0,
    fog: '#a8b6c4',
    fogNear: 170,
    fogFar: 1300,
    cityEmissive: 0.2,
    cityColor: '#8d99a6',
    desc: 'Unity 场景天空 · 阴天柔光',
  },
  {
    id: 'night',
    name: '夜晚',
    en: 'Night',
    hdr: 'assets/scenes/night_sky.hdr',
    credit: '天天赛车 Unity 项目 · Classical_city/night_sky.hdr',
    rotation: Math.PI * 0.9,
    exposure: 1.15,
    backgroundBlur: 0.0,
    bgIntensity: 3.2,
    // Buildings keep their daytime albedo unless told otherwise, which at night
    // leaves 1700 windows reading as a lit-up city at noon.
    cityDim: 0.4,
    sunColor: '#9dc4ff',
    sunIntensity: 0.35,
    sunPos: [-0.35, 0.62, 0.42],
    hemiSky: '#26405f',
    hemiGround: '#0a0f15',
    hemiIntensity: 0.3,
    ambient: 0.1,
    envIntensity: 1.0,
    fog: '#0d1622',
    fogNear: 150,
    fogFar: 1100,
    cityEmissive: 1.0,
    cityColor: '#4a5668',
    desc: 'Unity 场景天空 · 夜景',
  },
];

/**
 * Owns the HDRI background, the PMREM environment derived from it, and the
 * fill lights that keep the garage interior readable at every hour.
 */
export class SkyController {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.preset = SKY_PRESETS[0];
    this.loader = new RGBELoader();
    this.loader.setDataType(THREE.HalfFloatType);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this._textures = new Map();   // hdr url -> { texture, envMap }
    this._pending = new Map();
    this._token = 0;

    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.name = 'SkySun';
    this.sun = sun;
    scene.add(sun);

    const hemi = new THREE.HemisphereLight(0xdcecff, 0x59636f, 0.55);
    hemi.name = 'SkyHemi';
    this.hemi = hemi;
    scene.add(hemi);

    const ambient = new THREE.AmbientLight(0xffffff, 0.2);
    ambient.name = 'SkyAmbient';
    this.ambient = ambient;
    scene.add(ambient);
  }

  /** Fetch + decode one HDRI and prefilter it into an environment map. */
  _load(preset) {
    if (this._textures.has(preset.hdr)) return Promise.resolve(this._textures.get(preset.hdr));
    if (this._pending.has(preset.hdr)) return this._pending.get(preset.hdr);
    const job = this.loader.loadAsync(preset.hdr).then((texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      // PMREM is what turns an LDR-looking background into usable IBL for the
      // clearcoat / iridescence channels on the paint.
      const envMap = this.pmrem.fromEquirectangular(texture).texture;
      const entry = { texture, envMap };
      this._textures.set(preset.hdr, entry);
      this._pending.delete(preset.hdr);
      return entry;
    }).catch((err) => {
      this._pending.delete(preset.hdr);
      throw err;
    });
    this._pending.set(preset.hdr, job);
    return job;
  }

  /**
   * Apply a preset. Returns a promise that resolves once the HDRI is on screen;
   * callers that need the previous look to stay put until then can await it.
   */
  async set(id) {
    const preset = SKY_PRESETS.find((p) => p.id === id) || SKY_PRESETS[0];
    const token = ++this._token;
    this.preset = preset;

    // Lighting changes are instant, so the switch feels immediate even if the
    // HDRI still has to decode.
    this.sun.color.set(preset.sunColor);
    this.sun.intensity = preset.sunIntensity;
    this.sun.position.set(...preset.sunPos).normalize().multiplyScalar(120);
    this.hemi.color.set(preset.hemiSky);
    this.hemi.groundColor.set(preset.hemiGround);
    this.hemi.intensity = preset.hemiIntensity;
    this.ambient.intensity = preset.ambient;
    if (this.renderer) this.renderer.toneMappingExposure = preset.exposure;

    let entry = this._textures.get(preset.hdr);
    if (!entry) {
      try {
        entry = await this._load(preset);
      } catch (err) {
        console.warn('sky HDRI failed', preset.hdr, err);
        return preset;
      }
    }
    // A later set() won the race; do not clobber it with this stale load.
    if (token !== this._token) return this.preset;
    this._apply(entry, preset);
    return preset;
  }

  _apply(entry, preset) {
    const bg = entry.texture.clone();
    bg.mapping = THREE.EquirectangularReflectionMapping;
    bg.colorSpace = THREE.LinearSRGBColorSpace;
    bg.center.set(0.5, 0.5);
    bg.rotation = preset.rotation || 0;
    bg.needsUpdate = true;
    this.scene.background = bg;
    this.scene.backgroundBlurriness = preset.backgroundBlur || 0;
    this.scene.backgroundIntensity = preset.bgIntensity ?? 1;
    this.scene.environment = entry.envMap;
    this.scene.environmentIntensity = preset.envIntensity;
    this._applied = bg;
  }

  get cityEmissive() { return this.preset.cityEmissive; }
  get cityColor() { return this.preset.cityColor; }

  /** The studio view is a sealed set: no sky, no outdoor light. */
  setVisible(on) {
    if (!on) {
      this.scene.background = null;
      this._hidden = this.scene.environment;
      this.scene.environment = null;
    } else if (this._applied) {
      this.scene.background = this._applied;
      this.scene.environment = this._applied && this._textures.get(this.preset.hdr)?.envMap;
      this.scene.environmentIntensity = this.preset.envIntensity;
    }
    this.sun.visible = on;
    this.hemi.visible = on;
    this.ambient.visible = on;
  }
}
