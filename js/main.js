import { CTViewer } from './viewer.js';
import { CONFIG, PAINTS, DEFAULT_PAINT } from './config.js';
import { CARS } from './catalog.js';
import { CLIP_LABELS } from './characters.js';
import { PHOTO_FILTERS } from './photo.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const dom = {
  loading: $('#loading'),
  carStrip: $('#car-strip'),
  carPrev: $('#car-prev'),
  carNext: $('#car-next'),
  carCount: $('#car-count'),
  btnLibrary: $('#btn-library'),
  library: $('#library'),
  libraryClose: $('#library-close'),
  libraryBody: $('#library-body'),
  libraryCount: $('#library-count'),
  viewPresets: $$('.view-presets button'),
  skyPresets: $$('#sky-presets button'),
  brandSub: $('#brand-sub'),
  summaryParts: $('#summary-parts'),
  summaryCount: $('#summary-count'),
  creditNote: $('#credit-note'),
  loadingLabel: $('#loading-label'),
  loadingPct: $('#loading-percent'),
  loadingBar: $('#loading-bar'),
  paintList: $('#paint-list'),
  paintCaption: $('#paint-caption'),
  paintColor: $('#paint-color'),
  partsList: $('#parts-list'),
  partSearch: $('#part-search'),
  filters: $('#category-filters'),
  inspectorEmpty: $('#inspector-empty'),
  inspectorContent: $('#inspector-content'),
  tooltip: $('#tooltip'),
  hudFps: $('#hud-fps'),
  hudDraw: $('#hud-draw'),
  hudTris: $('#hud-tris'),
  explodeSlider: $('#explode-slider'),
  explodeValue: $('#explode-value'),
  btnExplodePlay: $('#btn-explode-play'),
  btnRotate: $('#btn-rotate'),
  btnScene: $('#btn-scene'),
  btnSceneLabel: $('#btn-scene-label'),
  btnExplore: $('#btn-explore'),
  characterModal: $('#character-modal'),
  characterBody: $('#character-body'),
  characterClose: $('#character-close'),
  characterCount: $('#character-count'),
  exploreHud: $('#explore-hud'),
  exploreName: $('#explore-name'),
  exploreActions: $('#explore-action-list'),
  exploreExit: $('#explore-exit'),
  exploreSwitch: $('#explore-switch'),
  exploreSpawn: $('#explore-spawn'),
  btnLights: $('#btn-lights'),
  btnReset: $('#btn-reset'),
  btnFit: $('#btn-fit'),
  btnHelp: $('#btn-help'),
  btnFullscreen: $('#btn-fullscreen'),
  helpModal: $('#help-modal'),
  helpClose: $('#help-close'),
  metricParts: $('#metric-parts'),
  metricSize: $('#metric-size'),
  metricCompressed: $('#metric-compressed'),
  metricTris: $('#metric-tris'),
  statusLabel: $('#status-label'),
  errorPanel: $('#error-panel'),
  errorText: $('#error-text'),
  toast: $('#toast'),
  isolateChip: $('#isolate-chip'),
  isolateExit: $('#isolate-exit'),
  btnDrive: $('#btn-drive'),
  btnPhoto: $('#btn-photo'),
  btnLift: $('#btn-lift'),
  carHint: $('#car-hint'),
  carHintEnter: $('#car-hint-enter'),
  exploreDrive: $('#explore-drive'),
  driveHud: $('#drive-hud'),
  driveGear: $('#drive-gear'),
  driveSpeed: $('#drive-speed'),
  driveRpm: $('#drive-rpm'),
  driveThrottle: $('#drive-throttle'),
  driveBrake: $('#drive-brake'),
  driveDrift: $('#drive-drift'),
  driveSound: $('#drive-sound'),
  driveExit: $('#drive-exit'),
  photoHud: $('#photo-hud'),
  photoFilters: $('#photo-filters'),
  photoGuides: $('#photo-guides'),
  photoGuide: $('#photo-guide'),
  photoShot: $('#photo-shot'),
  photoRecord: $('#photo-record'),
  photoStatus: $('#photo-status'),
  photoExit: $('#photo-exit'),
};

const CAT_COLORS = {
  '外饰': '#8fe8ff',
  '玻璃': '#b9d9ff',
  '灯光': '#ffe08a',
  '空气动力学': '#ff9b6a',
  '车轮': '#b7ff8a',
  '内饰': '#ffb3df',
  '底盘': '#9aa7ff',
  '其他': '#9aa0aa',
};

const state = {
  parts: [],
  filtered: [],
  category: '全部',
  query: '',
  selectedId: null,
  paintIndex: DEFAULT_PAINT,
  viewer: null,
  ready: false,
  characters: null,
  characterId: null,
  exploring: false,
  driving: false,
  photo: false,
};

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function showToast(text, timeout = 2200) {
  dom.toast.textContent = text;
  dom.toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => dom.toast.classList.remove('show'), timeout);
}

/* ---------------- City explorer ---------------- */

function characterAccent(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `linear-gradient(145deg, hsl(${h} 42% 34%), hsl(${(h + 46) % 360} 38% 15%))`;
}

async function loadCharacters() {
  if (state.characters) return state.characters;
  const res = await fetch('./assets/characters/characters.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`人物目录 HTTP ${res.status}`);
  state.characters = await res.json();
  return state.characters;
}

function renderCharacterCards() {
  const cat = state.characters;
  if (!cat || !dom.characterBody) return;
  dom.characterCount.textContent = String(cat.characters.length);
  dom.characterBody.innerHTML = '';
  cat.characters.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'character-item' + (c.id === state.characterId ? ' is-active' : '');
    btn.innerHTML = `
      <span class="character-avatar" style="background:${characterAccent(c.id)}">${c.zhName.slice(0, 1)}</span>
      <span class="character-meta">
        <strong>${c.zhName}</strong>
        <small>${c.enName} · ${Math.round(c.triangles / 1000)}k tris</small>
      </span>`;
    btn.addEventListener('click', () => startExplore(c.id));
    dom.characterBody.appendChild(btn);
  });
}

