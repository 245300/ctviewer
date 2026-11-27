import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PaintController } from './paint.js';
import { CONFIG } from './config.js';
import { CARS } from './catalog.js';
import { classifyPart } from './parts.js';
import { SkyController, SKY_PRESETS } from './sky.js';
import { CityController } from './city.js';
import { CharacterMode } from './characters.js';
import { DrivingMode } from './drive.js';
import { PhotoMode } from './photo.js';

const CATEGORY_BASE = {
  '外饰':    { radial: 0.85, y: 0.22 },
  '玻璃':    { radial: 0.55, y: 1.10 },
  '灯光':    { radial: 1.05, y: 0.10 },
  '空气动力学': { radial: 1.10, y: 0.40 },
  '车轮':    { radial: 1.55, y: 0.02 },
  '内饰':    { radial: 0.50, y: 0.85 },
  '底盘':    { radial: 0.55, y: -0.72 },
};

// The garage gets a real steel deck laid over its studio floor: 60 mm of
// diamond plate (ambientCG, CC0) with a visible edge and a cool tint. It stands
// proud of y = 0, so the car, the props and the bay markings all ride up with
// it - the tyres sit on the plate, never inside it.
const GARAGE_FLOOR_TOP = 0.06;
const GARAGE_FLOOR_URL = 'assets/scenes/garage';

function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

