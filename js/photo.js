/**
 * Photo / recording mode.
 *
 * A free-fly camera that reuses the scene exactly as it stands (same paint,
 * same garage, same character) plus a small set of graded looks.  Filters are
 * CSS filter strings: the live canvas previews them directly, screenshots bake
 * them through a 2D canvas, and the recorder pipes rendered frames through the
 * same 2D canvas so the exported WebM matches the preview.
 *
 * Frames are grabbed immediately after `renderer.render()` in the main loop.
 * Reading a WebGL canvas in another task would come back blank because the
 * drawing buffer is not preserved.
 */
import * as THREE from 'three';

export const PHOTO_FILTERS = [
  { id: 'none', name: '原片', css: 'none' },
  { id: 'warm', name: '暖阳', css: 'saturate(1.12) contrast(1.04) sepia(0.16) brightness(1.03)' },
  { id: 'cool', name: '冷调', css: 'saturate(0.92) hue-rotate(12deg) contrast(1.06) brightness(1.03)' },
  { id: 'mono', name: '黑白', css: 'grayscale(1) contrast(1.18)' },
  { id: 'vintage', name: '复古', css: 'sepia(0.42) contrast(0.94) brightness(1.06) saturate(0.85)' },
  { id: 'neon', name: '霓虹', css: 'saturate(1.65) contrast(1.16) hue-rotate(-8deg)' },
  { id: 'hard', name: '高反差', css: 'contrast(1.38) saturate(0.92) brightness(0.98)' },
  { id: 'fade', name: '褪色', css: 'saturate(0.55) brightness(1.1) contrast(0.9)' },
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class PhotoMode {
  constructor(viewer) {
    this.viewer = viewer;
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.05, 3000);
    this.active = false;
    this.filter = 'none';
    this.guide = true;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.dragging = false;
    this.lastPointer = { x: 0, y: 0 };
    this.recording = false;
    this._rec = null;
    this._chunks = [];
    this._recStart = 0;
    this._grab = null;
    this._wantShot = false;
    this._resumeCharacter = false;
    this.onToast = null;
    this.onState = null;
    this._bindInput();
  }

  _bindInput() {
    this._onKeyDown = (e) => {
      if (!this.active) return;
      if (e.target.matches?.('input, textarea')) return;
      const code = e.code;
      if (code === 'Escape' || code === 'KeyP') {
        e.preventDefault();
        this.onRequestExit?.();
        return;
      }
      if (code === 'KeyG') {
        this.guide = !this.guide;
        this.onState?.({ guide: this.guide });
        return;
      }
      if (code === 'KeyF') {
        this.shot();
        return;
      }
      if (code === 'KeyR') {
        this.toggleRecording();
        return;
      }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(code)) {
        e.preventDefault();
        this.keys.add(code);
      }
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());

    const canvas = this.viewer.canvas;
    this._onPointerDown = (e) => {
      if (!this.active || e.button !== 0) return;
      this.dragging = true;
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    this._onPointerMove = (e) => {
      if (!this.active || !this.dragging) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;
      this.yaw -= dx * 0.0042;
      this.pitch = clamp(this.pitch - dy * 0.0036, -1.45, 1.45);
    };
    this._onPointerUp = (e) => {
      this.dragging = false;
      canvas.style.cursor = this.active ? 'crosshair' : '';
      canvas.releasePointerCapture?.(e.pointerId);
    };
    this._onWheel = (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.camera.fov = clamp(this.camera.fov + Math.sign(e.deltaY) * 2.5, 16, 85);
      this.camera.updateProjectionMatrix();
    };
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
  }

  enter() {
    const viewer = this.viewer;
    const source = viewer.exploreActive && viewer.characterMode
      ? viewer.characterMode.camera
      : viewer.camera;
    this.pos.copy(source.position);
    const euler = new THREE.Euler().setFromQuaternion(source.quaternion, 'YXZ');
    this.yaw = euler.y;
    this.pitch = euler.x;
    this.keys.clear();
    this.active = true;
    viewer.photoActive = true;
    viewer.controls.enabled = false;
    viewer.cameraTween = null;
    this._resumeCharacter = Boolean(viewer.exploreActive && viewer.characterMode?.active);
    if (this._resumeCharacter) viewer.characterMode.active = false;
    document.body.classList.add('is-photo');
    this._applyFilter();
    this._syncCamera();
    this._resize();
    this.onState?.({ active: true, filter: this.filter, guide: this.guide });
    return { filter: this.filter };
  }

  exit() {
    if (!this.active) return;
    if (this.recording) this.stopRecording();
    this.active = false;
    this.keys.clear();
    this.dragging = false;
    this.viewer.photoActive = false;
    this.viewer.renderer.domElement.style.filter = '';
    this.viewer.canvas.style.cursor = '';
    document.body.classList.remove('is-photo');
    if (this._resumeCharacter && this.viewer.characterMode) {
      this.viewer.characterMode.active = true;
      this.viewer.characterMode.keys.clear();
    }
    this._resumeCharacter = false;
    this.viewer.controls.enabled = !this.viewer.exploreActive;
    this.onState?.({ active: false });
  }

  setFilter(id) {
    if (!PHOTO_FILTERS.some((f) => f.id === id)) return;
    this.filter = id;
    this._applyFilter();
    this.onState?.({ filter: id });
  }

  _applyFilter() {
    const preset = PHOTO_FILTERS.find((f) => f.id === this.filter) || PHOTO_FILTERS[0];
    this.viewer.renderer.domElement.style.filter = preset.css === 'none' ? '' : preset.css;
  }

  toggleGuide(force) {
    this.guide = force === undefined ? !this.guide : Boolean(force);
    this.onState?.({ guide: this.guide });
    return this.guide;
  }

  update(dt) {
    if (!this.active) return;
    const k = this.keys;
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 3.2 : 1;
    const speed = 5.2 * boost;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const move = new THREE.Vector3();
    if (k.has('KeyW')) move.add(forward);
    if (k.has('KeyS')) move.sub(forward);
    if (k.has('KeyD')) move.add(right);
    if (k.has('KeyA')) move.sub(right);
    if (k.has('KeyE')) move.y += 1;
    if (k.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed * dt);
      this.pos.add(move);
      this.pos.y = clamp(this.pos.y, 0.12, 120);
      const r = Math.hypot(this.pos.x, this.pos.z);
      if (r > 600) {
        this.pos.x *= 600 / r;
        this.pos.z *= 600 / r;
      }
    }
    this._syncCamera();
    if (this.recording) {
      const left = 10 - (performance.now() - this._recStart) / 1000;
      this.onState?.({ recording: true, left: Math.max(0, left) });
      if (left <= 0) this.stopRecording();
    }
  }

  _syncCamera() {
    this.camera.position.copy(this.pos);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  /** Called by the main loop immediately after the scene was rendered. */
  afterRender() {
    if (!this.active) return;
    if (this._wantShot) {
      this._wantShot = false;
      this._capturePhoto();
    }
    if (this.recording && this._grab) {
      const src = this.viewer.renderer.domElement;
      const ctx = this._grab.getContext('2d');
      const preset = PHOTO_FILTERS.find((f) => f.id === this.filter) || PHOTO_FILTERS[0];
      ctx.filter = preset.css === 'none' ? 'none' : preset.css;
      ctx.drawImage(src, 0, 0, this._grab.width, this._grab.height);
    }
  }

  shot() {
    if (!this.active) return;
    this._wantShot = true;
    this.onToast?.('正在保存照片…');
  }

  _capturePhoto() {
    const src = this.viewer.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    const preset = PHOTO_FILTERS.find((f) => f.id === this.filter) || PHOTO_FILTERS[0];
    ctx.filter = preset.css === 'none' ? 'none' : preset.css;
    ctx.drawImage(src, 0, 0, out.width, out.height);
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `ctviewer-${this.viewer.currentCar?.id || 'car'}-${stamp}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.onToast?.('照片已保存到下载目录');
    }, 'image/png');
  }

  toggleRecording() {
    if (this.recording) this.stopRecording();
    else this.startRecording();
  }

  startRecording() {
    if (!this.active || this.recording) return;
    if (typeof MediaRecorder === 'undefined') {
      this.onToast?.('当前浏览器不支持录像');
      return;
    }
    const src = this.viewer.renderer.domElement;
    // Cap the recording at 1080p: a 4K buffer makes the 2D filter pass and the
    // encoder fight over the same GPU on the laptops this runs on.
    const scale = Math.min(1, 1920 / src.width);
    const out = document.createElement('canvas');
    out.width = Math.round(src.width * scale);
    out.height = Math.round(src.height * scale);
    this._grab = out;
    const stream = out.captureStream(30);
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
    this._chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) this._chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(this._chunks, { type: rec.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `ctviewer-${this.viewer.currentCar?.id || 'car'}-${stamp}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      this._chunks = [];
      this._grab = null;
      this.onToast?.('录像已保存到下载目录');
      this.onState?.({ recording: false });
    };
    rec.start(250);
    this._rec = rec;
    this._recStart = performance.now();
    this.recording = true;
    this.onState?.({ recording: true, left: 10 });
    this.onToast?.('开始录像（最长 10 秒，再按 R 提前结束）');
  }

  stopRecording() {
    if (!this.recording) return;
    this.recording = false;
    try { this._rec?.stop(); } catch (_) { /* already stopped */ }
    this._rec = null;
  }

  onResize() {
    if (!this.active) return;
    this._resize();
  }

  _resize() {
    const size = this.viewer.renderer.getSize(new THREE.Vector2());
    this.camera.aspect = size.x / Math.max(1, size.y);
    this.camera.updateProjectionMatrix();
  }
}