async function openCharacterModal() {
  if (!dom.characterModal) return;
  dom.characterModal.classList.add('show');
  dom.characterModal.setAttribute('aria-hidden', 'false');
  if (state.characters) {
    renderCharacterCards();
    return;
  }
  dom.characterBody.innerHTML = '<div class="character-loading">正在读取人物目录…</div>';
  try {
    await loadCharacters();
    renderCharacterCards();
  } catch (err) {
    dom.characterBody.innerHTML = `<div class="character-loading">人物目录加载失败：${err.message || err}</div>`;
  }
}

function closeCharacterModal() {
  dom.characterModal?.classList.remove('show');
  dom.characterModal?.setAttribute('aria-hidden', 'true');
}

function buildExploreActions() {
  const cat = state.characters;
  if (!cat || !dom.exploreActions) return;
  const order = ['Idle', 'Walking', 'Running', 'Jumping'];
  const clips = [...cat.clips].sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  dom.exploreActions.innerHTML = '';
  clips.forEach((clip) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action-chip' + (clip.name === 'Idle' ? ' is-active' : '');
    btn.textContent = CLIP_LABELS[clip.name] || clip.name;
    btn.title = `${clip.name} · ${clip.seconds.toFixed(1)} s`;
    btn.addEventListener('click', () => {
      const ok = state.viewer.characterMode?.playAction(clip.name);
      if (!ok) return;
      dom.exploreActions.querySelectorAll('.action-chip').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
    dom.exploreActions.appendChild(btn);
  });
}

async function startExplore(id) {
  closeCharacterModal();
  try {
    await loadCharacters();
    // Exploring happens outside: the seamless studio would hide the city and
    // leave the player in an empty void.
    if (state.viewer.garageStyle !== 'garage') {
      state.viewer.setSceneStyle('garage');
      if (dom.btnSceneLabel) dom.btnSceneLabel.textContent = '车库';
      dom.btnScene?.classList.add('is-active');
      dom.btnScene?.setAttribute('aria-pressed', 'true');
    }
    showToast('正在载入人物与动作…', 6000);
    const meta = await state.viewer.enterExplore(id);
    const cm = state.viewer.characterMode;
    cm.onNearCarChange = (near) => {
      if (state.driving || state.photo) return;
      dom.carHint?.classList.toggle('show', Boolean(near));
    };
    cm.onEnterCar = () => {
      if (cm.canEnterCar()) startDrive();
      else showToast('走到车旁再按 E 上车');
    };
    cm.onToast = showToast;
    state.characterId = id;
    state.exploring = true;
    dom.exploreHud?.setAttribute('aria-hidden', 'false');
    if (dom.exploreName) dom.exploreName.textContent = `${meta.zhName} · ${meta.enName}`;
    buildExploreActions();
    dom.btnExplore?.classList.add('is-active');
    dom.btnExplore?.setAttribute('aria-pressed', 'true');
    showToast(`${meta.zhName} 已到达出生点 · WASD 移动`, 3200);
  } catch (err) {
    console.error('explore', err);
    showToast(`人物加载失败：${err.message || err}`, 4200);
  }
}

function exitExploreUI() {
  state.exploring = false;
  dom.exploreHud?.setAttribute('aria-hidden', 'true');
  dom.btnExplore?.classList.remove('is-active');
  dom.btnExplore?.setAttribute('aria-pressed', 'false');
  dom.carHint?.classList.remove('show');
  closeCharacterModal();
}

/* ---------------- P2 · test drive ---------------- */

function updateDriveTelemetry(t) {
  if (dom.driveSpeed) dom.driveSpeed.textContent = String(t.kmh);
  if (dom.driveGear) dom.driveGear.textContent = t.gear;
  dom.driveDrift?.classList.toggle('show', Boolean(t.drift));
  if (dom.driveRpm) dom.driveRpm.style.width = `${Math.min(100, (t.kmh / 200) * 100)}%`;
  dom.driveThrottle?.style.setProperty('--w', `${Math.round((t.throttle || 0) * 100)}%`);
  dom.driveBrake?.style.setProperty('--w', `${Math.round((t.brake || 0) * 100)}%`);
}

function startDrive() {
  if (!state.viewer || state.driving || state.viewer.driveActive) return;
  if (state.viewer.photoActive) state.viewer.exitPhoto();
  // Driving happens outside; the seamless studio hides the city.
  if (state.viewer.garageStyle !== 'garage') {
    state.viewer.setSceneStyle('garage');
    dom.btnSceneLabel.textContent = '车库';
    dom.btnScene?.classList.add('is-active');
    dom.btnScene?.setAttribute('aria-pressed', 'true');
  }
  state.viewer.enterDrive();
  state.driving = true;
  state.exploring = false;
  dom.driveHud?.setAttribute('aria-hidden', 'false');
  dom.btnDrive?.classList.add('is-active');
  dom.carHint?.classList.remove('show');
  const mode = state.viewer.drivingMode;
  mode.onToast = showToast;
  mode.onTelemetry = updateDriveTelemetry;
  dom.driveSound?.classList.toggle('is-on', !mode.muted);
  dom.driveSpeed && (dom.driveSpeed.textContent = '0');
  dom.driveGear && (dom.driveGear.textContent = 'N');
  showToast('试驾模式 · W 油门 · S 刹车 / 倒车 · Space 手刹漂移 · E 停车下车', 4600);
}

function exitDriveUI() {
  state.driving = false;
  dom.driveHud?.setAttribute('aria-hidden', 'true');
  dom.btnDrive?.classList.remove('is-active');
  if (state.viewer?.exploreActive) state.exploring = true;
}

/* ---------------- P2 · photo / recording ---------------- */

function buildPhotoFilters() {
  const pm = state.viewer?.photoMode;
  if (!pm || !dom.photoFilters) return;
  dom.photoFilters.innerHTML = '';
  PHOTO_FILTERS.forEach((f) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'photo-filter' + (pm.filter === f.id ? ' is-active' : '');
    btn.dataset.filter = f.id;
    btn.textContent = f.name;
    btn.title = `滤镜：${f.name}`;
    btn.addEventListener('click', () => {
      pm.setFilter(f.id);
      syncPhotoFilters();
    });
    dom.photoFilters.appendChild(btn);
  });
}