async function fetchWithProgress(url, onProgress, label) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${url}`);
  const total = Number(res.headers.get('Content-Length') || 0);
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress?.(1, buf.byteLength, total, label);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(total ? received / total : 0, received, total, label);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out.buffer;
}

async function fetchArrayBufferCached(path, onProgress, label) {
  const urls = [];
  if (CONFIG.preferCDN && CONFIG.cdnBase) {
    urls.push(CONFIG.cdnBase.replace(/\/?$/, '/') + path);
  }
  urls.push(path);
  let lastErr;
  for (const url of urls) {
    try {
      // Try the browser cache first (also populated by the service worker).
      try {
        const cache = await caches.open(CONFIG.cacheName);
        const hit = await cache.match(url);
        if (hit) {
          const buf = await hit.arrayBuffer();
          onProgress?.(1, buf.byteLength, buf.byteLength, label, true);
          return buf;
        }
      } catch (_) { /* CacheStorage unavailable: continue */ }

      const buf = await fetchWithProgress(url, onProgress, label);
      try {
        const cache = await caches.open(CONFIG.cacheName);
        await cache.put(url, new Response(buf.slice(0), {
          headers: {
            'Content-Type': 'model/gltf-binary',
            'Content-Length': String(buf.byteLength),
          },
        }));
      } catch (_) { /* non-fatal */ }
      return buf;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('无法加载模型资源');
}

export class CTViewer {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.cb = callbacks;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.modelRoot = null;
    this.lodRoot = null;
    this.meshes = [];
    this.meshById = new Map();
    this.parts = [];
    this.manifest = null;
    this.currentCar = null;
    this.loadToken = 0;
    this._modelBox = new THREE.Box3();
    this.paint = null;
    this.shells = new Map();
    this.hovered = null;
    this.selected = null;
    this.isolated = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(10, 10);
    this.pointerClient = { x: 0, y: 0 };
    this.pointerDirty = false;
    this.pointerInside = false;
    this.explodeTarget = 0;
    this.explodeCurrent = 0;
    this.explodeSpeed = 3.6;
    this.explodeOffsets = new Map();
    this.cameraTween = null;
    this.autoRotate = false;
    this.clock = new THREE.Clock();
    this.fpsSamples = [];
    this.lastStatsAt = 0;
    this.ready = false;
    this.isCoarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches || window.innerWidth < 900;
    this.qualityReduced = false;
    // Frame-rate decisions wait until this timestamp: the first seconds after
    // a tab becomes visible again are not a steady state.
    this._resumeGraceUntil = 0;
    this._qualityAutoFrom = null;
    this._qualityRestored = false;
    this._lowFpsTicks = 0;
    // Dynamic resolution: a multiplier on the tier's base pixel ratio, driven
    // by the measured frame rate (0.55-1.0). Fill rate, not triangle count, is
    // what limits the integrated GPUs this runs on.
    this.renderScale = 1;
    this._basePixelRatio = 1;
    this.loadStart = performance.now();
    this.stats = {
      parts: 0,
      triangles: 0,
      compressedBytes: 0,
      sourceBytes: 0,
      loadMs: 0,
      fps: 0,
      drawCalls: 0,
    };
    this._boundAnimate = this._animate.bind(this);
    this._onResize = this._resize.bind(this);
  }

  async init() {
    this._initRenderer();
    this._initScene();
    this._initLights();
    this._initControls();
    this._bindEvents();
    this._resize();
    this._renderLoop();

    const initial = CARS.find((car) => car.id === CONFIG.initialCar) || CARS[0];
    await this.loadCar(initial.id, { first: true });
  }

  /**
   * Switch the active car.  The old model is disposed before the new one is
   * loaded so mobile WebView memory stays bounded.  A monotonically increasing
   * token ignores stale async loads when the user taps several cars quickly.
   *
   * Two things used to make a 300 ms load feel like a multi-second freeze:
   *
   * 1. Shaders were compiled lazily on the first frame that drew the new car,
   *    inside one ~500 ms blocking task (measured: 19 → 29 programs in a single
   *    longtask right after loadCar resolved). `_warmShaders()` now compiles
   *    them off the critical path, using KHR_parallel_shader_compile when the
   *    driver offers it.
   * 2. Textures of the outgoing car survived the swap because the paint
   *    controller replaced each mesh's material and the original was never
   *    disposed. `_disposeGroup` now also collects maps from the material the
   *    paint controller stashed away.
   */
  async loadCar(carId, { first = false } = {}) {
    const car = CARS.find((item) => item.id === carId);
    if (!car) throw new Error(`未知车型: ${carId}`);
    // Re-selecting the car already on screen is a no-op, not a reload.
    if (car.id === this.currentCar?.id && this.ready) return;

    const token = ++this.loadToken;
    this.loadStart = performance.now();
    this.ready = false;
    this._disposeCurrentModel();
    this.currentCar = car;
    this.cb.onCarChange?.(car);

    this.stats.parts = car.partCount;
    this.stats.triangles = car.triangles;
    this.stats.sourceBytes = car.sourceBytes;
    this.stats.compressedBytes = car.compressedBytes;
    this.cb.onManifest?.({
      id: car.id,
      car,
      partCount: car.partCount,
      parts: [],
      sourceBytes: car.sourceBytes,
      compressedBytes: car.compressedBytes,
      triangles: car.triangles,
    });

    this._reportStage(`正在读取 ${car.zhName} · 零件清单`, 0.03);
    const lodPromise = this._loadGLB(car.lodUrl, 'lod', (p) => {
      this._reportStage('正在加载轻量预览', 0.08 + p * 0.16);
    }).catch((err) => {
      console.warn('LOD preview unavailable:', err);
      return null;
    });

    let fullPromise = null;
    if (!CONFIG.lodOnly) {
      fullPromise = this._loadGLB(car.modelUrl, 'full', (p) => {
        this._reportStage('正在流式解码 Draco 模型', 0.26 + p * 0.68);
      });
    }

    const lod = await lodPromise;
    if (token !== this.loadToken) return;

    if (lod) {
      this.lodRoot = this._buildPreview(lod.gltf.scene, car);
      this.scene.add(this.lodRoot);
      this._reportStage('预览已就绪 · 继续加载完整细节', 0.25, { preview: true });
    }

    if (CONFIG.lodOnly && lod) {
      if (this.lodRoot) {
        this.scene.remove(this.lodRoot);
        this._disposeGroup(this.lodRoot);
        this.lodRoot = null;
      }
      this._reportStage('正在构建车漆与菲涅尔壳层', 0.96);
      this._prepareModel(lod.gltf.scene, lod.bytes, car);
      this._finishLoad(car);
      return;
    }

    const full = await fullPromise;
    if (token !== this.loadToken) return;
    this._reportStage('正在构建车漆与菲涅尔壳层', 0.98);
    this._prepareModel(full.gltf.scene, full.bytes, car);

    if (this.lodRoot) {
      this.scene.remove(this.lodRoot);
      this._disposeGroup(this.lodRoot);
      this.lodRoot = null;
    }
    this._finishLoad(car);
  }

  _finishLoad(car) {
    this.stats.loadMs = performance.now() - this.loadStart;
    this.ready = true;
    this.explodeTarget = 0;
    this.explodeCurrent = 0;
    this.fitView({ animate: true, duration: 900, padding: 1.75 });
    this._reportStage('完成', 1);
    this.cb.onReady?.(this.getStats());
    // Compile the new car's shaders while the camera is still flying in, so the
    // first frame that shows it does not also compile them (a ~500 ms hitch).
    this._warmShaders();
    this._prefetchNeighbours(car);
  }

  /**
   * Pull the next / previous car's full GLB into the HTTP + Cache Storage layer
   * while the user is still looking at this one. Switching then only pays for
   * Draco decode instead of decode plus a 2-8 MB download, which is what made
   * arrow-key browsing feel slow on a cold cache.
   *
   * Deliberately idle-only: it never competes with the visible car for
   * bandwidth, and a failed prefetch is silent (the real load will report).
   */
  _prefetchNeighbours(car) {
    if (CONFIG.lite || typeof requestIdleCallback !== 'function') return;
    const index = CARS.findIndex((c) => c.id === car.id);
    if (index < 0) return;
    const targets = [CARS[index + 1], CARS[index - 1]].filter(Boolean);
    this._prefetchTimer && clearTimeout(this._prefetchTimer);
    this._prefetchTimer = setTimeout(() => {
      requestIdleCallback((deadline) => {
        for (const next of targets) {
          if (next.id === this.currentCar?.id) continue;
          if (this._prefetched?.has(next.id)) continue;
          (this._prefetched ||= new Set()).add(next.id);
          // Same cache path loadCar uses, so the hit is shared.
          fetchArrayBufferCached(next.modelUrl, null, 'prefetch')
            .catch(() => this._prefetched.delete(next.id));
          // The LOD is what paints the first frame; it is small, fetch it too.
          fetchArrayBufferCached(next.lodUrl, null, 'prefetch').catch(() => {});
          if (deadline.timeRemaining() <= 0) break;
        }
      }, { timeout: 4000 });
    }, 1200);
  }

  /**
   * Compile every program the current model needs before it is first drawn.
   * three's renderer.compile() blocks; compileAsync() spreads the work over
   * frames when the driver supports KHR_parallel_shader_compile, and falls back
   * to the blocking path otherwise. Either way the cost lands during the
   * load-in tween instead of on the first interaction after it.
   */
  _warmShaders() {
    const renderer = this.renderer;
    if (!renderer || !this.modelRoot) return;
    const target = this.modelRoot;
    // three's compileAsync() keeps polling material properties on a 10 ms
    // timer; disposing that material in the meantime dereferences a freed
    // program (`program.isReady` on undefined).  Mark the root so a car swap
    // defers its disposal until the compile promise settles.
    target.userData.compilePending = true;
    this._compileToken = (this._compileToken || 0) + 1;
    const token = this._compileToken;
    const run = typeof renderer.compileAsync === 'function'
      ? renderer.compileAsync(target, this.camera, this.scene)
      : Promise.resolve(renderer.compile(target, this.camera, this.scene));
    Promise.resolve(run).catch(() => {
      // A driver without parallel compile support still gets a blocking
      // compile; a failure here only means the hitch moves back to draw time.
      try { renderer.compile(target, this.camera, this.scene); } catch (_) { /* ignore */ }
    }).finally(() => {
      target.userData.compilePending = false;
      this._flushDeferredDisposal();
      if (token !== this._compileToken) return;
      this._warmDone = true;
    });
  }

  /** Dispose of cars that were swapped out while their shaders were compiling. */
  _flushDeferredDisposal() {
    if (!this._deferredDispose?.length) return;
    this._deferredDispose = this._deferredDispose.filter((root) => {
      if (root.userData.compilePending) return true;
      this._disposeGroup(root);
      return false;
    });
  }

  _disposeCurrentModel() {
    this.clearIsolation();
    this._setHovered(null);
    this.cb.onSelect?.(null);
    this.cb.onSelectionChange?.(null);
    this.selected = null;
    this.paint = null;

    if (this.modelRoot) {
      this.modelGroup.remove(this.modelRoot);
      if (this.modelRoot.userData.compilePending) {
        (this._deferredDispose ||= []).push(this.modelRoot);
      } else {
        this._disposeGroup(this.modelRoot);
      }
      this.modelRoot = null;
    }
    if (this.lodRoot) {
      this.scene.remove(this.lodRoot);
      this._disposeGroup(this.lodRoot);
      this.lodRoot = null;
    }
    this.meshes = [];
    this.meshById.clear();
    this.shells.clear();
    this.explodeOffsets.clear();
    this.parts = [];
    this.manifest = null;
    this._modelBox.makeEmpty();
  }

  async _loadGLB(path, kind, onProgress) {
    const buffer = await fetchArrayBufferCached(path, (p, received, total) => {
      onProgress?.(p, received, total);
    }, kind);
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(CONFIG.decoderPath);
    draco.setDecoderConfig({ type: CONFIG.lite ? 'js' : 'wasm' });
    draco.preload();
    loader.setDRACOLoader(draco);
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(buffer, '', resolve, (err) => reject(err));
    });
    draco.dispose();
    return { gltf, bytes: buffer.byteLength };
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !CONFIG.lite,
      alpha: true,
      powerPreference: 'high-performance',
    });
    // Quality: low keeps DPR 1 and no shadows (software / weak GPUs), medium
    // caps DPR at 1.25, high uses the full pixel budget.
    const quality = CONFIG.quality || 'high';
    this.quality = quality;
    const device = window.devicePixelRatio || 1;
    this._basePixelRatio = quality === 'low' ? 1
      : quality === 'medium' ? Math.min(device, 1.25)
        : Math.min(device, this.isCoarsePointer ? 1.5 : CONFIG.maxPixelRatio);
    if (CONFIG.dpr) this._basePixelRatio = CONFIG.dpr;
    this.renderer.setPixelRatio(this._basePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.shadowMap.enabled = quality !== 'low' && !CONFIG.lite && !this.isCoarsePointer;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The garage clips its wall tops away when the top preset looks down from
    // above the roof; that needs local clipping to be allowed at all.
    this.renderer.localClippingEnabled = true;
    this.renderer.info.autoReset = true;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = null;
    // The seamless studio keeps the procedural PMREM rig; the garage swaps in a
    // real HDRI environment once the sky controller has decoded one.
    if (CONFIG.lite) {
      this.scene.environment = this._createLiteEnvironment();
      this.scene.environmentIntensity = 1.8;
    } else {
      this.scene.environment = this._createStudioEnvironment();
      this.scene.environmentIntensity = 1.55;
    }

    // Far plane has to reach past the sky dome and the outer city ring, or both
    // are simply clipped away and the garage reads as a black box.
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 2400);
    this.camera.position.set(6.2, 2.7, 7.6);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(10, 128),
      new THREE.MeshStandardMaterial({
        color: 0x0c141e, roughness: 0.86, metalness: 0.18,
        transparent: true, opacity: 0.86,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.004;
    ground.receiveShadow = true;
    this.ground = ground;
    this.scene.add(ground);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(7.4, 96),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.52 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.001;
    shadow.receiveShadow = true;
    this.shadowDisc = shadow;
    this.scene.add(shadow);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(4.8, 4.82, 128),
      new THREE.MeshBasicMaterial({ color: 0x3a6f8f, transparent: true, opacity: 0.12, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    this.ring = ring;
    this.scene.add(ring);

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    // Background scene: a finished pit garage shipped with the app. It is
    // loaded after the first frame so it never delays the car itself.
    this.garage = null;
    this.garageStyle = CONFIG.sceneStyle;
    this.quality = CONFIG.quality;
    this._ringsOn = true;

    // Outside the garage: the Unity racing project's own sky HDRIs and its
    // Classical_city block. Both are loaded lazily - the car must never wait
    // for the scenery.
    this.sky = new SkyController(this.scene, this.renderer);
    this.city = new CityController(this.scene);
    // Third-person city exploration: created on first use and kept for the
    // session so a re-entry does not re-download a character.
    this.characterMode = null;
    this.exploreActive = false;
    // P2 gameplay modes. Both are created on first use; the flags are what
    // the main loop branches on.
    this.drivingMode = null;
    this.driveActive = false;
    this.photoMode = null;
    this.photoActive = false;
    // Two-post lift: height in metres (0 = down). The car rides on it while
    // the garage is on screen and drive mode is idle.
    this.liftHeight = 0;
    this._liftTarget = 0;
    this.garageLift = null;
    this._garageFog = new THREE.Fog(0xb9cde2, 180, 1500);
    if (this.garageStyle === 'garage') this.scene.fog = this._garageFog;
    if (this.garageStyle === 'garage') {
      this._loadGarage().catch((err) => console.warn('garage scene', err));
      this._loadOutdoors().catch((err) => console.warn('outdoor scene', err));
    }
  }

  /**
   * Decode the sky HDRI and the city block. Both run in the background after the
   * first car is on screen; the garage interior looks complete without them.
   */
  async _loadOutdoors() {
    // Starting in the studio skips this entirely (the studio is a sealed set),
    // so a later switch to the garage calls it again.  Guard against a second
    // concurrent load, and let a failed one retry on the next switch.
    if (this._outdoorsStarted) return;
    this._outdoorsStarted = true;
    const [sky, city] = await Promise.allSettled([
      this.setSkyTime(CONFIG.skyTime || 'day'),
      this._loadCity(),
    ]);
    if (sky.status === 'rejected') console.warn('sky', sky.reason);
    if (city.status === 'rejected') console.warn('city', city.reason);
    if (sky.status === 'rejected' || city.status === 'rejected') this._outdoorsStarted = false;
  }

  async _loadCity() {
    // Baked from the Unity FBX by tools/fbx2glb.html + scripts/city_glb.mjs:
    // ten merged meshes, meshopt-compressed, night window lights in emissive.
    await this.city.load(`assets/scenes/city/city.glb?v=${CONFIG.version}`);
    if (this.skyPreset) this.city.applySky(this.skyPreset);
    if (this.garageStyle !== 'garage') this.city.setVisible(false);
  }

  /**
   * Time of day. Only the outdoor world changes - the garage interior keeps
   * its own lighting so the car stays readable at every hour.
   */
  async setSkyTime(id) {
    const preset = await this.sky.set(id);
    this.skyPreset = preset;
    // The sky owns scene.environment; while the party lights are on, the neon
    // probe has to go back on top of whatever the new hour just installed.
    if (this._partyOn) this._applyPartyEnv();
    // A new hour rewrites the sun/hemi/ambient intensities; the show dims them
    // again while it is running.
    this._mixSkyLights();
    this.city?.applySky(preset);
    // The room's haze doubles as window atmosphere: it starts beyond the far
    // wall and fades into the horizon so the skyline reads as depth, not black.
    if (this._garageFog) {
      this._garageFog.color.set(preset.fog);
      this._garageFog.near = preset.fogNear;
      this._garageFog.far = preset.fogFar;
    }
    return preset;
  }

  /** Load and place the built-in garage backdrop (assets/scenes/garage.glb). */
  async _loadGarage() {
    // Version query keeps a stale Cache Storage entry from outliving an asset update.
    const { gltf } = await this._loadGLB(`assets/scenes/garage.glb?v=${CONFIG.version}`, 'garage');
    const root = gltf.scene;
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    // Big enough that every view preset's camera stays inside the room.
    const scale = 24 / Math.max(size.x, size.z, 1e-6);
    root.scale.setScalar(scale);
    root.rotation.y = THREE.MathUtils.degToRad(CONFIG.garageRotation || 0);
    root.updateMatrixWorld(true);
    const placed = new THREE.Box3().setFromObject(root);
    root.position.set(
      -(placed.min.x + placed.max.x) / 2,
      -placed.min.y,
      -(placed.min.z + placed.max.z) / 2,
    );
    // The model's bounding box reaches below its floor slab - a base plinth.
    // This offset is only a first guess; _tuneGarage() measures the real
    // walking surface and drops the room so it sits exactly on y = 0.
    root.position.y = -placed.min.y - (CONFIG.garageFloorOffset || 0) * scale;
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = true;
      obj.frustumCulled = true;
    });
    this.garage = root;
    this.scene.add(root);
    if (this.ground) this.ground.visible = false;
    if (this.ring) this.ring.visible = false;
    this._tuneGarage();
    this._addGarageLights();
    this._addGarageProps();
    this._addGarageStage();
    this._addGarageFloor();
    this._addGarageLift();
    // The workshop furniture is a set of CC0 models; they stream in after the
    // room is already on screen so the car never waits for a shelf.
    this._loadGaragePropModels().catch((err) => console.warn('garage props', err));
    this._loadPartyRig().catch((err) => console.warn('party rig', err));
  }

  /**
   * The garage ships with bright albedo textures and fully emissive wall
   * panels; both are replaced with controlled materials so the room reads as a
   * dark pit garage and the car stays the brightest object on screen.
   *
   * The model also keeps its walking surface above its bounding box (a base
   * plinth) and carries a full-size lightbox floor. Both are measured here: the
   * lightbox is hidden and the whole room is dropped so the surface lands on
   * y = 0 - exactly where the car's wheels already are.
   */
  _tuneGarage() {
    if (!this.garage) return;
    const room = new THREE.Box3().setFromObject(this.garage);
    const roomSize = room.getSize(new THREE.Vector3());
    const ceiling = [];
    const service = [];
    const clipMats = [];
    const innerBox = new THREE.Box3();
    let floorY = null;

    this.garage.traverse((obj) => {
      if (!obj.isMesh) return;
      const old = obj.material;
      if (!old || Array.isArray(old)) return;
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());

      // The model's own floor is a full-size lightbox plane; the dark stage in
      // _addGarageStage() replaces it. Detect it as a thin, room-wide slab near
      // the base rather than hard-coding a mesh name.
      const isLightboxFloor = size.y < roomSize.y * 0.06
        && box.min.y < roomSize.y * 0.15
        && size.x > roomSize.x * 0.4;
      if (isLightboxFloor) {
        floorY = floorY === null ? box.max.y : Math.max(floorY, box.max.y);
        obj.visible = false;
        return;
      }
      // Anything living in the top fifth of the room is roof. The top preset
      // looks straight down, so it is hidden while the camera is above it.
      if (box.min.y > room.min.y + roomSize.y * 0.72 && size.x > roomSize.x * 0.35) {
        ceiling.push(obj);
      }
      // The model parks its wheel-service bench against the left wall on the
      // car's centre line; the rear preset backs the camera into it.
      if (box.max.x < -4.0 && box.min.y < 1.5 && box.max.z < 1.5 && box.min.z > -1.5) {
        service.push(obj);
      }

      const panel = old.emissive
        && (old.emissive.r + old.emissive.g + old.emissive.b) > 0.2;
      // The room ships as two nested shells: an outer structural skin and an
      // inner back-lit panel wall. Both block the city, so the outer skin is
      // dropped (the inner wall, mullions and roof still give the room its
      // shape) and the panel wall becomes glass.
      const coversRoom = size.x > roomSize.x * 0.92 && size.z > roomSize.z * 0.92
        && size.y > roomSize.y * 0.85;
      if (coversRoom && !panel) {
        obj.visible = false;
        return;
      }
      // The model's walls are floor-to-ceiling back-lit lightboxes. They are
      // the only thing between the camera and the city outside, so they become
      // a real glass curtain wall: a tinted, reflective sheet the skyline reads
      // through, with the model's own mullions kept as solid structure.
      //
      // It used to be 12 % opacity and nothing else, which read as an open
      // frame rather than a window. Real architectural glass is *seen* - it has
      // a tint, it catches the room's lights along the panes, and it has enough
      // body that the skyline behind it sits outdoors. The city stays fully
      // legible; what changes is that the pane is between you and it.
      const isWall = panel && size.y > roomSize.y * 0.5;
      if (isWall) {
        const glass = new THREE.MeshPhysicalMaterial({
          color: 0x2e4152,
          roughness: 0.08,
          metalness: 0.0,
          transparent: true,
          opacity: 0.44,
          transmission: 0,
          ior: 1.52,
          reflectivity: 0.55,
          clearcoat: 1.0,
          clearcoatRoughness: 0.05,
          specularIntensity: 1.0,
          envMapIntensity: 2.4,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        glass.name = 'GarageGlass';
        obj.material = glass;
        obj.renderOrder = 2;
        clipMats.push(glass);
        this._garageGlass = this._garageGlass || [];
        this._garageGlass.push(glass);
        this._garageGlassMeshes = this._garageGlassMeshes || [];
        this._garageGlassMeshes.push(obj);
        innerBox.union(box);
        old.dispose?.();
        return;
      }
      const mat = new THREE.MeshStandardMaterial({
        color: panel ? 0x05070c : (old.map ? 0x39424e : 0x1a212b),
        roughness: panel ? 0.92 : 0.6,
        metalness: panel ? 0 : 0.2,
        envMapIntensity: panel ? 0 : 0.3,
      });
      if (panel) {
        // Back-lit ceiling panels: cool lightbox, dimmed to a glow.
        mat.emissive = new THREE.Color(0x6b90c4);
        mat.emissiveIntensity = 0.38;
        innerBox.union(box);
      } else if (old.map) {
        mat.map = old.map;
      }
      mat.needsUpdate = true;
      obj.material = mat;
      clipMats.push(mat);
      old.dispose?.();
    });

    if (service.length) {
      // A world-space slide: the nodes are direct children of the room root,
      // which only carries a uniform scale.
      const dz = 5.2 / (this.garage.scale.x || 1);
      for (const obj of service) obj.position.z += dz;
    }
    if (floorY !== null) {
      this.garage.position.y -= floorY;
      this.garage.updateMatrixWorld(true);
    }
    this._garageRoom = new THREE.Box3().setFromObject(this.garage);
    this._garageInnerBox = innerBox.isEmpty() ? null : innerBox;
    this._garageCeiling = ceiling;
    this._garageCeilY = this._garageRoom.max.y
      - (this._garageRoom.max.y - this._garageRoom.min.y) * 0.22;
    this._garageClipMats = clipMats;
    // Above the ceiling the room shell still blocks the top preset (it is one
    // mesh, roof included), so the wall tops are clipped away instead of the
    // shell being hidden outright. three's clip shader discards fragments where
    // dot(normal, position) > constant, so the normal must point *up* to drop
    // everything above the ceiling. The old (0, -1, 0) / -hi pair inverted the
    // test and discarded the whole room instead - which is why the glass and
    // its mullions vanished the moment an orbit pulled the camera over the
    // roof line.
    this._garageClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), this._garageCeilY);
    this._ceilingHidden = false;
    this._frameGarageGlass();
  }

  /**
   * The glazed walls arrived as a grid of panes with real 0.5 m gaps between
   * them - and nothing in the gaps. From inside, that reads as glass floating
   * in mid-air: the skyline shows through the joints as bright strips. This
   * measures the pane grid out of the geometry itself (the coordinates are all
   * it has) and puts an anodised mullion in every gap, so the wall becomes a
   * curtain wall: pane, post, pane, rail.
   */
  _frameGarageGlass() {
    const meshes = this._garageGlassMeshes || [];
    if (!meshes.length || this.garageGlassFrame) return;
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x222a33, metalness: 0.82, roughness: 0.34, envMapIntensity: 0.7,
    });
    frameMat.name = 'GarageGlassFrame';
    const group = new THREE.Group();
    group.name = 'GarageGlassFrame';
    const v = new THREE.Vector3();
    const bars = [];

    for (const mesh of meshes) {
      const pos = mesh.geometry.attributes.position;
      // Coordinates are all the pane grid leaves behind: bucket every vertex by
      // the plane it sits on. A plane is a wall when its perpendicular spread
      // is several metres (a pane grid) and the other axes barely move.
      const byX = new Map();
      const byZ = new Map();
      const pts = [];
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        const p = [v.x, v.y, v.z];
        pts.push(p);
        const kx = p[0].toFixed(2);
        const kz = p[2].toFixed(2);
        if (!byX.has(kx)) byX.set(kx, []);
        if (!byZ.has(kz)) byZ.set(kz, []);
        byX.get(kx).push(p);
        byZ.get(kz).push(p);
      }
      const spread = (list, axis) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of list) { lo = Math.min(lo, p[axis]); hi = Math.max(hi, p[axis]); }
        return hi - lo;
      };
      // West/east walls are planes of constant x; north/south of constant z.
      const walls = [];
      for (const [k, list] of byX) {
        if (list.length >= 8 && spread(list, 2) > 2) walls.push({ axis: 'x', at: Number(k), list });
      }
      for (const [k, list] of byZ) {
        if (list.length >= 8 && spread(list, 0) > 2) walls.push({ axis: 'z', at: Number(k), list });
      }

      for (const wall of walls) {
        const horiz = wall.axis === 'x' ? 2 : 0;
        const ys = [...new Set(wall.list.map((p) => +p[1].toFixed(2)))].sort((a, b) => a - b);
        const hs = [...new Set(wall.list.map((p) => +p[horiz].toFixed(2)))].sort((a, b) => a - b);
        // Sorted pane edges alternate pane / joint, starting and ending on panes.
        const gapsOf = (vals) => {
          const out = [];
          for (let i = 0; i < vals.length - 1; i += 2) {
            const gap = vals[i + 1] !== undefined && i + 2 < vals.length
              ? [vals[i + 1], vals[i + 2]] : null;
            if (gap && gap[1] - gap[0] < 0.9) out.push(gap);
          }
          return out;
        };
        const yLo = ys[0] ?? 0;
        const yHi = ys[ys.length - 1] ?? 3;
        const hLo = hs[0] ?? 0;
        const hHi = hs[hs.length - 1] ?? 6;
        // Vertical posts in the joints.
        for (const [a, b] of gapsOf(hs)) {
          const w = Math.max(0.06, b - a);
          const geo = wall.axis === 'x'
            ? new THREE.BoxGeometry(0.14, yHi - yLo + 0.1, w)
            : new THREE.BoxGeometry(w, yHi - yLo + 0.1, 0.14);
          const bar = new THREE.Mesh(geo, frameMat);
          const mid = (a + b) / 2;
          bar.position.set(
            wall.axis === 'x' ? wall.at : mid,
            (yLo + yHi) / 2,
            wall.axis === 'x' ? mid : wall.at,
          );
          group.add(bar);
          bars.push(bar);
        }
        // Horizontal rails in the horizontal joints.
        for (const [a, b] of gapsOf(ys)) {
          const h = Math.max(0.06, b - a);
          const geo = wall.axis === 'x'
            ? new THREE.BoxGeometry(0.14, h, hHi - hLo + 0.1)
            : new THREE.BoxGeometry(hHi - hLo + 0.1, h, 0.14);
          const bar = new THREE.Mesh(geo, frameMat);
          const mid = (a + b) / 2;
          bar.position.set(
            wall.axis === 'x' ? wall.at : (hLo + hHi) / 2,
            mid,
            wall.axis === 'x' ? (hLo + hHi) / 2 : wall.at,
          );
          group.add(bar);
          bars.push(bar);
        }
      }
    }

    if (!bars.length) return;
    // 20 individual boxes become one draw call; the frame never moves.
    group.updateMatrixWorld(true);
    const geos = bars.map((bar) => {
      const geo = bar.geometry.clone();
      geo.applyMatrix4(bar.matrix);
      return geo;
    });
    const merged = mergeGeometries(geos, false);
    geos.forEach((geo) => geo.dispose());
    if (merged) {
      for (const bar of bars) group.remove(bar);
      const rail = new THREE.Mesh(merged, frameMat);
      rail.name = 'GarageGlassFrameBatch';
      group.add(rail);
    }
    this.garageGlassFrame = group;
    this.scene.add(group);
    // The roof hides above the ceiling line, frames included.
    if (this._garageClipMats) this._garageClipMats.push(frameMat);
  }

  /**
   * One dark, lightly reflective floor for the whole room, with painted bay
   * markings around the car. It replaces the model's lightbox floor and sits
   * just under y = 0 so the tyres touch the floor instead of sinking into it.
   */
  _addGarageStage() {
    if (this.garageStage) return;
    const room = this._garageRoom || new THREE.Box3().setFromObject(this.garage);
    const size = room.getSize(new THREE.Vector3());
    const cx = (room.min.x + room.max.x) / 2;
    const cz = (room.min.z + room.max.z) / 2;

    const map = this._makeFloorTexture();
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(Math.max(3, Math.round(size.x / 4)), Math.max(3, Math.round(size.z / 4)));
    // Lambert, not Standard: the studio key/fill rig is very strong (it is
    // tuned for car paint), and a rough PBR floor turns that into a mirror-like
    // sheen at grazing angles that reads as a blown-out white floor. Lambert
    // keeps the floor matte; the light pool below supplies the falloff.
    const stage = new THREE.Mesh(
      new THREE.PlaneGeometry(size.x * 0.995, size.z * 0.995),
      new THREE.MeshLambertMaterial({ map, color: 0xffffff }),
    );
    stage.rotation.x = -Math.PI / 2;
    stage.position.set(cx, -0.008, cz);
    stage.receiveShadow = true;
    stage.renderOrder = 0;
    stage.name = 'GarageStage';
    this.garageStage = stage;
    this.scene.add(stage);

    // Fake bounce: a soft pool of light under the car so the room has a centre
    // and the floor does not read as one flat slab. It lives on top of the
    // steel deck (_addGarageFloor), not on the studio floor underneath it.
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.MeshBasicMaterial({
        map: this._makeLightPoolTexture(),
        transparent: true,
        // The steel deck is far more reflective than the old concrete, so the
        // pool that used to give it a centre now washes it out.
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, GARAGE_FLOOR_TOP + 0.002, 0);
    pool.renderOrder = 1;
    pool.name = 'GaragePool';
    this.garagePool = pool;
    this.scene.add(pool);

    const marks = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshBasicMaterial({
        map: this._makeBayMarksTexture(),
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    // Floor stack, bottom to top: studio concrete (-8 mm) -> steel deck (0 to
    // 60 mm) -> light pool -> bay markings -> contact shadow. The car's tyres
    // sit on the deck at y = GARAGE_FLOOR_TOP, so every decal must stay *below*
    // that line by a hair, or it z-fights and reads as the tyre sinking in.
    marks.rotation.x = -Math.PI / 2;
    marks.position.set(0, GARAGE_FLOOR_TOP + 0.004, 0);
    marks.renderOrder = 2;
    marks.name = 'GarageBay';
    this.garageMarks = marks;
    this.scene.add(marks);

    if (this.shadowDisc) {
      this.shadowDisc.position.y = GARAGE_FLOOR_TOP + 0.006;
      this.shadowDisc.renderOrder = 3;
    }
  }

  /**
   * The layer the user asked for: a real steel deck laid over the studio floor.
   *
   * Four maps come from ambientCG's `DiamondPlate008D` (CC0): colour, normal,
   * roughness and metalness. One sheet covers ~1.7 m, so a 19 x 23 m room gets
   * a 11 x 14 tile repeat of actual check-plate detail instead of a flat paint
   * colour. The deck is a 60 mm box with a dark edge, which is what makes it
   * read as a *layer* rather than a decal - and everything that used to stand
   * on y = 0 (car, props, bay markings, contact shadow) is lifted onto it.
   */
  _addGarageFloor() {
    if (this.garageDeck) return;
    const room = this._garageRoom || new THREE.Box3().setFromObject(this.garage);
    const size = room.getSize(new THREE.Vector3());
    const cx = (room.min.x + room.max.x) / 2;
    const cz = (room.min.z + room.max.z) / 2;
    const w = Math.max(2, size.x - 0.5);
    const d = Math.max(2, size.z - 0.5);
    const h = GARAGE_FLOOR_TOP;
    const repX = w / 1.7;
    const repZ = d / 1.7;

    const plate = new THREE.MeshStandardMaterial({
      // The map is mid-grey plate; a dark cool tint keeps the deck under the
      // car's brightness instead of out-glossing it.
      color: 0x3d454f,
      metalness: 1.0,
      roughness: 1.0,
      envMapIntensity: 0.5,
    });
    plate.name = 'GarageDeckPlate';
    const edge = new THREE.MeshStandardMaterial({
      color: 0x161c24, metalness: 0.9, roughness: 0.34, envMapIntensity: 0.55,
    });
    edge.name = 'GarageDeckEdge';

    const loader = new THREE.TextureLoader();
    const grab = (file, srgb) => {
      const tex = loader.load(`${GARAGE_FLOOR_URL}/${file}?v=${CONFIG.version}`);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repX, repZ);
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };
    plate.map = grab('plate_color.jpg', true);
    plate.normalMap = grab('plate_normal.jpg', false);
    plate.normalScale.set(0.85, 0.85);
    plate.roughnessMap = grab('plate_rough.jpg', false);
    plate.metalnessMap = grab('plate_metal.jpg', false);
    plate.needsUpdate = true;

    // Box material order is +x, -x, +y (the walking surface), -y, +z, -z.
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      [edge, edge, plate, edge, edge, edge],
    );
    deck.position.set(cx, h / 2, cz);
    deck.receiveShadow = true;
    deck.name = 'GarageDeck';
    this.garageDeck = deck;
    this.scene.add(deck);

    this._garageFloorTop = h;
    this._applyFloorLift();
  }

  /** Put the car and the props on top of the deck (or back on the studio floor). */
  /**
   * A two-post lift parked exactly under the display car.  The car already
   * stands on the bay's centre line, so the posts go either side of it and the
   * arms swing out of the way when the lift is down (otherwise they would sit
   * inside the tyres).  Raising the carriage lifts the car; `under` in the
   * view presets raises it and drops the camera to floor level.
   */
  _addGarageLift() {
    if (this.garageLift) return;
    const group = new THREE.Group();
    group.name = 'GarageTwoPostLift';
    const dark = new THREE.MeshStandardMaterial({
      color: 0x242a32, metalness: 0.72, roughness: 0.42, envMapIntensity: 0.7,
    });
    dark.name = 'LiftFrame';
    const yellow = new THREE.MeshStandardMaterial({
      color: 0xd9a41c, metalness: 0.5, roughness: 0.45, envMapIntensity: 0.8,
    });
    yellow.name = 'LiftSafety';
    const steel = new THREE.MeshStandardMaterial({
      color: 0x9aa3ad, metalness: 0.9, roughness: 0.28, envMapIntensity: 1.0,
    });
    steel.name = 'LiftArm';
    const addBox = (w, h, d, mat, x, y, z, parent = group) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };
    const carriages = [];
    const arms = [];
    for (const side of [-1, 1]) {
      addBox(0.62, 0.05, 0.62, dark, 0, 0.025, side * 2.05);
      addBox(0.30, 3.0, 0.28, dark, 0, 1.5, side * 2.05);
      addBox(0.34, 0.05, 0.32, yellow, 0, 2.97, side * 2.05);
      addBox(0.32, 0.07, 0.30, yellow, 0, 0.10, side * 2.05);
      const carriage = new THREE.Group();
      carriage.position.set(0, 0.02, side * 2.05);
      group.add(carriage);
      carriages.push(carriage);
      addBox(0.46, 0.26, 0.34, dark, 0, 0, 0, carriage);
      addBox(0.48, 0.03, 0.36, yellow, 0, 0.115, 0, carriage);
      for (const x of [-1.05, 1.05]) {
        const arm = new THREE.Group();
        arm.position.set(x, 0, 0);
        arm.userData.side = side;
        carriage.add(arm);
        arms.push(arm);
        addBox(0.10, 0.06, 1.02, steel, 0, 0.05, -side * 0.54, arm);
        addBox(0.22, 0.055, 0.20, dark, 0, 0.085, -side * 1.0, arm);
      }
    }
    group.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = true;
    });
    this.garageLift = group;
    this._liftCarriages = carriages;
    this._liftArms = arms;
    group.position.y = this._garageFloorTop || 0;
    group.visible = this.garageStyle === 'garage';
    this.scene.add(group);
    // The posts are solid for both walking and driving while the lift is out;
    // the open floor between them stays walkable.  _syncLiftBoxes() inserts
    // them only while the rig is visible.
    this._liftBoxes = [];
    for (const side of [-1, 1]) {
      this._liftBoxes.push({
        minX: -0.22, maxX: 0.22,
        minZ: side * 2.05 - 0.18, maxZ: side * 2.05 + 0.18,
      });
    }
    this._applyLiftPose();
  }

  setLiftRaised(on, { instant = false } = {}) {
    this._liftTarget = on ? 1.5 : 0;
    if (instant) {
      this.liftHeight = this._liftTarget;
      this._applyLiftPose();
    }
    return this._liftTarget > 0;
  }

  toggleLift() {
    return this.setLiftRaised(!(this._liftTarget > 0));
  }

  isLiftRaised() {
    return this._liftTarget > 0;
  }

  _applyLiftPose() {
    const y = 0.02 + (this.liftHeight || 0);
    for (const carriage of this._liftCarriages || []) carriage.position.y = y;
    const swing = 1 - Math.min(1, (this.liftHeight || 0) / 0.28);
    for (const arm of this._liftArms || []) {
      arm.rotation.y = arm.userData.side * 1.25 * swing;
    }
    const show = this.garageStyle === 'garage'
      && ((this.liftHeight || 0) > 0.004 || (this._liftTarget || 0) > 0);
    if (this.garageLift) this.garageLift.visible = show;
    this._syncLiftBoxes(show);
    if (!this.driveActive) this._applyFloorLift();
  }

  /**
   * The posts only exist for the collision system while the rig is out.  A
   * hidden lift that still blocks the floor would feel like an invisible wall.
   */
  _syncLiftBoxes(on) {
    const boxes = this._garagePropBoxes;
    if (!boxes || !this._liftBoxes) return;
    for (const box of this._liftBoxes) {
      const index = boxes.indexOf(box);
      if (on && index < 0) boxes.push(box);
      else if (!on && index >= 0) boxes.splice(index, 1);
    }
  }

  _updateLift(dt) {
    const target = this._liftTarget || 0;
    if (Math.abs(target - this.liftHeight) < 1e-4) return;
    // A constant 0.85 m/s reads as a real hydraulic lift and lands in under
    // two seconds, without an easing that the eye cannot predict.
    const step = 0.85 * dt;
    this.liftHeight = target > this.liftHeight
      ? Math.min(target, this.liftHeight + step)
      : Math.max(target, this.liftHeight - step);
    if (Math.abs(target - this.liftHeight) < 0.002) this.liftHeight = target;
    this._applyLiftPose();
  }

  _applyFloorLift() {
    const deck = this.garageStyle === 'garage' ? (this._garageFloorTop || 0) : 0;
    if (this.modelGroup && !this.driveActive) {
      this.modelGroup.position.y = deck
        + (this.garageStyle === 'garage' ? (this.liftHeight || 0) : 0);
    }
    if (this.garageProps) this.garageProps.position.y = deck;
    if (this.garageLift) this.garageLift.position.y = deck;
    if (this.garagePool) this.garagePool.position.y = deck + 0.002;
    if (this.garageMarks) this.garageMarks.position.y = deck + 0.004;
    if (this.shadowDisc) {
      this.shadowDisc.position.y = deck
        ? deck + 0.006
        : (this.garageStyle === 'garage' ? -0.003 : 0.001);
    }
  }

  /**
   * Ceiling colour lights: four neon tubes under the roof, four coloured point
   * lights under them, and a real photographic HDRI of a neon studio
   * (Poly Haven `neon_photostudio`, CC0) pre-filtered into the environment so
   * paint, glass and the steel deck all pick the colour up.
   *
   * Off by default - the dock's 彩灯 switch turns it on - and skipped entirely
   * in lite mode, where the point lights would cost more than they give.
   */
  async _loadPartyRig() {
    if (this.partyRig || CONFIG.lite) return;
    const room = this._garageRoom || new THREE.Box3().setFromObject(this.garage);
    const size = room.getSize(new THREE.Vector3());
    const ceil = this._garageCeilY || room.max.y - 1;
    const y = ceil - 0.95;
    const group = new THREE.Group();
    group.name = 'GaragePartyRig';
    group.visible = false;

    const palette = [0xff2f8e, 0x22d3ee, 0xffb020, 0x8b5cf6];
    const spanX = size.x * 0.6;
    const spanZ = size.z * 0.66;
    const tubeGeo = new THREE.BoxGeometry(spanX, 0.15, 0.15);
    const shellGeo = new THREE.BoxGeometry(spanX + 0.24, 0.19, 0.27);
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0x10151c, metalness: 0.75, roughness: 0.45, envMapIntensity: 0.5,
    });
    // Six tubes for the grid the ceiling reads as, three spots for the pools on
    // the deck - the extra tubes are emissive, so they cost nothing to light.
    const tubeCount = 6;
    const tubes = [];
    const lights = [];
    for (let i = 0; i < tubeCount; i++) {
      const z = -spanZ / 2 + (spanZ * i) / (tubeCount - 1);
      const tubeMat = new THREE.MeshStandardMaterial({
        color: 0x0a0d11,
        emissive: new THREE.Color(palette[i % palette.length]),
        emissiveIntensity: 1.5,
        roughness: 0.35,
        metalness: 0,
        // A tonemapped neon tube desaturates to white; skip it so the tube
        // keeps the colour the light itself is throwing.
        toneMapped: false,
      });
      const tube = new THREE.Mesh(tubeGeo, tubeMat);
      tube.position.set(0, y, z);
      group.add(tube);
      tubes.push(tubeMat);
      const shell = new THREE.Mesh(shellGeo, shellMat);
      shell.position.set(0, y + 0.085, z);
      group.add(shell);
    }
    for (let j = 0; j < 3; j++) {
      const z = -spanZ / 2 + (spanZ * j) / 2;
      // A coloured spot straight down the tube's line: the pools it draws on the
      // steel deck are what makes the room read as a light show, which a point
      // light at this room height does not.
      // distance 13 m: the pools reach the deck, but the light does not
      // follow the glass out and light the city at midnight.
      const light = new THREE.SpotLight(palette[j % palette.length], 0, 13, 0.8, 0.72, 2);
      light.position.set(0, y - 0.12, z);
      light.target.position.set(0, GARAGE_FLOOR_TOP, z);
      group.add(light);
      group.add(light.target);
      lights.push(light);
    }
    this.partyRig = group;
    this.partyTubes = tubes;
    this.partyLights = lights;
    this.partyHousings = group.children.filter((c) => c.isMesh && c.material === shellMat);
    this.scene.add(group);
    this._partyT = 0;

    const hdr = await new RGBELoader().loadAsync(`assets/scenes/neon_studio.hdr?v=${CONFIG.version}`);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this._partyEnv = pmrem.fromEquirectangular(hdr).texture;
    pmrem.dispose();
    hdr.dispose?.();
    // A deep link (?lights=1) can switch the rig on before the HDRI lands, so
    // state has to be re-applied here as well as in setPartyLights().
    if (this._partyOn) {
      this._applyPartyEnv();
      for (const l of this.partyLights) l.intensity = 72;
      this._mixGarageLights();
      this._mixSkyLights();
    }
    this._syncPartyVisibility();
  }

  get partyLightsOn() { return Boolean(this._partyOn); }

  setPartyLights(on) {
    const next = Boolean(on);
    if (next === Boolean(this._partyOn)) return next;
    this._partyOn = next;
    if (next) {
      this._applyPartyEnv();
      if (this.partyLights) for (const l of this.partyLights) l.intensity = 72;
    } else {
      this._restorePartyEnv();
    }
    // Hand the room over: the neutral pit lights drop back so the colour is
    // not competing with them, and come back to their tuned values on off.
    this._mixGarageLights();
    this._mixSkyLights();
    this._syncPartyVisibility();
    return next;
  }

  /**
   * The outdoor rig (sun / hemi / ambient) drops to 35 % so the colour show is
   * not fighting broad daylight indoors. Read straight off the active preset,
   * so it needs nothing from the sky module and restores to the hour's own
   * values when the switch goes back off.
   */
  _mixSkyLights() {
    const p = this.skyPreset;
    if (!p || !this.sky) return;
    const mix = this._partyOn ? 0.35 : 1;
    if (this.sky.sun) this.sky.sun.intensity = p.sunIntensity * mix;
    if (this.sky.hemi) this.sky.hemi.intensity = p.hemiIntensity * mix;
    if (this.sky.ambient) this.sky.ambient.intensity = p.ambient * mix;
  }

  /** Neutral rig at full strength, or pulled back under the colour show. */
  _mixGarageLights() {
    if (!this.garageLights || !this._garageLightBase) return;
    const mix = this._partyOn ? 0.38 : 1;
    this.garageLights.children.forEach((l, i) => {
      l.intensity = this._garageLightBase[i] * mix;
    });
  }

  /** The neon HDRI becomes the room's reflections; the sky env is remembered. */
  /**
   * Give the car and the room the neon studio as their reflection map - and
   * only them. `scene.environment` is left alone on purpose: the same map at
   * that level also lights the city through the window, which turns midnight
   * into noon. Material-level envMaps keep the outdoors on the hour's sky.
   */
  _applyPartyEnv() {
    if (!this._partyOn || !this._partyEnv) return;
    // Cars load after the rig, so this runs again for every new model; the set
    // keeps a material from being pushed onto the restore list twice.
    if (!this._partyTouched) this._partyTouched = [];
    if (!this._partySeen) this._partySeen = new Set();
    const touched = this._partyTouched;
    const seen = this._partySeen;
    const take = (mat) => {
      if (!mat || !('envMap' in mat) || seen.has(mat)) return;
      seen.add(mat);
      touched.push({ mat, env: mat.envMap, intensity: mat.envMapIntensity });
      mat.envMap = this._partyEnv;
      mat.envMapIntensity = Math.max(mat.envMapIntensity ?? 1, 1.15);
      mat.needsUpdate = true;
    };
    this.modelRoot?.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(take);
    });
    // The steel deck is deliberately left on the hour's sky: a metal floor
    // mirrors the neon studio straight back and blows out to white. It picks
    // the colour up from the spotlights instead.
    this.garageGlass?.forEach(take);
    this.garageGlassFrame?.traverse((o) => {
      if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(take);
    });
  }

  /** Hand every material back the environment it had before the show. */
  _restorePartyEnv() {
    for (const t of this._partyTouched || []) {
      t.mat.envMap = t.env;
      t.mat.envMapIntensity = t.intensity;
      t.mat.needsUpdate = true;
    }
    this._partyTouched = null;
    this._partySeen = null;
  }

  _syncPartyVisibility() {
    if (!this.partyRig) return;
    this.partyRig.visible = Boolean(this._partyOn)
      && this.garageStyle === 'garage'
      && !this._ceilingHidden;
  }

  /** Slow hue drift: the tubes chase each other and the light pulses with them. */
  _updatePartyLights(dt) {
    if (!this._partyOn || !this.partyRig || !this.partyRig.visible) return;
    this._partyT = (this._partyT || 0) + dt;
    const t = this._partyT;
    // Neighbouring tubes stay close on the colour wheel: complementary hues at
    // once just add up to white. The whole ceiling drifts together instead.
    const base = 0.86 + t * 0.05;
    this.partyTubes.forEach((mat, i) => {
      mat.emissive.setHSL((base + i * 0.15) % 1, 0.95, 0.56);
    });
    this.partyLights.forEach((light, j) => {
      light.color.setHSL((base + j * 0.3) % 1, 0.92, 0.56);
      light.intensity = 72 * (0.62 + 0.38 * Math.sin(t * 1.1 + j * 1.6));
    });
  }

  /** Soft radial falloff used as the floor light pool. */
  _makeLightPoolTexture() {
    const S = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const g = canvas.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(196,210,228,0.5)');
    grad.addColorStop(0.22, 'rgba(160,178,200,0.32)');
    grad.addColorStop(0.52, 'rgba(96,118,146,0.13)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Seamless dark concrete: a 4 m tile with expansion joints and speckle. */
  _makeFloorTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const g = canvas.getContext('2d');
    g.fillStyle = '#2a313b';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 7500; i++) {
      const light = Math.random() > 0.55;
      g.fillStyle = light
        ? `rgba(160,180,205,${0.02 + Math.random() * 0.05})`
        : `rgba(0,0,0,${0.02 + Math.random() * 0.07})`;
      const r = 1 + Math.random() * 2.4;
      g.fillRect(Math.random() * 512, Math.random() * 512, r, r);
    }
    // Expansion joints: 2 x 2 tiles per texture repeat, so one tile is 4 m.
    for (const p of [0, 256]) {
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(p, 0); g.lineTo(p, 512);
      g.moveTo(0, p); g.lineTo(512, p);
      g.stroke();
      g.strokeStyle = 'rgba(180,200,225,0.09)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(p + 2, 0); g.lineTo(p + 2, 512);
      g.moveTo(0, p + 2); g.lineTo(512, p + 2);
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  /** Painted bay outline, turntable ring and corner ticks under the car. */
  _makeBayMarksTexture() {
    const S = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, S, S);
    // The plane is 12 x 12 m: 85.33 px per metre.
    const m = S / 12;
    const c = S / 2;
    const yellow = 'rgba(216,162,28,0.75)';
    const white = 'rgba(206,220,238,0.4)';

    // Bay: 5.4 x 3.0 m, open at the front.
    g.strokeStyle = yellow;
    g.lineWidth = 9;
    const hw = 2.7 * m, hd = 1.5 * m;
    g.beginPath();
    g.moveTo(c - hw, c - hd);
    g.lineTo(c - hw, c + hd);
    g.lineTo(c + hw, c + hd);
    g.lineTo(c + hw, c - hd);
    g.stroke();
    // Dashed centre line.
    g.setLineDash([0.32 * m, 0.28 * m]);
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(206,220,238,0.28)';
    g.beginPath();
    g.moveTo(c - hw + 0.2 * m, c);
    g.lineTo(c + hw - 0.2 * m, c);
    g.stroke();
    g.setLineDash([]);

    // Turntable ring.
    g.strokeStyle = white;
    g.lineWidth = 6;
    g.beginPath();
    g.arc(c, c, 2.45 * m, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(120,190,255,0.18)';
    g.lineWidth = 22;
    g.beginPath();
    g.arc(c, c, 2.45 * m, 0, Math.PI * 2);
    g.stroke();

    // Corner ticks outside the bay.
    g.strokeStyle = yellow;
    g.lineWidth = 7;
    const ox = hw + 0.34 * m, oz = hd + 0.34 * m, len = 0.5 * m;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = c + sx * ox, z = c + sz * oz;
      g.beginPath();
      g.moveTo(x, z - sz * len); g.lineTo(x, z);
      g.lineTo(x - sx * len, z);
      g.stroke();
    }

    // Stencil labels.
    g.font = `600 ${Math.round(0.26 * m)}px "Segoe UI", system-ui, sans-serif`;
    g.fillStyle = 'rgba(206,220,238,0.35)';
    g.textBaseline = 'middle';
    g.fillText('BAY 01', c - hw, c + hd + 0.52 * m);
    g.textAlign = 'right';
    g.fillText('CTVIEWER · PIT', c + hw, c + hd + 0.52 * m);
    g.textAlign = 'left';

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  /** Neon wall sign drawn into a canvas - no external font or image. */
  _makeSignTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, 1024, 256);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 128px "Segoe UI", system-ui, sans-serif';
    if ('letterSpacing' in g) g.letterSpacing = '14px';
    g.shadowColor = '#59c8ff';
    g.shadowBlur = 34;
    g.fillStyle = '#d6efff';
    g.fillText('CTVIEWER', 512, 132);
    g.shadowBlur = 0;
    g.font = '600 30px "Segoe UI", system-ui, sans-serif';
    if ('letterSpacing' in g) g.letterSpacing = '10px';
    g.fillStyle = 'rgba(150,205,240,0.85)';
    g.fillText('PERFORMANCE  ·  DETAIL  ·  PIT', 512, 208);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * Props that give the room scale and life: tyre stacks, a roll cabinet,
   * traffic cones, oil drums, a neon wall sign and ceiling light bars. All
   * procedural, so they cost a few kB instead of another download and can
   * never break the offline build.
   */
  _addGarageProps() {
    if (this.garageProps) return;
    const group = new THREE.Group();
    group.name = 'GarageProps';

    const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({
      color, roughness: 0.68, metalness: 0.18, envMapIntensity: 0.5, ...opts,
    });
    const rubber = mat(0x0d1013, { roughness: 0.96, metalness: 0, envMapIntensity: 0.15 });
    const steel = mat(0x39424e, { roughness: 0.38, metalness: 0.78 });
    const dark = mat(0x171d25, { roughness: 0.6, metalness: 0.45 });
    const safety = mat(0xd9a11c, { roughness: 0.48, metalness: 0.2 });
    const orange = mat(0xc9501c, { roughness: 0.72, metalness: 0.05 });
    const white = mat(0xdfe7f0, { roughness: 0.6, metalness: 0.1 });
    const chestRed = mat(0x7d2222, { roughness: 0.45, metalness: 0.35 });
    const lamp = new THREE.MeshStandardMaterial({
      color: 0x10141a, emissive: 0xdceaff, emissiveIntensity: 3.4,
      roughness: 0.5, metalness: 0,
    });

    const place = (geo, material, x, y, z, rx = 0, ry = 0, rz = 0, parent = group) => {
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // Tyre stacks - the one prop every pit garage has, and a strong scale cue.
    const tyreGeo = new THREE.TorusGeometry(0.35, 0.13, 8, 18);
    const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.13, 14);
    const stack = (x, z, count) => {
      for (let i = 0; i < count; i++) {
        place(tyreGeo, rubber, x, 0.13 + i * 0.27, z, Math.PI / 2, 0, 0);
      }
      place(rimGeo, steel, x, 0.14 + (count - 1) * 0.27, z, Math.PI / 2, 0, 0);
    };
    stack(-6.0, 1.1, 4);
    stack(-6.9, 2.0, 3);
    stack(-5.5, 2.7, 2);
    stack(5.6, -5.4, 3);

    // Roll cabinet with drawers and casters.
    const chest = new THREE.Group();
    chest.position.set(2.6, 0, -6.2);
    chest.rotation.y = 0.7;
    group.add(chest);
    place(new THREE.BoxGeometry(0.94, 1.0, 0.56), chestRed, 0, 0.55, 0, 0, 0, 0, chest);
    for (let i = 0; i < 5; i++) {
      place(new THREE.BoxGeometry(0.84, 0.15, 0.02), dark, 0, 0.2 + i * 0.18, 0.29, 0, 0, 0, chest);
    }
    for (let i = 0; i < 3; i++) {
      place(new THREE.BoxGeometry(0.38, 0.028, 0.02), steel, 0, 0.26 + i * 0.36, 0.31, 0, 0, 0, chest);
    }
    place(new THREE.BoxGeometry(0.9, 0.26, 0.5), chestRed, 0, 1.18, 0, 0, 0, 0, chest);
    for (const sx of [-0.38, 0.38]) for (const sz of [-0.2, 0.2]) {
      place(new THREE.BoxGeometry(0.08, 0.08, 0.04), dark, sx, 0.05, sz, 0, Math.PI / 2, 0, chest);
    }

    // Traffic cones.
    const coneGeo = new THREE.ConeGeometry(0.21, 0.62, 14);
    const bandGeo = new THREE.CylinderGeometry(0.126, 0.138, 0.09, 14);
    const baseGeo = new THREE.BoxGeometry(0.44, 0.04, 0.44);
    const cone = (x, z) => {
      place(baseGeo, safety, x, 0.02, z);
      place(coneGeo, orange, x, 0.35, z);
      place(bandGeo, white, x, 0.37, z);
    };
    cone(-3.2, 5.2);
    cone(-4.1, 5.9);
    cone(2.2, -7.4);

    // Oil drums.
    const drumGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.86, 18);
    const ringGeo = new THREE.TorusGeometry(0.293, 0.014, 4, 18);
    const drum = (x, z, color) => {
      place(drumGeo, color, x, 0.43, z);
      place(ringGeo, dark, x, 0.28, z, Math.PI / 2, 0, 0);
      place(ringGeo, dark, x, 0.6, z, Math.PI / 2, 0, 0);
    };
    drum(4.3, -6.5, mat(0x24405c, { roughness: 0.55, metalness: 0.4 }));
    drum(5.1, -7.1, mat(0x3c2a22, { roughness: 0.6, metalness: 0.35 }));

    // Ceiling light bars, just under the roof slab. They join the roof list so
    // the top preset does not look straight into a bar four metres below it.
    const lamps = [];
    for (const z of [-2.9, 0, 2.9]) {
      lamps.push(place(new THREE.BoxGeometry(3.4, 0.1, 0.22), dark, 0, 5.94, z));
      lamps.push(place(new THREE.BoxGeometry(3.15, 0.03, 0.12), lamp, 0, 5.88, z));
    }
    if (this._garageCeiling) this._garageCeiling.push(...lamps);

    // Dark wainscot and a safety pin line along the four walls. The model's
    // walls are floor-to-ceiling lightboxes, which read as an empty showroom;
    // the band gives the room a base line at car height.
    const inner = this._garageInnerBox || this._garageRoom;
    if (inner) {
      const size = inner.getSize(new THREE.Vector3());
      const cx = (inner.min.x + inner.max.x) / 2;
      const cz = (inner.min.z + inner.max.z) / 2;
      const wains = mat(0x10161e, { roughness: 0.58, metalness: 0.35, envMapIntensity: 0.2 });
      const pin = new THREE.MeshStandardMaterial({
        color: 0x3a3222, roughness: 0.5, metalness: 0.2,
        emissive: 0xb8892a, emissiveIntensity: 0.35,
      });
      const band = (width, x, z, ry) => {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, 1.02), wains);
        mesh.position.set(x, 0.51, z);
        mesh.rotation.y = ry;
        group.add(mesh);
        const line = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.05), pin);
        line.position.set(x, 1.07, z);
        line.rotation.y = ry;
        group.add(line);
      };
      band(size.x, cx, inner.min.z + 0.05, 0);
      band(size.x, cx, inner.max.z - 0.05, Math.PI);
      band(size.z, inner.min.x + 0.05, cz, Math.PI / 2);
      band(size.z, inner.max.x - 0.05, cz, -Math.PI / 2);
    }

    // Wall tyre rack: six tyres on two shelves against the far wall.
    const rackX = -9.24;
    const rackZ = -8.2;
    for (const y of [0.62, 1.82]) place(new THREE.BoxGeometry(0.46, 0.06, 3.3), steel, rackX, y, rackZ);
    for (const z of [rackZ - 1.6, rackZ + 1.6]) {
      place(new THREE.BoxGeometry(0.46, 2.6, 0.06), dark, rackX, 1.3, z);
    }
    const rackTyre = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 16);
    for (const y of [0.98, 2.18]) {
      for (let i = 0; i < 4; i++) {
        place(rackTyre, rubber, rackX, y, rackZ - 1.15 + i * 0.78, 0, 0, Math.PI / 2);
      }
    }

    // Neon sign on the far wall (visible behind the car from the hero view).
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 1.05),
      new THREE.MeshBasicMaterial({
        map: this._makeSignTexture(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    sign.position.set(-9.4, 2.65, -5.6);
    sign.rotation.y = Math.PI / 2;
    sign.name = 'GarageSign';
    group.add(sign);

    // Workbench against the back wall: a surface for the vice, oil tins and
    // spray cans that arrive with the CC0 workshop set.
    const bench = new THREE.Group();
    bench.position.set(-4.0, 0, -11.2);
    const timber = mat(0x6b4a30, { roughness: 0.74, metalness: 0.04, envMapIntensity: 0.3 });
    place(new THREE.BoxGeometry(2.6, 0.09, 0.8), timber, 0, 0.9, 0, 0, 0, 0, bench);
    for (const sx of [-1.22, 1.22]) for (const sz of [-0.33, 0.33]) {
      place(new THREE.BoxGeometry(0.07, 0.86, 0.07), steel, sx, 0.43, sz, 0, 0, 0, bench);
    }
    place(new THREE.BoxGeometry(2.5, 0.05, 0.7), dark, 0, 0.24, 0, 0, 0, 0, bench);
    group.add(bench);
    this._garagePropBoxes = this._garagePropBoxes || [];
    this._garagePropBoxes.push({ minX: -5.3, maxX: -2.7, minZ: -11.6, maxZ: -10.8 });

    // The primitive props are ~80 small meshes; merging them per material cuts
    // the draw calls without touching the silhouette. Ceiling lamps stay out
    // (they are toggled with the roof), as does the sign (its own texture).
    this._mergeGarageProps(group, new Set(lamps));

    this.garageProps = group;
    this.scene.add(group);
  }

  /**
   * Merge static child meshes that share a material into one geometry per
   * material. Used for the primitive garage set (tyre stacks, chest, cones,
   * drums, wainscot bands): they are built from a handful of Box/Cylinder/Torus
   * geometries and never move, so 80 draw calls can become ~10.
   */
  _mergeGarageProps(group, keep) {
    group.updateMatrixWorld(true);
    const toLocal = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const batches = new Map();
    const collected = [];
    group.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
      if (keep?.has(obj) || obj.name === 'GarageSign') return;
      if (Array.isArray(obj.material) || !obj.material) return;
      const list = batches.get(obj.material) || [];
      list.push(obj);
      batches.set(obj.material, list);
      collected.push(obj);
    });
    let mergedCount = 0;
    for (const [material, meshes] of batches) {
      if (meshes.length < 2) continue;
      const geos = [];
      for (const mesh of meshes) {
        const geo = mesh.geometry.clone();
        geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld));
        geos.push(geo);
      }
      const merged = mergeGeometries(geos, false);
      geos.forEach((geo) => geo.dispose());
      if (!merged) continue;
      const batch = new THREE.Mesh(merged, material);
      batch.name = 'GaragePropBatch';
      batch.castShadow = false;
      batch.receiveShadow = true;
      group.add(batch);
      for (const mesh of meshes) mesh.parent?.remove(mesh);
      mergedCount += meshes.length - 1;
    }
    this._garagePropMerged = mergedCount;
  }

  /**
   * Furnish the garage with real workshop props.
   *
   * The room shipped with a car, four primitive tyre stacks and a roll chest,
   * which still reads as an empty hall from the camera presets.  These are
   * Poly Haven's CC0 industrial models (see CREDITS.md), packed offline into
   * small Draco GLBs under assets/props/.
   *
   * Each model is re-pivoted on its bounding-box bottom centre, so the table
   * can place things by the metre regardless of where the original file put
   * its origin.  Their footprints join _garagePropBoxes, which the character's
   * walk collision consults.
   */
  async _loadGaragePropModels() {
    if (this._garagePropModelsStarted || !this.garageProps) return;
    this._garagePropModelsStarted = true;
    // name, x, z, yaw, y = 0, collide = true, scale = 1
    const table = [
      // Back wall: parts store and machine row, read from the hero presets.
      // shelves_01 is authored at roughly 10x the other props, so it is scaled
      // down to a 1.1 x 2.14 m unit - the same height as shelves_02.
      ['steel_frame_shelves_01', -8.4, -11.05, 0, 0, true, 0.1],
      ['worn_metal_rack', -6.75, -11.05, 0],
      ['steel_frame_shelves_02', 0.9, -11.05, 0],
      ['metal_tool_chest', 4.9, -11.0, 0],
      ['old_drill_press', 6.8, -11.0, 0],
      ['portable_generator', 8.6, -10.95, 0],
      // Service gear in the right-hand bay.
      ['tool_cart', 3.0, -10.2, 0.5],
      ['old_tyre', 8.9, -8.4, 0],
      ['old_tyre', 8.9, -8.4, 0.3, 0.16, false],
      ['rusted_wheel_rim_01', 4.2, -9.6, 0.6],
      ['rusted_wheel_rim_01', 4.8, -9.95, -0.4],
      ['barrel_03', 8.9, -6.9, 0],
      ['barrel_03', -6.3, -8.9, 0],
      ['ladder_sectioned_01', 9.25, -9.9, -Math.PI / 2],
      ['hand_truck', 9.0, -1.6, -1.2],
      // Right-hand strip along the open side: storage and service gear.
      ['tool_cart', 8.6, 1.4, -1.1],
      ['barrel_03', 9.2, 2.7, 0],
      ['steel_frame_shelves_02', 9.3, 4.2, -Math.PI / 2],
      ['plastic_crate_01', 9.2, 0.5, 0.7],
      ['old_tyre', 8.7, 5.9, 0],
      ['old_tyre', 8.7, 5.9, 0.3, 0.16, false],
      ['rusted_wheel_rim_01', 9.35, 6.7, -0.5],
      ['metal_trash_can', -1.3, -10.7, 0],
      ['cardboard_box_01', 1.7, -11.0, 0.3],
      ['cardboard_box_01', 2.2, -11.2, -0.2],
      ['plastic_crate_01', -6.4, -9.95, 0.2],
      ['plastic_crate_01', -5.95, -9.55, -0.35],
      ['oil_tin', -2.6, -10.5, 0],
      ['korean_fire_extinguisher_01', -3.3, -10.15, 0.2],
      ['WetFloorSign_01', 3.6, 9.0, -0.3],
      // On the bench top (the bench itself carries the collision box).
      ['bench_vice_01', -4.85, -11.25, 0, 0.945, false],
      ['oil_tin', -4.1, -11.3, 0.4, 0.945, false],
      ['spray_paint_bottles', -3.5, -11.25, 0, 0.945, false],
      ['small_oil_can_01', -3.0, -11.3, -0.2, 0.945, false],
      // Stock on the shelf boards.  The board heights were measured off each
      // model's vertex rows (shelves_02: 0.11/0.62/1.13/1.63/2.11 m; the
      // scaled shelves_01 and the rack share the same rhythm).
      ['small_oil_can_01', 0.72, -11.1, 0.4, 0.13, false],
      ['oil_tin', 1.08, -11.05, 0, 0.64, false],
      ['spray_paint_bottles', 0.74, -11.0, 0, 0.64, false],
      ['plastic_crate_01', -6.95, -11.05, 0.1, 0.44, false],
      ['small_oil_can_01', -6.5, -11.0, -0.3, 0.44, false],
      ['cardboard_box_01', -8.55, -11.1, 0.1, 0.13, false],
      ['cardboard_box_01', -8.15, -11.0, -0.2, 0.64, false],
    ];

    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(CONFIG.decoderPath);
    draco.setDecoderConfig({ type: CONFIG.lite ? 'js' : 'wasm' });
    loader.setDRACOLoader(draco);

    const group = new THREE.Group();
    group.name = 'GaragePropModels';
    this.garageProps.add(group);

    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    for (const [name, x, z, yaw, y = 0, collide = true, scale = 1] of table) {
      let gltf;
      try {
        gltf = await loader.loadAsync(`assets/props/${name}.glb?v=${CONFIG.version}`);
      } catch (err) {
        console.warn('garage prop failed', name, err);
        continue;
      }
      const root = gltf.scene;
      if (scale !== 1) root.scale.setScalar(scale);
      root.updateMatrixWorld(true);
      box.setFromObject(root).getSize(size);
      root.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.castShadow = false;
        obj.receiveShadow = true;
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const material of materials) {
          if (!material) continue;
          if ('envMapIntensity' in material) material.envMapIntensity = 0.85;
          // The generator ships a 21-triangle transmissive pane; one such
          // material makes three render the entire scene a second time into
          // the transmission target (~7 ms here). Plain transparency reads the
          // same at this size and keeps the frame single-pass.
          if ('transmission' in material && material.transmission > 0) {
            material.transmission = 0;
            material.transparent = true;
            material.opacity = Math.min(material.opacity ?? 1, 0.6);
            material.needsUpdate = true;
          }
        }
      });
      // Re-pivot on the bottom centre: the table then reads in metres.
      root.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      const holder = new THREE.Group();
      holder.name = name;
      holder.add(root);
      holder.position.set(x, y, z);
      holder.rotation.y = yaw;
      group.add(holder);
      if (!collide) continue;
      holder.updateMatrixWorld(true);
      const world = new THREE.Box3().setFromObject(holder);
      this._garagePropBoxes.push({
        minX: world.min.x, maxX: world.max.x,
        minZ: world.min.z, maxZ: world.max.z,
      });
    }
    draco.dispose();
    this._garagePropModelCount = group.children.length;
    this._garagePropY = {};
    for (const holder of group.children) {
      box.setFromObject(holder);
      this._garagePropY[holder.name] = +box.max.y.toFixed(2);
    }
    // Each model shipped as 1-8 meshes; batch the ones that share a material so
    // the 21 props cost ~30 draw calls instead of 72. Their footprints were
    // already recorded above, so collision is unaffected.
    this._mergeGarageProps(group, null);
  }

  /** Small light rig so the props and floor edges do not go completely flat. */
  _addGarageLights() {
    if (this.garageLights || CONFIG.lite) return;
    const group = new THREE.Group();
    group.name = 'GarageLights';
    const bar = (x, y, z, color, intensity, distance) => {
      const light = new THREE.PointLight(color, intensity, distance, 2);
      light.position.set(x, y, z);
      group.add(light);
    };
    bar(0, 4.2, -4.4, 0xdfefff, 5, 13);
    bar(0, 4.2, 4.4, 0xdfefff, 4, 13);
    bar(-4.6, 3.4, 0, 0x9ccaff, 3, 12);
    bar(4.6, 3.4, 0, 0xffd9b0, 3, 12);
    // Warm practicals over the tyre wall and the tool bench.
    bar(-4.4, 2.7, 3.2, 0xffb066, 2.6, 8);
    bar(-5.6, 2.5, -3.2, 0xffc38a, 2.2, 8);
    this.garageLights = group;
    // Kept so the colour show can pull the neutral rig back and hand the room
    // to the neon, then put it back exactly as it was.
    this._garageLightBase = group.children.map((l) => l.intensity);
    this.scene.add(group);
  }

  /** Switch between the garage backdrop and the seamless studio floor. */
  setSceneStyle(style) {    const next = style === 'studio' ? 'studio' : 'garage';
    const on = next === 'garage';
    this.garageStyle = next;
    // The seamless studio has no lift: drop it so returning to the garage does
    // not snap the car back up into the air.
    if (!on) {
      this.liftHeight = 0;
      this._liftTarget = 0;
    }
    if (this.garage) this.garage.visible = on;
    if (this.garageLights) this.garageLights.visible = on;
    if (this.garageStage) this.garageStage.visible = on;
    if (this.garagePool) this.garagePool.visible = on;
    if (this.garageMarks) this.garageMarks.visible = on;
    if (this.garageProps) this.garageProps.visible = on;
    if (this.garageDeck) this.garageDeck.visible = on;
    if (this.garageGlassFrame) this.garageGlassFrame.visible = on;
    // The lift is a service pose, not showroom furniture: its posts would cut
    // straight through a side view of the car, so the whole rig only appears
    // while it is raised (or about to be).
    this._applyLiftPose();
    if (this.garage) this.scene.fog = on ? this._garageFog : null;
    if (this._garageCeiling) {
      this._ceilingHidden = false;
      for (const mesh of this._garageCeiling) mesh.visible = on;
    }
    if (!on && this._garageClipMats) {
      for (const mat of this._garageClipMats) {
        if (!mat.clippingPlanes) continue;
        mat.clippingPlanes = null;
        mat.needsUpdate = true;
      }
    }
    // The studio has no steel deck, so the car drops back to y = 0 with it.
    this._applyFloorLift();
    if (this.ground) this.ground.visible = !on;
    if (this.ring) this.ring.visible = !on;
    this._syncPartyVisibility();
    // The outdoor world belongs to the garage view; the seamless studio is a
    // closed set with no windows, so the city and sky go with it.
    this.sky?.setVisible(on);
    this.city?.setVisible(on);
    // setVisible() reinstates the hour's environment; the show outranks it.
    if (on && this._partyOn) this._applyPartyEnv();
    if (on) {
      if (!this.garage) this._loadGarage().catch(() => {});
      // A session that started in the studio never kicked off the outdoor
      // load.  Coming back to the garage has to bring the city and the hour
      // with it, or the room opens onto a black void.
      this._loadOutdoors().catch(() => {});
    }
    return next;
  }

  /**
   * Roof meshes are hidden while the camera looks down into the room from
   * above it - but only when it is actually *over* the room.  Zooming the orbit
   * out also lifts the eye above the roof line while the camera is still far
   * outside the footprint; the roof is exactly what should be seen from there,
   * and hiding it made the garage look like an open-topped box the moment the
   * wheel was scrolled (the same complaint the wall clip plane had).
   */
  _updateGarageCeiling() {
    if (!this._garageCeiling || this.garageStyle !== 'garage') return;
    const room = this._garageRoom;
    const cam = this.camera.position;
    // Hysteresis so a camera skimming the roof edge does not flicker.
    const margin = this._ceilingHidden ? 3.0 : 1.0;
    const overRoom = !!room
      && cam.x > room.min.x - margin && cam.x < room.max.x + margin
      && cam.z > room.min.z - margin && cam.z < room.max.z + margin;
    const hide = cam.y > this._garageCeilY && overRoom;
    if (hide === this._ceilingHidden) return;
    this._ceilingHidden = hide;
    for (const mesh of this._garageCeiling) mesh.visible = !hide;
    const planes = hide && this._garageClipPlane ? [this._garageClipPlane] : null;
    for (const mat of this._garageClipMats || []) {
      mat.clippingPlanes = planes;
      mat.needsUpdate = true;
    }
    this._syncPartyVisibility();
  }

  /**
   * The five filler ring blocks carry 5 x 336k triangles (~62 % of the whole
   * frame) and sit 810 m away, behind the centred 620 m block.  From the car
   * presets and the spawn plaza they are fully occluded, so they are hidden
   * whenever the eye is near the centre; hysteresis keeps a camera walking out
   * of the plaza from flickering them at the boundary.
   */
  _updateCityRings() {
    const city = this.city;
    if (!city?.ready || !city.rings?.length) return;
    const cam = this.photoActive && this.photoMode
      ? this.photoMode.camera.position
      : this.driveActive && this.drivingMode
        ? this.drivingMode.camera.position
        : this.exploreActive && this.characterMode
          ? this.characterMode.camera.position
          : this.camera.position;
    const dist = Math.hypot(cam.x, cam.z);
    // 110 / 160 m: the plaza's radius is ~120 m, the ring's inner edge 510 m.
    const limit = this._ringsOn ? 160 : 110;
    const want = this.quality !== 'low' && dist > limit;
    if (want === this._ringsOn) return;
    this._ringsOn = want;
    city.setRingsVisible(want);
  }

  /**
   * Quality tiers. `lite` stays the software-rendering fallback; `quality` is
   * the user-facing dial (`?q=low|medium|high`), and the adaptive downgrade
   * steps high -> low once if the device cannot hold 30 fps.
   */
  setQuality(name, { auto = false } = {}) {
    const next = ['low', 'medium', 'high'].includes(name) ? name : 'high';
    // Remember what an automatic downgrade replaced, so the tier can be handed
    // back once the frame rate proves healthy (see the stats tick in _animate).
    if (auto && !this._qualityAutoFrom) this._qualityAutoFrom = this.quality;
    this.quality = next;
    if (!this.renderer) return;
    const device = window.devicePixelRatio || 1;
    this._basePixelRatio = CONFIG.dpr || (next === 'low' ? 1
      : next === 'medium' ? Math.min(device, 1.25)
        : Math.min(device, CONFIG.maxPixelRatio));
    this.renderScale = 1;
    this._applyRenderScale();
    this.renderer.shadowMap.enabled = next !== 'low' && !CONFIG.lite && !this.isCoarsePointer;
    this._updateCityRings();
    if (auto) this._qualityAuto = true;
    this.cb.onQuality?.(next, auto);
  }

  /** Apply the tier's base pixel ratio times the dynamic resolution scale. */
  _applyRenderScale() {
    if (!this.renderer) return;
    const ratio = Math.max(0.55, Math.min(2, (this._basePixelRatio || 1) * (this.renderScale || 1)));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  /**
   * Dynamic resolution controller: hold 42-55 fps by trading pixels, not
   * detail. At 1701x1007 the garage + city costs ~31 ms on an Iris Xe at full
   * resolution; 0.75x lands at 47 fps and 0.65x at 54 fps with no geometry or
   * material change. Steps are small and one-way per stats tick so it settles
   * instead of oscillating.
   */
  _updateRenderScale(fps, now = performance.now()) {
    if (!this.renderer || !fps || CONFIG.dpr) return;
    // Let the load-in shaders compile before judging the frame rate, and move
    // at most once every 1.5 s: at 4 Hz a single slow tick used to walk the
    // scale all the way to the floor.
    if (now - this.loadStart < 5000) return;
    if (now - (this._lastDrsAt || 0) < 1500) return;
    this._lastDrsAt = now;
    let next = this.renderScale;
    // 45-52 fps band: below it trade pixels, above it take them back. The
    // recovery step is smaller than the cut so the controller settles instead
    // of pumping.
    if (fps < 45) next -= 0.04;
    else if (fps > 52) next += 0.02;
    next = Math.max(0.55, Math.min(1, next));
    if (Math.abs(next - this.renderScale) < 0.004) return;
    this.renderScale = next;
    this._applyRenderScale();
  }

  /**
   * Keep a preset's camera inside the room: the garage is opaque from the
   * outside, so a camera behind a wall looks at a black shell. The ceiling is
   * not clamped - looking down from above it is fine because that roof is
   * hidden by _updateGarageCeiling().
   */
  _clampToRoom(pos, target) {
    const room = this._garageRoom;
    if (!room || this.garageStyle !== 'garage') return pos;
    const inner = room.clone();
    inner.min.x += 0.5; inner.max.x -= 0.5;
    inner.min.z += 0.5; inner.max.z -= 0.5;
    inner.min.y = 0.35;
    inner.max.y = room.max.y + 12;
    if (inner.containsPoint(pos)) return pos;
    let lo = 0.04;
    let hi = 1;
    for (let i = 0; i < 16; i++) {
      const t = (lo + hi) / 2;
      if (inner.containsPoint(target.clone().lerp(pos, t))) lo = t;
      else hi = t;
    }
    return target.clone().lerp(pos, lo);
  }

  _createLiteEnvironment() {
    // Tiny procedural equirect gradient — useful on software WebGL.
    const width = 256, height = 128;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const t = y / (height - 1);
      const r = Math.round(18 + 90 * Math.pow(1 - t, 2));
      const g = Math.round(28 + 120 * Math.pow(1 - t, 2));
      const b = Math.round(40 + 160 * Math.pow(1 - t, 2));
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    return tex;
  }

  _createStudioEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = new THREE.Scene();
    env.background = new THREE.Color(0x020407);
    const planeGeo = new THREE.PlaneGeometry(1, 1);
    const panel = (w, h, pos, rot, intensity, color) => {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(intensity),
        side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(planeGeo, mat);
      m.scale.set(w, h, 1);
      m.position.set(...pos);
      m.rotation.set(...rot);
      env.add(m);
    };
    // Long overhead strip — the signature highlight of automotive studios.
    panel(16, 1.6, [0, 7.5, 0], [Math.PI / 2, 0, 0], 7.5, 0xffffff);
    panel(2.4, 12, [-8, 3.6, 0], [0, -Math.PI / 2, 0], 8.0, 0xbfe4ff);
    panel(2.0, 12, [8, 3.4, 0], [0, Math.PI / 2, 0], 6.5, 0xffdfc2);
    panel(12, 2.2, [0, 3.0, -8], [0, 0, 0], 4.0, 0xffffff);
    panel(12, 1.4, [0, 2.0, 8], [0, Math.PI, 0], 4.6, 0xcfe9ff);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 50),
      new THREE.MeshBasicMaterial({ color: 0x04060a, side: THREE.DoubleSide }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1;
    env.add(floor);
    const texture = pmrem.fromScene(env, 0.03).texture;
    pmrem.dispose();
    return texture;
  }

  _initLights() {
    if (CONFIG.lite) this.scene.add(new THREE.AmbientLight(0xbcd8ff, 1.8));
    this.scene.add(new THREE.AmbientLight(0xf2f8ff, 0.55));
    const hemi = new THREE.HemisphereLight(0xe8f3ff, 0x18222e, 2.0);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 5.4);
    key.position.set(4.5, 8, 5);
    key.castShadow = !CONFIG.lite;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -6;
    key.shadow.camera.right = 6;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -6;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 30;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.015;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x9ccaff, 4.2);
    rim.position.set(-6, 4.5, -5);
    this.scene.add(rim);

    const frontFill = new THREE.DirectionalLight(0xeaf6ff, 4.0);
    frontFill.position.set(2.5, 3.2, 8);
    this.scene.add(frontFill);

    const rearFill = new THREE.DirectionalLight(0xffd8b0, 2.6);
    rearFill.position.set(-4, 2.4, -7);
    this.scene.add(rearFill);

    const warm = new THREE.PointLight(0xffe3c2, 75, 24, 2);
    warm.position.set(0, 2.6, 4.5);
    this.scene.add(warm);
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, 0.55, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.4;
    this.controls.maxDistance = 45;
    this.controls.minPolarAngle = 0.05;
    this._maxPolarAngle = Math.PI * 0.53;
    this.controls.maxPolarAngle = this._maxPolarAngle;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.addEventListener('start', () => { this.cameraTween = null; });
  }

  _bindEvents() {
    window.addEventListener('resize', this._onResize);
    // A background tab gets no animation frames, so the frame-rate samples go
    // stale and the first stats tick after returning reads ~1 fps.  The
    // one-way quality downgrade below would take that as a weak GPU and drop
    // the tier to 'low' for the rest of the session.  Clear the samples on
    // hide and give the sampler a short grace window on return.
    document.addEventListener('visibilitychange', () => {
      this.fpsSamples.length = 0;
      if (document.visibilityState === 'visible') {
        this._resumeGraceUntil = performance.now() + 3000;
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.pointerClient.x = e.clientX;
      this.pointerClient.y = e.clientY;
      this.pointerDirty = true;
      this.pointerInside = true;
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this._setHovered(null);
    });
    // Orbiting with a drag also ends in a `click` on the canvas, so remember
    // where the press started and only treat a press that stayed put as a pick.
    this._pressPoint = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      this._pressPoint = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('click', (e) => {
      const press = this._pressPoint;
      this._pressPoint = null;
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return;
      if (this.hovered) {
        this.select(this.hovered.userData.partId);
        return;
      }
      // Touch devices do not always emit a hover pass before the tap.
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObjects(this.meshes.filter((m) => m.visible), false)[0];
      if (hit?.object.userData.partId) this.select(hit.object.userData.partId);
      else this.clearSelection();
    });
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Browsers fire resize for a lot of things that do not change the canvas -
    // a toolbar collapsing, a mobile address bar, a pane re-layout. Refitting
    // the view on those snaps the camera back to the hero shot while the user
    // is looking at something, so only a real change of size re-frames.
    if (w === this._lastW && h === this._lastH) return;
    this._lastW = w;
    this._lastH = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.characterMode?.onResize();
    this.drivingMode?.onResize();
    this.photoMode?.onResize();
    if (this.exploreActive || this.driveActive || this.photoActive) return;
    clearTimeout(this._resizeFitTimer);
    this._resizeFitTimer = setTimeout(() => {
      if (this.ready) this.fitView({ animate: true, duration: 420, padding: 1.75 });
    }, 220);
  }

  _reportStage(label, progress, extra = {}) {
    this.cb.onStage?.(label, clamp01(progress), extra);
  }

  _buildPreview(scene, car) {
    const flat = this._flattenAndNormalize(scene, car);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1a3550, metalness: 0.7, roughness: 0.35, envMapIntensity: 0.8,
    });
    for (const mesh of flat.meshes) mesh.material = mat;
    flat.group.name = 'LOD_Preview';
    return flat.group;
  }

  /**
   * Bake every node transform into its geometry and normalize the car to a
   * consistent 4.55 m length, centred at the origin with its wheels on y = 0.
   * This makes part picking, explosion offsets and camera fitting identical
   * for every imported model, regardless of the source units/orientation.
   *
   * Orientation is normalised to the shop's convention as well: the long axis
   * lies on X and the nose points at +X, because the front camera preset sits
   * on +X and the part labeller reads +X as 前. Source models disagree on that
   * (three of the 34 arrived nose-first at −X), so `flip` turns a car around
   * before the source `rotate` fix is applied.
   */
  _flattenAndNormalize(scene, car) {
    scene.updateMatrixWorld(true);
    const group = new THREE.Group();
    const meshes = [];
    const rotateFix = car?.rotate;
    // A few exports are rolled onto their side (see models.json `rotate`).
    // Applied to the baked geometry before measuring, so everything downstream
    // still sees a car that is upright, centred and on the studio floor.
    const fix = Array.isArray(rotateFix) && rotateFix.length === 3
      ? new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(rotateFix[0]),
        THREE.MathUtils.degToRad(rotateFix[1]),
        THREE.MathUtils.degToRad(rotateFix[2]),
      ))
      : null;
    // `multiply` puts the yaw on the right, i.e. it runs first: the car is
    // turned around in its own space and then laid down by the source fix.
    const turn = car?.flip ? new THREE.Matrix4().makeRotationY(Math.PI) : null;
    const bake = fix ? (turn ? fix.multiply(turn) : fix) : turn;

    scene.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      const geometry = obj.geometry.clone();
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      geometry.applyMatrix4(obj.matrixWorld);
      const mesh = new THREE.Mesh(geometry, obj.material);
      mesh.name = obj.name || `part_${meshes.length + 1}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
      meshes.push(mesh);
    });

    if (!meshes.length) throw new Error('模型没有可渲染网格');
    if (bake) for (const mesh of meshes) mesh.geometry.applyMatrix4(bake);
    group.updateMatrixWorld(true);

    let box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const targetLength = 4.55;
    const scale = targetLength / Math.max(size.x, size.z, 1e-6);
    const rotateY = size.z > size.x ? Math.PI / 2 : 0;
    const transform = new THREE.Matrix4();
    transform.makeRotationY(rotateY);
    transform.scale(new THREE.Vector3(scale, scale, scale));
    for (const mesh of meshes) mesh.geometry.applyMatrix4(transform);

    group.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3(-center.x, -box.min.y, -center.z);
    for (const mesh of meshes) mesh.geometry.translate(offset.x, offset.y, offset.z);
    group.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(group);
    return { group, meshes, box };
  }

  _partBox(mesh) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox.clone();
  }

  _tuneMaterials(mesh, materials) {
    for (const m of materials) {
      if (!m) continue;
      const name = (m.name || '').toLowerCase();
      m.envMapIntensity = 1.15;
      // A single transmissive material makes three render the whole scene a
      // second time into the transmission target - on the F430 the nine window
      // meshes alone added ~0.7M triangles and ~100 draw calls per frame.
      // Plain transparency plus the 2.0 env reflection reads the same at this
      // size, so the pass is switched off for every car material.
      if ('transmission' in m && m.transmission > 0) m.transmission = 0;
      if (name.includes('glass') || name.includes('window')) {
        m.transparent = true;
        m.opacity = 0.56;
        m.depthWrite = false;
        m.roughness = 0.05;
        m.metalness = 0.0;
        m.envMapIntensity = 2.0;
        m.side = THREE.DoubleSide;
        if ('clearcoat' in m) {
          m.clearcoat = 1.0;
          m.clearcoatRoughness = 0.02;
        }
        mesh.renderOrder = 4;
        mesh.castShadow = false;
      } else if (name.includes('light') || name.includes('lamp')) {
        m.emissiveIntensity = 2.2;
        m.toneMapped = true;
        m.envMapIntensity = 1.4;
      } else if (name.includes('carbon')) {
        m.envMapIntensity = 0.55;
        m.roughness = Math.max(0.4, m.roughness ?? 0.5);
      } else if (name.includes('tire') || name.includes('tyre') || name.includes('rubber')) {
        m.roughness = 0.94;
        m.metalness = 0.0;
        m.envMapIntensity = 0.5;
      } else if (name.includes('rim') || name.includes('chrome') || name.includes('disc') || name.includes('rotor')) {
        m.envMapIntensity = 1.4;
      }
      m.needsUpdate = true;
    }
  }

  _prepareModel(scene, bytes, car) {
    const flat = this._flattenAndNormalize(scene, car);
    this.modelRoot = flat.group;
    this.modelGroup.add(flat.group);
    this._modelBox = flat.box;
    // A car that arrives while the colour show is running needs the neon
    // reflection map too - it was loaded after _applyPartyEnv() first ran.
    if (this._partyOn) this._applyPartyEnv();

    const paintMeshes = [];
    const parts = [];
    let triangles = 0;

    flat.meshes.forEach((mesh, index) => {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const materialNames = materials.map((m) => m?.name || '').filter(Boolean);
      mesh.userData.originalMaterial = materials.length === 1 ? materials[0] : mesh.material;

      const localBox = this._partBox(mesh);
      const meta = classifyPart({
        name: mesh.name,
        materials: materialNames,
        car,
        index,
        box: localBox,
        modelBox: flat.box,
      });
      const geom = mesh.geometry;
      meta.triangles = Math.round(geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3);
      meta.vertices = geom.attributes.position?.count || 0;
      const s = localBox.getSize(new THREE.Vector3());
      meta.volume = Math.max(1e-9, s.x * s.y * s.z);

      mesh.userData.partId = meta.id;
      mesh.userData.meta = meta;
      mesh.castShadow = meta.category !== '玻璃' && meta.category !== '灯光';
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;

      if (meta.paint) {
        paintMeshes.push(mesh);
      } else {
        this._tuneMaterials(mesh, materials);
      }
      triangles += meta.triangles;
      parts.push(meta);
      this.meshes.push(mesh);
      this.meshById.set(meta.id, mesh);
    });

    // The largest painted panel is the visual "core" of the car; it only
    // lifts a little while the other parts radiate around it.
    const core = parts.filter((part) => part.paint).sort((a, b) => b.volume - a.volume)[0];
    if (core) core.isCore = true;

    this.parts = parts;
    // Models with fully baked textures may have no dedicated paint material;
    // the UI greys the finish picker out instead of silently doing nothing.
    this.paintable = paintMeshes.length > 0;
    this.paint = new PaintController(paintMeshes, {
      duration: CONFIG.paintTransitionMs,
      preserveLivery: Boolean(car.preserveLivery),
      onChange: (index, preset) => this.cb.onPaintChange?.(index, preset),
    });
    for (const mesh of paintMeshes) this._ensureShell(mesh, 0.12);
    this._computeExplosionData();
    this.paint.apply(0, { immediate: true });

    const manifest = {
      id: car.id,
      car,
      name: car.fullName,
      zhName: car.zhName,
      partCount: parts.length,
      triangles: Math.round(triangles),
      sourceBytes: car.sourceBytes,
      compressedBytes: bytes.byteLength,
      parts,
    };
    this.manifest = manifest;
    this.stats.parts = parts.length;
    this.stats.triangles = Math.round(triangles);
    this.stats.sourceBytes = car.sourceBytes;
    this.stats.compressedBytes = bytes.byteLength;
    this.cb.onManifest?.(manifest);
    this.cb.onModel?.(manifest);
    this.cb.onStats?.(this.getStats());
    return flat.group;
  }

  _computeExplosionData() {
    this.explodeOffsets.clear();
    if (!this._modelBox || this._modelBox.isEmpty()) return;

    const center = this._modelBox.getCenter(new THREE.Vector3());
    const modelSize = this._modelBox.getSize(new THREE.Vector3());
    const maxModelDim = Math.max(modelSize.x, modelSize.y, modelSize.z, 1e-6);

    for (const mesh of this.meshes) {
      const meta = mesh.userData.meta;
      if (meta.isCore) {
        this.explodeOffsets.set(meta.id, new THREE.Vector3(0, 0.62, 0));
        continue;
      }

      const box = this._partBox(mesh);
      const c = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const rule = CATEGORY_BASE[meta.category] || { radial: 0.6, y: 0.1 };

      let dir = new THREE.Vector3(c.x - center.x, 0, c.z - center.z);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, c.z >= center.z ? 1 : -1);
      dir.normalize();

      // Big parts (bumpers, doors) travel less; small fasteners and lenses
      // spread farther so the exploded layout stays readable.
      const rel = Math.max(size.x, size.y, size.z) / maxModelDim;
      const sizeFactor = 1.16 - Math.min(0.5, rel * 0.9);
      dir.multiplyScalar(rule.radial * sizeFactor);
      dir.y = rule.y + (c.y - center.y) * 0.12;
      // Keep every exploded part above the studio floor.
      dir.y = Math.max(dir.y, 0.02 - box.min.y);

      this.explodeOffsets.set(meta.id, dir);
    }
  }

  _ensureShell(mesh, intensity = 0) {
    if (this.shells.has(mesh.userData.partId)) return this.shells.get(mesh.userData.partId);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uIntensity: { value: intensity },
        uColor: { value: new THREE.Color(0x8fe8ff) },
        uPower: { value: 2.15 },
      },
      vertexShader: `
        varying vec3 vNormalV;
        varying vec3 vViewDir;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vNormalV = normalize(normalMatrix * normal);
          vViewDir = normalize(-mvPosition.xyz);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform float uIntensity;
        uniform vec3 uColor;
        uniform float uPower;
        varying vec3 vNormalV;
        varying vec3 vViewDir;
        void main() {
          float fres = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir))), uPower);
          float alpha = clamp(fres * uIntensity, 0.0, 1.0);
          gl_FragColor = vec4(uColor * fres * uIntensity, alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    const shell = new THREE.Mesh(mesh.geometry, material);
    shell.name = `${mesh.name}_Fresnel`;
    const box = this._partBox(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const shellScale = 1.006;
    shell.scale.setScalar(shellScale);
    // Geometry is baked in world coordinates, so scale around the part's own
    // centre instead of around the model origin.
    shell.position.copy(center).multiplyScalar(1 - shellScale);
    shell.renderOrder = 6;
    shell.userData.isShell = true;
    shell.raycast = () => {};
    mesh.add(shell);
    this.shells.set(mesh.userData.partId, shell);
    return shell;
  }

  _setHovered(mesh) {
    if (this.hovered === mesh) return;
    if (this.hovered) {
      const prev = this.shells.get(this.hovered.userData.partId);
      if (prev) prev.material.uniforms.uIntensity.value = this.hovered === this.selected ? 0.85 : (this.hovered.userData.meta.paint ? 0.12 : 0.0);
    }
    this.hovered = mesh;
    if (mesh) {
      const shell = this._ensureShell(mesh, 0.0);
      shell.material.uniforms.uIntensity.value = 0.82;
      this.cb.onHover?.(mesh.userData.meta, { x: this.pointerClient.x, y: this.pointerClient.y });
      this.canvas.style.cursor = 'pointer';
    } else {
      this.cb.onHover?.(null);
      this.canvas.style.cursor = 'grab';
    }
  }

  select(id) {
    const mesh = typeof id === 'string' ? this.meshById.get(id) : id;
    if (!mesh) return;
    if (this.selected === mesh) return;
    if (this.selected) {
      const old = this.shells.get(this.selected.userData.partId);
      if (old) old.material.uniforms.uIntensity.value = this.selected.userData.meta.paint ? 0.12 : 0.0;
    }
    this.selected = mesh;
    const shell = this._ensureShell(mesh, 0.0);
    shell.material.uniforms.uIntensity.value = 1.0;
    this.cb.onSelect?.(mesh.userData.meta, this.getPartRecord(mesh.userData.partId));
    this.cb.onSelectionChange?.(mesh.userData.partId);
  }

  hoverPart(id) {
    const mesh = typeof id === 'string' ? this.meshById.get(id) : id;
    this._setHovered(mesh || null);
  }

  clearSelection() {
    if (!this.selected) return;
    const old = this.shells.get(this.selected.userData.partId);
    if (old) old.material.uniforms.uIntensity.value = this.selected.userData.meta.paint ? 0.12 : 0.0;
    this.selected = null;
    this.cb.onSelect?.(null);
    this.cb.onSelectionChange?.(null);
  }

  getPartRecord(id) {
    return this.manifest?.parts.find((p) => p.id === id) || null;
  }

  setIsolate(id) {
    const target = typeof id === 'string' ? this.meshById.get(id) : id;
    if (!target) return;
    this.clearIsolation();
    this.isolated = target;
    for (const mesh of this.meshes) {
      mesh.visible = mesh === target;
      const shell = this.shells.get(mesh.userData.partId);
      if (shell) shell.visible = mesh.visible;
    }
    this.cb.onIsolate?.(target.userData.meta);
  }

  clearIsolation() {
    if (!this.isolated) return;
    this.isolated = null;
    for (const mesh of this.meshes) {
      mesh.visible = true;
      const shell = this.shells.get(mesh.userData.partId);
      if (shell) shell.visible = true;
    }
    this.cb.onIsolate?.(null);
  }

  focusPart(id) {
    const mesh = typeof id === 'string' ? this.meshById.get(id) : id;
    if (!mesh) return;
    const box = this._partBox(mesh).translate(mesh.position.clone());
    this.fitBox(box, { animate: true, duration: 650, padding: 2.4 });
  }

  setPaint(index, { immediate = false } = {}) {
    this.paint?.apply(index, { immediate });
  }

  setExplode(value) {
    this.explodeTarget = clamp01(value);
    this._needsExplodeRefit = true;
  }

  getWorldBounds() {
    const box = new THREE.Box3();
    for (const mesh of this.meshes) {
      if (!mesh.visible) continue;
      const part = this._partBox(mesh);
      part.translate(mesh.position);
      box.union(part);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-2.5, 0, -1.3), new THREE.Vector3(2.5, 1.5, 1.3));
    // The lift is part of the display pose, so presets frame the raised car.
    if (this.garageStyle === 'garage' && this.liftHeight > 0.001) {
      box.translate(new THREE.Vector3(0, this.liftHeight, 0));
    }
    return box;
  }

  fitView({ animate = true, duration = 650, padding = 1.75 } = {}) {
    this.controls.maxPolarAngle = this._maxPolarAngle || Math.PI * 0.53;
    this.fitBox(this.getWorldBounds(), { animate, duration, padding });
  }

  /**
   * Distance at which the box exactly fills the frame for a camera looking
   * along `dir`. Fitting the bounding *sphere* (what this used to do) framed a
   * 4.55 m car by its 2.5 m radius, so a front view stood 11 m back and the car
   * read as a toy. This projects the eight box corners instead, so every preset
   * is as tight as its own silhouette allows.
   */
  _fitDistanceForBox(box, dir, padding = 1.2) {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const tanV = Math.tan(vFov / 2) / padding;
    const tanH = Math.tan(hFov / 2) / padding;
    // A camera looking straight down has no defined roll; pick the same stable
    // screen-up that lookAt() will produce with the camera's own up vector.
    const up = Math.abs(dir.y) > 0.995 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const forward = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const upView = new THREE.Vector3().crossVectors(right, forward).normalize();
    const center = box.getCenter(new THREE.Vector3());
    let distance = 0;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const q = new THREE.Vector3(x, y, z).sub(center);
          const depth = q.dot(forward);
          distance = Math.max(
            distance,
            Math.abs(q.dot(right)) / tanH - depth,
            Math.abs(q.dot(upView)) / tanV - depth,
          );
        }
      }
    }
    return Math.max(distance, 2.2);
  }

  /**
   * Snap the camera to a named view. The car is normalised to face +X, so the
   * presets are stable across every model.
   */
  setView(preset = 'hero', { animate = true, duration = 620 } = {}) {
    // The chassis view is a pose, not a direction: raise the two-post lift and
    // put the eye at floor level looking up at the underside.
    if (preset === 'under') {
      this.setLiftRaised(true);
      const toTarget = new THREE.Vector3(0, 1.62, 0);
      const toPos = new THREE.Vector3(5.6, 0.62, 4.7);
      // The orbit clamp normally keeps the eye above the car; the chassis view
      // has to look up from floor level, so it gets a temporarily wider arc.
      this.controls.maxPolarAngle = Math.PI * 0.62;
      this.cameraTween = null;
      if (!animate) {
        this.controls.target.copy(toTarget);
        this.camera.position.copy(toPos);
        this.controls.update();
        return;
      }
      this.cameraTween = {
        fromPos: this.camera.position.clone(),
        toPos,
        fromTarget: this.controls.target.clone(),
        toTarget,
        start: performance.now(),
        duration,
      };
      return;
    }
    this.controls.maxPolarAngle = this._maxPolarAngle || Math.PI * 0.53;
    // `top` sits exactly on the orbit clamp: a camera straight above its target
    // has no defined roll, and OrbitControls would otherwise snap it to a
    // diagonal. The clamp is small, so the view still reads as straight down.
    const topPolar = this.controls.minPolarAngle + 0.002;
    const DIRS = {
      front: [1, 0.07, 0],
      side: [0, 0.07, 1],
      rear: [-1, 0.07, 0],
      top: [0, Math.cos(topPolar), Math.sin(topPolar)],
      hero: [1, 0.46, 1],
    };
    // Air left around the car. The UI panels cover the outer third of the
    // viewport, so the orthogonal views keep more margin than the 3/4 shot.
    const PADDING = { front: 1.72, side: 1.95, rear: 1.72, top: 2.0, hero: 1.9 };
    const dir = new THREE.Vector3(...(DIRS[preset] || DIRS.hero)).normalize();
    const box = this.getWorldBounds();
    const center = box.getCenter(new THREE.Vector3());
    const toTarget = new THREE.Vector3(center.x, Math.max(center.y, 0.15), center.z);
    const raw = toTarget.clone().addScaledVector(
      dir,
      Math.min(this._fitDistanceForBox(box, dir, PADDING[preset] || 1.6), 42),
    );
    const toPos = this._clampToRoom(raw, toTarget);
    // A new preset always wins over a running tween (the load-in animation can
    // last most of a second, and a click during it used to be swallowed).
    this.cameraTween = null;
    if (!animate) {
      this.controls.target.copy(toTarget);
      this.camera.position.copy(toPos);
      this.controls.update();
      return;
    }
    this.cameraTween = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget,
      start: performance.now(),
      duration,
    };
  }

  fitBox(box, { animate = true, duration = 650, padding = 1.75 } = {}) {
    let dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.7, 0.35, 0.8);
    dir.normalize();
    const center = box.getCenter(new THREE.Vector3());
    const toTarget = new THREE.Vector3(center.x, Math.max(center.y, 0.15), center.z);
    const raw = toTarget.clone().addScaledVector(
      dir,
      Math.min(this._fitDistanceForBox(box, dir, padding), 42),
    );
    const toPos = this._clampToRoom(raw, toTarget);
    this.cameraTween = null;
    if (!animate) {
      this.controls.target.copy(toTarget);
      this.camera.position.copy(toPos);
      this.controls.update();
      return;
    }
    this.cameraTween = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget,
      start: performance.now(),
      duration,
    };
  }

  toggleAutoRotate(force) {
    this.autoRotate = typeof force === 'boolean' ? force : !this.autoRotate;
    this.controls.autoRotate = this.autoRotate;
    return this.autoRotate;
  }

  resetView() {
    this.clearIsolation();
    this.explodeTarget = 0;
    this.fitView({ animate: true, duration: 700, padding: 1.75 });
  }

  getStats() {
    return {
      ...this.stats,
      fps: Math.round(this.stats.fps),
      drawCalls: this.renderer?.info.render.calls || 0,
      trianglesRendered: this.renderer?.info.render.triangles || 0,
      paint: this.paint?.getState() || null,
      explode: this.explodeCurrent,
      carId: this.currentCar?.id || null,
    };
  }

  /** Enter the city on foot with one of the imported characters. */
  async enterExplore(id) {
    if (!this.characterMode) this.characterMode = new CharacterMode(this);
    this.characterMode.onExit = () => this.exitExplore();
    const meta = await this.characterMode.enter(id);
    this.exploreActive = true;
    this.controls.enabled = false;
    this.cameraTween = null;
    this._setHovered?.(null);
    document.body.classList.add('is-exploring');
    return meta;
  }

  exitExplore() {
    if (!this.exploreActive) return;
    this.exploreActive = false;
    this.characterMode?.exit();
    this.controls.enabled = true;
    document.body.classList.remove('is-exploring');
    this.controls.update();
    this.cb.onExploreExit?.();
  }

  /* ---------------- P2 · test drive / photo studio ---------------- */

  enterDrive() {
    if (this.driveActive) return { carId: this.currentCar?.id || null };
    if (!this.drivingMode) {
      this.drivingMode = new DrivingMode(this);
      this.drivingMode.onRequestExit = () => this.exitDrive();
    }
    if (this.photoActive) this.exitPhoto();
    // The character waits invisibly in the driver's seat: the root is hidden
    // rather than disposed, so a walker can step back out beside the door.
    if (this.exploreActive && this.characterMode) {
      this.characterMode.active = false;
      this.characterMode.keys.clear();
      if (this.characterMode.root) this.characterMode.root.visible = false;
      if (this.characterMode.shadow) this.characterMode.shadow.visible = false;
      this._driveCharacter = true;
      document.body.classList.remove('is-exploring');
    } else {
      this._driveCharacter = false;
    }
    this.drivingMode.enter();
    return { carId: this.currentCar?.id || null };
  }

  exitDrive({ force = false } = {}) {
    if (!this.driveActive) return;
    this.drivingMode.exit({ force });
    // The driver asked to get out while still rolling: the mode refused.
    if (this.driveActive) return;
    if (this._driveCharacter && this.characterMode?.root) {
      // Step out on the driver's side (the car's left is −Z after the model is
      // normalised nose-to-+X) and face the car.
      const box = this._modelBox;
      const x = (box.min.x + box.max.x) / 2 - 0.35;
      const z = box.min.z - 0.9;
      this.characterMode.root.visible = true;
      if (this.characterMode.shadow) this.characterMode.shadow.visible = true;
      this.characterMode.active = true;
      this.characterMode.teleportTo(x, z, 0);
      document.body.classList.add('is-exploring');
      this.exploreActive = true;
    }
    this._driveCharacter = false;
    this.cb.onDriveExit?.({ carId: this.currentCar?.id || null });
  }

  enterPhoto() {
    if (this.driveActive) return null;
    if (!this.photoMode) {
      this.photoMode = new PhotoMode(this);
      this.photoMode.onRequestExit = () => this.exitPhoto();
    }
    return this.photoMode.enter();
  }

  exitPhoto() {
    if (!this.photoActive) return;
    this.photoMode.exit();
    this.cb.onPhotoExit?.();
  }

  _animate() {
    requestAnimationFrame(this._boundAnimate);
    // A tab that was in the background hands back a multi-second delta; physics
    // and tweens should not try to catch up on that.  1/12 s keeps wall-clock
    // motion honest on a slow-but-live frame without letting a hitch teleport
    // anything (the character substeps its own physics on top of this).
    const dt = Math.min(this.clock.getDelta(), 1 / 12);
    const now = performance.now();
    // A tab that is backgrounded, minimised or fully occluded still reports
    // visibility "visible" in some browsers, but its animation frames are
    // throttled to ~1 fps.  Track the largest gap since the last stats tick so
    // the downgrade below can tell "slow GPU" from "not being rendered".
    const frameGap = now - (this._lastFrameAt || now);
    this._lastFrameAt = now;
    this._frameGapMax = Math.max(this._frameGapMax || 0, frameGap);
    this._updateLift(dt);
    this._updateCityRings();

    if (this.photoActive && this.photoMode) {
      this.photoMode.update(dt);
      this._updatePartyLights(dt);
      this.renderer.render(this.scene, this.photoMode.camera);
      // Grabbing frames right after the render keeps the WebGL buffer readable.
      this.photoMode.afterRender();
    } else if (this.driveActive && this.drivingMode) {
      this.drivingMode.update(dt);
      this._updatePartyLights(dt);
      this.renderer.render(this.scene, this.drivingMode.camera);
    } else if (this.exploreActive && this.characterMode) {
      this.characterMode.update(dt);
      this._updatePartyLights(dt);
      this.renderer.render(this.scene, this.characterMode.camera);
    } else {
      if (this.cameraTween) {
        const t = clamp01((now - this.cameraTween.start) / this.cameraTween.duration);
        const e = easeOutQuint(t);
        this.camera.position.lerpVectors(this.cameraTween.fromPos, this.cameraTween.toPos, e);
        this.controls.target.lerpVectors(this.cameraTween.fromTarget, this.cameraTween.toTarget, e);
        if (t >= 1) this.cameraTween = null;
      }

      this.controls.update();
      this._updateGarageCeiling();
      this._updatePartyLights(dt);
      this.paint?.update();

      // Explosion animation
      if (Math.abs(this.explodeCurrent - this.explodeTarget) > 0.0005) {
        this.explodeCurrent += (this.explodeTarget - this.explodeCurrent) * Math.min(1, dt * this.explodeSpeed);
        if (Math.abs(this.explodeCurrent - this.explodeTarget) < 0.001) this.explodeCurrent = this.explodeTarget;
        const eased = easeOutQuint(this.explodeCurrent);
        for (const mesh of this.meshes) {
          const offset = this.explodeOffsets.get(mesh.userData.partId);
          if (offset) mesh.position.copy(offset).multiplyScalar(eased);
        }
        if (this.explodeCurrent === this.explodeTarget && this._needsExplodeRefit) {
          this._needsExplodeRefit = false;
          if (this.ready) this.fitView({ animate: true, duration: 620, padding: 1.7 });
        }
      }

      // Hover raycast at most once per frame
      if (this.pointerDirty && this.pointerInside && this.ready) {
        this.pointerDirty = false;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(this.meshes.filter((m) => m.visible), false);
        const hit = hits.find((h) => h.object.userData.partId);
        this._setHovered(hit ? hit.object : null);
      }

      this.renderer.render(this.scene, this.camera);
    }

    // FPS + HUD at 4 Hz
    this.fpsSamples.push(now);
    while (this.fpsSamples.length && now - this.fpsSamples[0] > 1000) this.fpsSamples.shift();
    if (now - this.lastStatsAt > 450) {
      this.lastStatsAt = now;
      // A tab that just came back has one frame in its sample window; hold the
      // previous reading so the HUD does not flash 1 FPS either.
      const inGrace = now < (this._resumeGraceUntil || 0);
      if (!inGrace) this.stats.fps = this.fpsSamples.length;
      // One-way adaptive downgrade for very weak devices: if dynamic
      // resolution bottoms out and the frame rate is still unusable, drop the
      // tier too (shadows / base DPR). A single low sample is not enough: a
      // resize, a shader compile or a window drag drops one or two ticks, and
      // treating that as a weak GPU cost the user shadows for the session.
      // Four consecutive samples (about 1.8 s) must stay under 24 fps, the tab
      // must be visible, its frames must not be throttled, and a later healthy
      // stretch hands the tier back once.
      const throttled = (this._frameGapMax || 0) > 500;
      this._frameGapMax = 0;
      if (!inGrace && !throttled && document.visibilityState === 'visible') {
        this._lowFpsTicks = (this.stats.fps > 0 && this.stats.fps < 24)
          ? (this._lowFpsTicks || 0) + 1
          : 0;
        if (!this.qualityReduced && !this._qualityRestored
            && this._lowFpsTicks >= 4 && now - this.loadStart > 10000) {
          this.qualityReduced = true;
          this._qualityDowngradedAt = now;
          if (this.quality !== 'low') this.setQuality('low', { auto: true });
        } else if (this.qualityReduced && this._qualityAutoFrom
            && this.stats.fps >= 45 && now - (this._qualityDowngradedAt || 0) > 20000) {
          const restore = this._qualityAutoFrom;
          this._qualityAutoFrom = null;
          this.qualityReduced = false;
          this._qualityRestored = true;
          this.setQuality(restore, { auto: false });
        }
        this._updateRenderScale(this.stats.fps, now);
      }
      this.cb.onStats?.(this.getStats());
    }
  }

  _renderLoop() {
    this.controls.update();
    requestAnimationFrame(this._boundAnimate);
  }

  _disposeGroup(group) {
    const textures = new Set();
    const materials = new Set();
    const collect = (m) => {
      if (!m || materials.has(m)) return;
      materials.add(m);
      for (const key of [
        'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
        'emissiveMap', 'alphaMap', 'clearcoatMap', 'clearcoatNormalMap',
        'clearcoatRoughnessMap', 'sheenColorMap', 'transmissionMap', 'thicknessMap',
      ]) {
        if (m[key]) textures.add(m[key]);
      }
    };
    group.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) collect(m);
      // The paint controller swaps each painted mesh's material for its own
      // MeshPhysicalMaterial; the authored one (and its maps) is only reachable
      // through userData. Without this the outgoing car's textures were never
      // freed - measured as 34 -> 65 live textures across one car switch.
      collect(obj.userData?.originalMaterial);
    });
    for (const m of materials) m.dispose?.();
    for (const t of textures) t.dispose?.();
  }
}