function syncPhotoFilters() {
  const pm = state.viewer?.photoMode;
  dom.photoFilters?.querySelectorAll('.photo-filter').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.filter === pm?.filter);
  });
}

function setPhotoStatus(recording, left) {
  if (!dom.photoStatus) return;
  dom.photoStatus.classList.toggle('is-recording', recording);
  dom.photoStatus.textContent = recording
    ? `录像中 · 剩余 ${Math.max(1, Math.ceil(left))} 秒`
    : 'WASD 飞行 · E/Q 升降 · 拖拽转向 · 滚轮变焦 · Shift 加速';
}

function startPhoto() {
  if (!state.viewer || state.photo) return;
  if (state.viewer.driveActive) {
    showToast('先下车，再进入拍照模式');
    return;
  }
  state.viewer.enterPhoto();
  const pm = state.viewer.photoMode;
  if (!pm) return;
  state.photo = true;
  pm.onToast = showToast;
  pm.onState = (s) => {
    if (s.filter) syncPhotoFilters();
    if (s.guide !== undefined) {
      dom.photoGuides?.classList.toggle('show', s.guide);
      dom.photoGuide?.classList.toggle('is-on', s.guide);
    }
    if (s.recording !== undefined) setPhotoStatus(s.recording, s.left || 0);
  };
  buildPhotoFilters();
  syncPhotoFilters();
  dom.photoGuides?.classList.toggle('show', pm.guide);
  dom.photoGuide?.classList.toggle('is-on', pm.guide);
  setPhotoStatus(false, 0);
  dom.photoHud?.setAttribute('aria-hidden', 'false');
  dom.btnPhoto?.classList.add('is-active');
  dom.carHint?.classList.remove('show');
  showToast('拍照模式 · 拖拽取景 · F 拍照 · R 录像 · P 退出', 4200);
}

function exitPhotoUI() {
  state.photo = false;
  dom.photoHud?.setAttribute('aria-hidden', 'true');
  dom.btnPhoto?.classList.remove('is-active');
  dom.photoGuides?.classList.remove('show');
}

/* ---------------- P2 · lift ---------------- */

function toggleLift() {
  if (!state.viewer) return;
  if (state.viewer.driveActive) {
    showToast('驾驶中不能操作举升机');
    return;
  }
  if (state.viewer.garageStyle !== 'garage') {
    showToast('举升机在车库场景里');
    return;
  }
  const on = state.viewer.toggleLift();
  dom.btnLift?.classList.toggle('is-active', on);
  showToast(on ? '两柱举升机：升起（点击「底」可切底盘视角）' : '两柱举升机：放下');
}

function buildPaintUI() {
  dom.paintList.innerHTML = '';
  PAINTS.forEach((p, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'paint-option' + (index === DEFAULT_PAINT ? ' is-active' : '');
    btn.dataset.index = String(index);
    btn.setAttribute('aria-label', `${p.name} ${p.en}`);
    btn.innerHTML = `
      <span class="paint-swatch" style="background:${p.swatch}"></span>
      <span class="paint-meta">
        <span class="paint-name">${p.name}<em>${p.en}</em></span>
        <span class="paint-desc">${p.desc}</span>
      </span>
      <span class="paint-check" aria-hidden="true">✓</span>
    `;
    btn.addEventListener('click', () => applyPaint(index));
    dom.paintList.appendChild(btn);
  });
  const preset = PAINTS[DEFAULT_PAINT];
  dom.paintCaption.innerHTML = `<strong>${preset.name}</strong><span>${preset.desc}</span><small>460 ms 缓动过渡 · MeshPhysicalMaterial</small>`;
  if (dom.paintColor) {
    dom.paintColor.value = preset.color;
    dom.paintColor.addEventListener('input', () => {
      if (!state.viewer || state.viewer.paintable === false) return;
      state.customColor = dom.paintColor.value;
      state.viewer.paint?.setColor(state.customColor);
      $$('.paint-option').forEach((el) => el.classList.remove('is-active'));
      dom.paintCaption.innerHTML = `<strong>自定义底色</strong><span>${state.customColor.toUpperCase()} · 沿用当前工艺参数</span><small>460 ms 缓动过渡 · MeshPhysicalMaterial</small>`;
    });
  }
}

function buildCarUI() {
  if (!dom.carStrip) return;
  dom.carStrip.innerHTML = '';
  CARS.forEach((car) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'car-chip';
    btn.dataset.car = car.id;
    btn.style.setProperty('--car-accent', car.accent);
    btn.title = `${car.fullName} · ${car.partCount} 个零件 · ${car.year}`;
    btn.innerHTML = `
      <span class="car-chip-mark" aria-hidden="true"></span>
      <span class="car-chip-copy">
        <strong>${car.short || (car.model.length <= 10 ? car.model : car.model.split(' ')[0])}</strong>
        <small>${car.year}</small>
      </span>
    `;
    btn.addEventListener('click', () => selectCar(car.id));
    dom.carStrip.appendChild(btn);
  });
  if (dom.carCount) dom.carCount.textContent = String(CARS.length);
  setActiveCar(CONFIG.initialCar);
}

function buildLibrary() {
  if (!dom.libraryBody) return;
  const groups = new Map();
  CARS.forEach((car) => {
    if (!groups.has(car.brand)) groups.set(car.brand, []);
    groups.get(car.brand).push(car);
  });
  dom.libraryBody.innerHTML = '';
  for (const [brand, cars] of groups) {
    const section = document.createElement('section');
    section.className = 'library-group';
    const head = document.createElement('h3');
    head.innerHTML = `${brand}<span>${cars.length}</span>`;
    section.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'library-grid';
    for (const car of cars) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'library-item';
      card.dataset.car = car.id;
      card.style.setProperty('--car-accent', car.accent);
      card.title = car.tagline;
      card.innerHTML = `
        <span class="library-mark" aria-hidden="true"></span>
        <strong>${car.model}</strong>
        <small>${car.zhName}</small>
        <span class="library-meta"><em>${car.year}</em><em>${car.partCount} 零件</em></span>
      `;
      card.addEventListener('click', () => {
        selectCar(car.id);
        closeLibrary();
      });
      grid.appendChild(card);
    }
    section.appendChild(grid);
    dom.libraryBody.appendChild(section);
  }
  if (dom.libraryCount) dom.libraryCount.textContent = String(CARS.length);
}

function openLibrary() {
  if (!dom.library) return;
  dom.library.classList.add('show');
  dom.library.setAttribute('aria-hidden', 'false');
  document.querySelector('.library-item.is-active')?.scrollIntoView({ block: 'center' });
}

function closeLibrary() {
  if (!dom.library) return;
  dom.library.classList.remove('show');
  dom.library.setAttribute('aria-hidden', 'true');
}

function setActiveCar(id) {
  document.querySelectorAll('.car-chip, .library-item').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.car === id);
  });
  const active = dom.carStrip?.querySelector(`[data-car="${id}"]`);
  if (active) {
    setTimeout(() => active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }), 60);
  }
}

function scrollCarStrip(direction) {
  dom.carStrip?.scrollBy({ left: direction * 280, behavior: 'smooth' });
}

function updateCredit(car) {
  if (!dom.creditNote || !car) return;
  dom.creditNote.innerHTML = `
    <strong>${car.fullName}</strong> · ${car.author} ·
    <a href="${car.sourcePage}" target="_blank" rel="noopener noreferrer">Sketchfab 原始模型</a> ·
    <a href="${car.licenseUrl}" target="_blank" rel="noopener noreferrer">${car.license}</a>
    <br><span>模型由第三方作者以 ${car.license} 许可提供；本应用仅做格式转换与纹理压缩。</span>
  `;
}

function showLoadingForCar(car) {
  if (!dom.loading) return;
  dom.loading.classList.remove('is-done', 'is-preview', 'hidden');
  dom.loadingBar.style.width = '0%';
  dom.loadingPct.textContent = '0%';
  dom.loadingLabel.textContent = `正在载入 ${car.zhName}`;
}

async function selectCar(id) {
  if (!state.viewer) return;
  const car = CARS.find((item) => item.id === id);
  if (!car) return;
  if (state.viewer.currentCar?.id === id) return;
  showLoadingForCar(car);
  try {
    await state.viewer.loadCar(id);
    const url = new URL(location.href);
    url.searchParams.set('car', id);
    history.replaceState(null, '', url);
  } catch (err) {
    console.error(err);
    dom.loading.classList.add('is-done');
    dom.errorPanel.classList.add('show');
    dom.errorText.textContent = err?.message || String(err);
  }
}

function applyPaint(index) {
  if (!state.viewer) return;
  if (state.viewer.paintable === false) {
    showToast('该车型使用烘焙贴图，车漆工艺不可用');
    return;
  }
  state.paintIndex = index;
  state.customColor = null;
  state.viewer.setPaint(index);
  $$('.paint-option').forEach((el) => el.classList.toggle('is-active', Number(el.dataset.index) === index));
  const p = PAINTS[index];
  dom.paintCaption.innerHTML = `<strong>${p.name}</strong><span>${p.desc}</span><small>460 ms 缓动过渡 · MeshPhysicalMaterial</small>`;
}

function categoryList() {
  const set = new Set(state.parts.map((p) => p.category));
  return ['全部', ...['外饰', '灯光', '车轮', '内饰', '底盘', '空气动力学', '玻璃', '其他'].filter((c) => set.has(c))];
}

function buildFilters() {
  dom.filters.innerHTML = '';
  for (const cat of categoryList()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-chip' + (cat === state.category ? ' is-active' : '');
    btn.textContent = cat;
    btn.dataset.cat = cat;
    btn.addEventListener('click', () => {
      state.category = cat;
      $$('.filter-chip').forEach((b) => b.classList.toggle('is-active', b.dataset.cat === cat));
      renderParts();
    });
    dom.filters.appendChild(btn);
  }
}

function partSearchText(p) {
  return `${p.label} ${p.id} ${p.category}`.toLowerCase();
}

function renderParts() {
  const q = state.query.trim().toLowerCase();
  state.filtered = state.parts.filter((p) => {
    const catOk = state.category === '全部' || p.category === state.category;
    const queryOk = !q || partSearchText(p).includes(q);
    return catOk && queryOk;
  });
  dom.partsList.innerHTML = '';
  if (!state.filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'parts-empty';
    empty.textContent = '没有匹配的零件';
    dom.partsList.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  state.filtered.forEach((p) => {
    const idx = state.parts.indexOf(p) + 1;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'part-item' + (p.id === state.selectedId ? ' is-selected' : '');
    btn.dataset.id = p.id;
    btn.innerHTML = `
      <span class="part-index">${String(idx).padStart(3, '0')}</span>
      <span class="part-dot" style="--dot:${CAT_COLORS[p.category] || '#9aa0aa'}"></span>
      <span class="part-name">${p.label}<em>${p.sourceName || p.id}</em></span>
      <span class="part-tri">${(p.triangles / 1000).toFixed(1)}k</span>
    `;
    btn.addEventListener('click', () => selectPart(p.id));
    btn.addEventListener('dblclick', () => { selectPart(p.id); state.viewer.focusPart(p.id); });
    btn.addEventListener('pointerenter', () => state.viewer.hoverPart(p.id));
    btn.addEventListener('pointerleave', () => state.viewer.hoverPart(null));
    frag.appendChild(btn);
  });
  dom.partsList.appendChild(frag);
}

function selectPart(id) {
  if (!state.viewer) return;
  state.selectedId = id;
  state.viewer.select(id);
  $$('.part-item').forEach((el) => el.classList.toggle('is-selected', el.dataset.id === id));
  const item = dom.partsList.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showInspector(meta, record) {
  if (!meta) {
    dom.inspectorEmpty.classList.remove('hidden');
    dom.inspectorContent.classList.add('hidden');
    state.selectedId = null;
    $$('.part-item').forEach((el) => el.classList.remove('is-selected'));
    return;
  }
  dom.inspectorEmpty.classList.add('hidden');
  dom.inspectorContent.classList.remove('hidden');
  const idx = state.parts.findIndex((p) => p.id === meta.id) + 1;
  const tris = record?.triangles || 0;
  const materialLabel = meta.paint ? '车漆 / 清漆层' : materialLabelFor(meta);
  $('#inspect-index').textContent = String(idx).padStart(3, '0');
  $('#inspect-name').textContent = meta.label;
  $('#inspect-id').textContent = meta.sourceName || meta.id;
  $('#inspect-category').textContent = meta.category;
  $('#inspect-material').textContent = materialLabel;
  $('#inspect-triangles').textContent = tris.toLocaleString('en-US');
  $('#inspect-vertices').textContent = (record?.vertices || 0).toLocaleString('en-US');
  $('#inspect-dot').style.background = CAT_COLORS[meta.category] || '#9aa0aa';
}

function materialLabelFor(meta) {
  if (meta.category === '玻璃') return '汽车玻璃 / 低辐射镀膜';
  if (meta.category === '车轮') {
    if (/tyre|tire/i.test(meta.label)) return '高性能轮胎 / 橡胶';
    if (/rim|轮毂/i.test(meta.label)) return '锻造铝合金 / 轮辋';
    if (/caliper|卡钳/i.test(meta.label)) return '铝合金制动卡钳';
    if (/rotor|disc|刹车盘/i.test(meta.label)) return '碳陶 / 通风制动盘';
    return '车轮总成';
  }
  if (meta.materialText) {
    const first = String(meta.materialText).split(' / ')[0];
    if (first) return first;
  }
  if (meta.category === '内饰') return '皮革 / Alcantara / 工程塑料';
  if (meta.category === '底盘') return '铝合金 / 高强度钢';
  return '工程复合材料';
}

function updateStats(stats) {
  if (!stats) return;
  if (stats.fps !== undefined) dom.hudFps.textContent = `${stats.fps} FPS`;
  if (stats.drawCalls !== undefined) dom.hudDraw.textContent = `${stats.drawCalls} draws`;
  if (stats.trianglesRendered !== undefined) dom.hudTris.textContent = `${(stats.trianglesRendered / 1000).toFixed(0)}k tris`;
  if (stats.parts) dom.metricParts.textContent = stats.parts;
  if (stats.compressedBytes) dom.metricCompressed.textContent = formatBytes(stats.compressedBytes);
  if (stats.sourceBytes) dom.metricSize.textContent = formatBytes(stats.sourceBytes);
  if (stats.triangles) dom.metricTris.textContent = `${Math.round(stats.triangles / 1000).toLocaleString('en-US')}k`;
}

function setExplode(value) {
  const v = Math.max(0, Math.min(1, value));
  state.viewer.setExplode(v);
  dom.explodeSlider.value = String(Math.round(v * 100));
  dom.explodeSlider.style.setProperty('--p', `${Math.round(v * 100)}%`);
  dom.explodeValue.textContent = `${Math.round(v * 100)}%`;
  dom.btnExplodePlay.classList.toggle('is-active', v > 0.5);
}

function stepCar(delta) {
  const id = state.viewer?.currentCar?.id;
  const index = CARS.findIndex((car) => car.id === id);
  if (index < 0) return;
  const next = CARS[(index + delta + CARS.length) % CARS.length];
  selectCar(next.id);
}

function stepPart(delta) {
  const list = state.filtered.length ? state.filtered : state.parts;
  if (!list.length) return;
  const index = list.findIndex((part) => part.id === state.selectedId);
  const next = index < 0
    ? list[delta > 0 ? 0 : list.length - 1]
    : list[(index + delta + list.length) % list.length];
  selectPart(next.id);
  state.viewer.focusPart(next.id);
}

function bindUI() {
  dom.partSearch.addEventListener('input', () => {
    state.query = dom.partSearch.value;
    renderParts();
  });
  dom.explodeSlider.addEventListener('input', () => {
    setExplode(Number(dom.explodeSlider.value) / 100);
  });
  dom.btnExplodePlay.addEventListener('click', () => {
    const target = state.viewer.explodeTarget > 0.5 ? 0 : 1;
    setExplode(target);
    showToast(target ? '演示模式 · 零件正在展开' : '零件已复位');
  });
  dom.btnScene?.addEventListener('click', () => {
    const next = state.viewer.garageStyle === 'garage' ? 'studio' : 'garage';
    state.viewer.setSceneStyle(next);
    const isGarage = next === 'garage';
    dom.btnSceneLabel.textContent = isGarage ? '车库' : '影棚';
    dom.btnScene.classList.toggle('is-active', isGarage);
    dom.btnScene.setAttribute('aria-pressed', String(isGarage));
    showToast(isGarage ? '场景：车库' : '场景：无缝影棚');
  });
  dom.btnExplore?.addEventListener('click', () => openCharacterModal());
  dom.characterClose?.addEventListener('click', closeCharacterModal);
  dom.characterModal?.addEventListener('click', (e) => {
    if (e.target === dom.characterModal) closeCharacterModal();
  });
  dom.exploreExit?.addEventListener('click', () => state.viewer.exitExplore());
  dom.exploreSwitch?.addEventListener('click', () => openCharacterModal());
  dom.exploreSpawn?.addEventListener('click', () => {
    state.viewer.characterMode?.respawn();
    showToast('已回到出生点');
  });
  dom.exploreDrive?.addEventListener('click', () => {
    if (state.viewer.characterMode?.canEnterCar()) startDrive();
    else showToast('走到车库里的车旁，再上车');
  });
  dom.carHintEnter?.addEventListener('click', () => {
    if (state.viewer.characterMode?.canEnterCar()) startDrive();
    else showToast('走到车旁再上车');
  });
  dom.btnDrive?.addEventListener('click', startDrive);
  dom.btnPhoto?.addEventListener('click', startPhoto);
  dom.btnLift?.addEventListener('click', toggleLift);
  dom.driveExit?.addEventListener('click', () => state.viewer.exitDrive({ force: true }));
  dom.driveSound?.addEventListener('click', () => {
    const dm = state.viewer.drivingMode;
    if (!dm) return;
    dm.muted = !dm.muted;
    dom.driveSound.classList.toggle('is-on', !dm.muted);
    showToast(dm.muted ? '引擎声：关闭' : '引擎声：开启');
  });
  dom.photoExit?.addEventListener('click', () => state.viewer.exitPhoto());
  dom.photoGuide?.addEventListener('click', () => {
    const pm = state.viewer.photoMode;
    if (!pm) return;
    const on = pm.toggleGuide();
    dom.photoGuides?.classList.toggle('show', on);
    dom.photoGuide?.classList.toggle('is-on', on);
  });
  dom.photoShot?.addEventListener('click', () => state.viewer.photoMode?.shot());
  dom.photoRecord?.addEventListener('click', () => state.viewer.photoMode?.toggleRecording());
  dom.btnRotate.addEventListener('click', () => {
    const on = state.viewer.toggleAutoRotate();
    dom.btnRotate.classList.toggle('is-active', on);
    dom.btnRotate.setAttribute('aria-pressed', String(on));
    showToast(on ? '自动旋转已开启' : '自动旋转已关闭');
  });
  dom.btnReset.addEventListener('click', () => {
    state.viewer.resetView();
    setExplode(0);
    state.viewer.clearSelection();
    showInspector(null);
    showToast('视图已重置');
  });
  dom.btnFit.addEventListener('click', () => {
    state.viewer.fitView({ animate: true, duration: 550, padding: 1.7 });
    showToast('已自动构图至最佳视野');
  });
  dom.btnLibrary?.addEventListener('click', openLibrary);
  dom.libraryClose?.addEventListener('click', closeLibrary);
  dom.library?.addEventListener('click', (e) => {
    if (e.target === dom.library) closeLibrary();
  });
  dom.viewPresets.forEach((btn) => {
    btn.addEventListener('click', () => {
      // A preset that immediately drifts away is not a preset.
      if (state.viewer.autoRotate) {
        state.viewer.toggleAutoRotate(false);
        dom.btnRotate.classList.remove('is-active');
        dom.btnRotate.setAttribute('aria-pressed', 'false');
      }
      state.viewer.setView(btn.dataset.view || 'hero', { animate: true });
      dom.viewPresets.forEach((b) => b.classList.toggle('is-active', b === btn));
      if (btn.dataset.view === 'under') {
        dom.btnLift?.classList.add('is-active');
        showToast('底盘视角 · 两柱举升机升起');
      } else {
        dom.btnLift?.classList.toggle('is-active', state.viewer.isLiftRaised());
      }
    });
  });
  dom.skyPresets.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.sky || 'day';
      dom.skyPresets.forEach((b) => b.classList.toggle('is-active', b === btn));
      await state.viewer.setSkyTime(id);
      const name = { day: '白天', dusk: '阴天', night: '夜晚' }[id] || id;
      showToast(`天光：${name}`);
    });
  });
  dom.btnLights?.addEventListener('click', () => {
    const on = !state.viewer.partyLightsOn;
    state.viewer.setPartyLights(on);
    dom.btnLights.classList.toggle('is-active', on);
    dom.btnLights.setAttribute('aria-pressed', on ? 'true' : 'false');
    showToast(on ? '彩灯：开启（霓虹灯管 + 彩色环境光）' : '彩灯：关闭');
  });
  // A long strip of 28 cars is awkward to scroll with the tiny scrollbar.
  dom.carStrip?.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    dom.carStrip.scrollLeft += e.deltaY;
  }, { passive: false });
  dom.btnHelp.addEventListener('click', () => dom.helpModal.classList.add('show'));
  dom.helpClose.addEventListener('click', () => dom.helpModal.classList.remove('show'));
  dom.carPrev?.addEventListener('click', () => scrollCarStrip(-1));
  dom.carNext?.addEventListener('click', () => scrollCarStrip(1));
  dom.helpModal.addEventListener('click', (e) => {
    if (e.target === dom.helpModal) dom.helpModal.classList.remove('show');
  });
  dom.btnFullscreen.addEventListener('click', async () => {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    else await document.exitFullscreen?.();
  });
  $('#inspect-focus')?.addEventListener('click', () => {
    if (state.selectedId) state.viewer.focusPart(state.selectedId);
  });
  $('#inspect-isolate')?.addEventListener('click', () => {
    if (!state.selectedId) return;
    state.viewer.setIsolate(state.selectedId);
    dom.isolateChip.classList.add('show');
  });
  dom.isolateExit.addEventListener('click', () => {
    state.viewer.clearIsolation();
    dom.isolateChip.classList.remove('show');
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches?.('input, textarea')) return;
    // In city-exploration mode the character controller owns the keyboard
    // (WASD / Shift / Space / R / Esc); the garage shortcuts must not fire.
    if (document.body.classList.contains('is-exploring')) {
      if (e.key === 'Escape' && dom.characterModal?.classList.contains('show')) {
        e.stopImmediatePropagation();
        closeCharacterModal();
      }
      if (e.key.toLowerCase() === 'p') startPhoto();
      else if (e.key.toLowerCase() === 'v') {
        if (state.viewer.characterMode?.canEnterCar()) startDrive();
        else showToast('走到车旁再上车');
      }
      return;
    }
    if (document.body.classList.contains('is-driving') || document.body.classList.contains('is-photo')) return;
    if (e.key >= '0' && e.key <= '9') {
      const index = e.key === '0' ? 9 : Number(e.key) - 1;
      if (index < PAINTS.length) applyPaint(index);
    } else if (e.key === '-') applyPaint(10);
    else if (e.key === '=') applyPaint(11);
    else if (e.key.toLowerCase() === 'e') {
      setExplode(state.viewer.explodeTarget > 0.5 ? 0 : 1);
    } else if (e.key.toLowerCase() === 'r') dom.btnReset.click();
    else if (e.key.toLowerCase() === 'f') dom.btnFit.click();
    else if (e.key.toLowerCase() === 'a') dom.btnRotate.click();
    else if (e.key.toLowerCase() === 'v') startDrive();
    else if (e.key.toLowerCase() === 'p') startPhoto();
    else if (e.key.toLowerCase() === 'g') toggleLift();
    else if (e.key.toLowerCase() === 'l') {
      if (dom.library.classList.contains('show')) closeLibrary();
      else openLibrary();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      stepCar(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      stepPart(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape') {
      if (dom.characterModal?.classList.contains('show')) closeCharacterModal();
      else if (dom.library.classList.contains('show')) closeLibrary();
      else if (dom.helpModal.classList.contains('show')) dom.helpModal.classList.remove('show');
      else if (state.viewer.isolated) { state.viewer.clearIsolation(); dom.isolateChip.classList.remove('show'); }
      else state.viewer.clearSelection();
    }
  });
}

function setLoading(label, progress, extra = {}) {
  dom.loadingLabel.textContent = label;
  const pct = Math.round(progress * 100);
  dom.loadingPct.textContent = `${pct}%`;
  dom.loadingBar.style.width = `${pct}%`;
  if (extra.preview) dom.loading.classList.add('is-preview');
}

function wireViewer() {
  const callbacks = {
    onStage: (label, progress, extra) => setLoading(label, progress, extra),
    onCarChange: (car) => {
      setActiveCar(car.id);
      updateCredit(car);
      state.parts = [];
      state.selectedId = null;
      state.query = '';
      dom.partSearch.value = '';
      dom.partsList.innerHTML = '';
      dom.filters.innerHTML = '';
      if (dom.brandSub) dom.brandSub.textContent = `${car.brand} ${car.model} · 3D Exploded View`;
      document.title = `CTViewer · ${car.fullName}`;
    },
    onManifest: (manifest) => {
      const parts = manifest.parts || [];
      state.parts = parts;
      const count = manifest.partCount || parts.length;
      dom.metricParts.textContent = String(count);
      if (dom.summaryParts) dom.summaryParts.textContent = String(count);
      if (dom.summaryCount) dom.summaryCount.textContent = String(count);
      dom.metricSize.textContent = manifest.sourceBytes ? formatBytes(manifest.sourceBytes) : '—';
      dom.metricTris.textContent = manifest.triangles
        ? `${Math.round(manifest.triangles / 1000)}k`
        : '—';
      if (parts.length) {
        buildFilters();
        renderParts();
      }
    },
    onModel: () => {
      state.ready = true;
      const paintable = state.viewer.paintable !== false;
      dom.paintList.classList.toggle('is-disabled', !paintable);
      dom.paintList.querySelectorAll('button').forEach((b) => { b.disabled = !paintable; });
      if (!paintable) dom.paintCaption.innerHTML = '<strong>烘焙贴图车型</strong><span>该车型没有独立车漆材质，车漆工艺不可用。</span>';
      dom.statusLabel.textContent = '本地离线 · 已就绪';
      dom.statusLabel.parentElement.classList.add('is-ready');
    },
    onReady: (stats) => {
      updateStats(stats);
      applyPaint(state.paintIndex);
      if (state.customColor) state.viewer.paint?.setColor(state.customColor);
      applyBootParams();
      dom.loading.classList.add('is-done');
      showToast(`${state.viewer.currentCar?.fullName || '车型'} · ${state.parts.length} 个零件已就绪`, 2600);
      if (!state.hinted) {
        state.hinted = true;
        try {
          if (!localStorage.getItem('ctviewer-hint')) {
            localStorage.setItem('ctviewer-hint', '1');
            setTimeout(() => showToast('拖拽旋转 · 点击零件查看 · ↑/↓ 逐个检视 · L 车型库', 4200), 2800);
          }
        } catch (_) { /* storage unavailable */ }
      }
    },
    onStats: updateStats,
    onPaintChange: (index) => {
      const preset = PAINTS[index];
      if (!preset) return;
      dom.paintCaption.innerHTML = `<strong>${preset.name}</strong><span>${preset.desc}</span><small>460 ms 缓动过渡 · MeshPhysicalMaterial</small>`;
    },
    onSelect: (meta, record) => showInspector(meta, record),
    // Canvas picks (clicking the car) only fire onSelectionChange, so the
    // parts list, 聚焦零件 and 隔离查看 all key off this callback.
    onSelectionChange: (id) => {
      state.selectedId = id;
      $$('.part-item').forEach((el) => el.classList.toggle('is-selected', el.dataset.id === id));
      if (!id) return;
      const item = dom.partsList.querySelector(`[data-id="${CSS.escape(id)}"]`);
      item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    onHover: (meta, pos) => {
      if (!meta) {
        dom.tooltip.classList.remove('show');
        return;
      }
      dom.tooltip.innerHTML = `<span class="tooltip-cat" style="--dot:${CAT_COLORS[meta.category] || '#9aa0aa'}">${meta.category}</span><strong>${meta.label}</strong><small>${meta.sourceName || meta.id}</small>`;
      dom.tooltip.classList.add('show');
      const pad = 16;
      const rect = dom.tooltip.getBoundingClientRect();
      let x = pos.x + pad;
      let y = pos.y + pad;
      if (x + rect.width > window.innerWidth - 12) x = pos.x - rect.width - pad;
      if (y + rect.height > window.innerHeight - 12) y = pos.y - rect.height - pad;
      dom.tooltip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    },
    onIsolate: (meta) => {
      if (!meta) dom.isolateChip.classList.remove('show');
    },
    onExploreExit: () => exitExploreUI(),
    onExplodeReset: () => {
      dom.explodeSlider.value = '0';
      dom.explodeSlider.style.setProperty('--p', '0%');
      dom.explodeValue.textContent = '0%';
      dom.btnExplodePlay.classList.remove('is-active');
    },
    onDriveExit: () => exitDriveUI(),
    onPhotoExit: () => exitPhotoUI(),
  };

  state.viewer = new CTViewer($('#scene'), callbacks);
  state.viewer.init().catch((err) => {
    window.__CTVIEWER_ERROR__ = err?.stack || String(err);
    console.error(err);
    dom.loading.classList.add('is-done');
    dom.errorPanel.classList.add('show');
    dom.errorText.textContent = err?.message || String(err);
  });

  window.__CTVIEWER__ = {
    viewer: state.viewer,
    ready: () => state.viewer.ready,
    setPaint: (index) => applyPaint(index),
    setExplode: (v) => setExplode(v),
    selectPart: (id) => selectPart(id),
    clearSelection: () => state.viewer.clearSelection(),
    getState: () => state.viewer.getStats(),
    getPartIds: () => (state.viewer.parts || []).map((p) => p.id),
    getParts: () => state.viewer.parts || [],
    setAutoRotate: (on) => state.viewer.toggleAutoRotate(on),
    fitView: () => state.viewer.fitView({ animate: true }),
    loadCar: (id) => selectCar(id),
    startExplore: (id) => startExplore(id),
    exitExplore: () => state.viewer.exitExplore(),
    startDrive: () => startDrive(),
    exitDrive: () => state.viewer.exitDrive({ force: true }),
    startPhoto: () => startPhoto(),
    exitPhoto: () => state.viewer.exitPhoto(),
    toggleLift: () => toggleLift(),
    setLift: (on) => state.viewer.setLiftRaised(on),
    getDrive: () => ({
      active: Boolean(state.viewer.driveActive),
      pos: state.viewer.drivingMode
        ? [state.viewer.drivingMode.pos.x, state.viewer.drivingMode.pos.y]
        : null,
      yaw: state.viewer.drivingMode?.yaw,
      kmh: state.viewer.drivingMode
        ? Math.round(Math.abs(state.viewer.drivingMode.forwardSpeed()) * 3.6)
        : 0,
      gear: state.viewer.drivingMode?.telemetry().gear,
    }),
    getPhoto: () => ({
      active: Boolean(state.viewer.photoActive),
      filter: state.viewer.photoMode?.filter,
      pos: state.viewer.photoMode?.pos.toArray(),
    }),
    getExplore: () => ({
      active: state.exploring,
      id: state.characterId,
      pos: state.viewer.characterMode?.pos.toArray(),
      clips: state.characters?.clips.length || 0,
    }),
  };
}

const bootParams = new URLSearchParams(location.search);

// Deep links are applied once the first car is ready. A timer can fire before
// the model exists - or before _finishLoad resets the explode state - which
// silently drops `?explode` / `?part` on slow devices.
let bootApplied = false;
function applyBootParams() {
  if (bootApplied) return;
  bootApplied = true;
  const paint = PAINTS.findIndex((p) => p.id === bootParams.get('paint'));
  if (paint >= 0) applyPaint(paint);
  if (bootParams.get('explode')) setExplode(Number(bootParams.get('explode')));
  if (bootParams.get('part')) selectPart(bootParams.get('part'));
  if (bootParams.get('view')) state.viewer.setView(bootParams.get('view'), { animate: false });
  if (CONFIG.partyLights) {
    state.viewer.setPartyLights(true);
    dom.btnLights?.classList.add('is-active');
    dom.btnLights?.setAttribute('aria-pressed', 'true');
  }
  const exploreId = bootParams.get('explore');
  if (exploreId) startExplore(exploreId);
  if (bootParams.get('lift') === '1') setTimeout(toggleLift, 900);
  if (bootParams.get('drive') === '1') setTimeout(startDrive, 900);
  if (bootParams.get('photo') === '1') setTimeout(startPhoto, 900);
}

function boot() {
  if (dom.btnSceneLabel) {
    dom.btnSceneLabel.textContent = CONFIG.sceneStyle === 'garage' ? '车库' : '影棚';
    dom.btnScene?.classList.toggle('is-active', CONFIG.sceneStyle === 'garage');
  }
  buildPaintUI();
  buildCarUI();
  buildLibrary();
  updateCredit(CARS[0]);
  bindUI();
  wireViewer();
}

if (bootParams.get('nosw') === '1' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
  if (window.caches) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
}
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && location.hostname !== 'appassets.local' && bootParams.get('nosw') !== '1') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
  });
}

boot();
