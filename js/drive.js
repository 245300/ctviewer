/**
 * Test-drive mode: the displayed car becomes drivable.
 *
 * The physics are deliberately arcade rather than a rigid-body simulation:
 * a kinematic bicycle model for the heading, a forward/lateral velocity split
 * for grip, and fixed 1/120 s sub-steps so the behaviour does not change with
 * the frame rate.  That is the same recipe the Unity reference project uses
 * (WheelCollider arcade cars), minus the engine: the city has no ramps or
 * jumps, so a full physics library would only add weight and tuning.
 *
 * Collision reuses the walk-mode world: the two solid garage walls, the
 * workshop prop footprints, the two lift posts, and the city's 1 m occupancy
 * grid.  The car samples its four corners plus the nose/tail centre, so it
 * cannot wedge a corner through a building while the centre still looks clear.
 */
import * as THREE from 'three';

const MAX_SPEED = 55;        // m/s ≈ 198 km/h
const MAX_REVERSE = 10;
const ACCEL = 12.5;
const BRAKE = 26;
const LINEAR_DRAG = 0.16;
const ROLLING = 0.012;
const WHEELBASE = 2.65;
const HALF_LENGTH = 2.3;
const HALF_WIDTH = 0.92;
const MAX_RADIUS = 296;
const STEP = 1 / 120;

const THROTTLE_KEYS = new Set(['KeyW', 'ArrowUp']);
const BRAKE_KEYS = new Set(['KeyS', 'ArrowDown']);
const LEFT_KEYS = new Set(['KeyA', 'ArrowLeft']);
const RIGHT_KEYS = new Set(['KeyD', 'ArrowRight']);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** A tiny procedural engine: no audio asset, tuned against the speed curve. */
class EngineAudio {
  constructor() {
    this.ctx = null;
    this.nodes = null;
    this.muted = false;
  }

  start() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx ||= new Ctx();
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    if (this.nodes) return;
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.8;
    const make = (type, ratio, level) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 60 * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(filter);
      osc.start();
      return osc;
    };
    const low = make('sawtooth', 1, 0.5);
    const high = make('square', 2.01, 0.18);
    const sub = make('sine', 0.5, 0.6);
    filter.connect(gain).connect(ctx.destination);
    this.nodes = { gain, filter, low, high, sub };
  }

  update(rev, load, dt) {
    const n = this.nodes;
    if (!n || !this.ctx) return;
    const t = this.ctx.currentTime;
    const base = 46 + rev * 165;
    n.low.frequency.setTargetAtTime(base, t, 0.06);
    n.high.frequency.setTargetAtTime(base * 2.01, t, 0.06);
    n.sub.frequency.setTargetAtTime(base * 0.5, t, 0.08);
    n.filter.frequency.setTargetAtTime(420 + rev * 1500 + load * 500, t, 0.09);
    const level = this.muted ? 0 : 0.028 + load * 0.045 + rev * 0.02;
    n.gain.gain.setTargetAtTime(level, t, 0.12);
  }

  stop() {
    if (!this.nodes || !this.ctx) return;
    this.nodes.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
  }
}

export class DrivingMode {
  constructor(viewer) {
    this.viewer = viewer;
    this.camera = new THREE.PerspectiveCamera(56, 1, 0.1, 2400);
    this.active = false;
    this.keys = new Set();
    this.pos = new THREE.Vector2(0, 0);
    this.vel = new THREE.Vector2(0, 0);
    this.yaw = 0;
    this.steer = 0;
    this.oob = 1; // 0..1, how far outside the garage deck the car is
    this.camYaw = 0;
    this.camPitch = 0.20;
    this.camDist = 7.4;
    this.dragging = false;
    this.lastPointer = { x: 0, y: 0 };
    this.audio = new EngineAudio();
    this.muted = false;
    this.onTelemetry = null;
    this.onToast = null;
    this._lastTelemetry = 0;
    this._impact = 0;
    this._home = null;
    this._bindInput();
  }

  /* ---------------------------------------------------------------- input */

  _bindInput() {
    this._onKeyDown = (e) => {
      if (!this.active) return;
      if (e.target.matches?.('input, textarea')) return;
      const code = e.code;
      if (code === 'Escape') {
        e.preventDefault();
        this.onRequestExit?.({ force: true });
        return;
      }
      if (code === 'KeyE') {
        e.preventDefault();
        if (Math.abs(this.forwardSpeed()) < 1.6) this.onRequestExit?.();
        else this.onToast?.('请先把车停稳，再按 E 下车');
        return;
      }
      if (code === 'KeyM') {
        this.muted = !this.muted;
        this.onToast?.(this.muted ? '引擎声：关闭' : '引擎声：开启');
        return;
      }
      if (code === 'KeyG') {
        e.preventDefault();
        this.toggleLift();
        return;
      }
      if (code === 'Space' || THROTTLE_KEYS.has(code) || BRAKE_KEYS.has(code)
        || LEFT_KEYS.has(code) || RIGHT_KEYS.has(code)) {
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
      this.camYaw -= dx * 0.006;
      this.camPitch = clamp(this.camPitch + dy * 0.004, -0.05, 0.85);
    };
    this._onPointerUp = (e) => {
      this.dragging = false;
      canvas.style.cursor = this.active ? 'grab' : '';
      canvas.releasePointerCapture?.(e.pointerId);
    };
    this._onWheel = (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.camDist = clamp(this.camDist + Math.sign(e.deltaY) * 0.5, 4.6, 13);
    };
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
  }

  /* ----------------------------------------------------------- lifecycle */

  enter() {
    const viewer = this.viewer;
    const group = viewer.modelGroup;
    this._home = {
      pos: group.position.clone(),
      yaw: group.rotation.y,
      floor: viewer._garageFloorTop || 0,
    };
    this.pos.set(group.position.x, group.position.z);
    // The display car is normalized nose-to-+X, but the garage opens toward
    // +Z (the plaza side); +X is lined with workshop furniture.  Pull out
    // through the open front instead.
    this.yaw = group.rotation.y - Math.PI / 2;
    this.vel.set(0, 0);
    this.steer = 0;
    this.oob = 1;
    this.camYaw = 0;
    this.camPitch = 0.20;
    this.camDist = 7.4;
    this.keys.clear();
    this.active = true;
    viewer.driveActive = true;
    this.onResize();
    viewer.controls.enabled = false;
    viewer.cameraTween = null;
    // A raised lift would start the drive 1.5 m in the air.
    if (viewer.liftHeight > 0.01) viewer.setLiftRaised(false, { instant: true });
    document.body.classList.add('is-driving');
    this.audio.start();
    this.audio.muted = this.muted;
    this._lastTelemetry = 0;
    // The car stays exactly where it is on display: no scripted pull-out, no
    // free metres.  It is turned in place to face the open front of the bay so
    // the first metre of throttle goes somewhere useful, and then it does not
    // move until the driver asks it to.
    const group2 = viewer.modelGroup;
    group2.position.set(this.pos.x, this._groundY(), this.pos.y);
    group2.rotation.y = this.yaw;
    this._syncCamera(1);
    this.onToast?.('已就位 · W 油门 · A/D 转向 · Space 手刹');
    return { carId: viewer.currentCar?.id || null };
  }

  exit({ force = false } = {}) {
    if (!this.active) return;
    if (!force && Math.abs(this.forwardSpeed()) > 1.6) {
      this.onToast?.('请先把车停稳，再按 E 下车');
      return;
    }
    this.active = false;
    this.viewer.driveActive = false;
    this.keys.clear();
    this.dragging = false;
    this.audio.stop();
    document.body.classList.remove('is-driving');
    // Never leave the bay with the car in the air.
    if (this.viewer.liftHeight > 0.01) this.viewer.setLiftRaised(false, { instant: true });
    const group = this.viewer.modelGroup;
    if (this._home) {
      group.position.copy(this._home.pos);
      group.rotation.y = this._home.yaw;
    } else {
      group.position.set(0, this._groundY(), 0);
      group.rotation.y = 0;
    }
    group.visible = true;
    this.viewer.controls.enabled = true;
    this.viewer._applyFloorLift();
    this.viewer.fitView({ animate: true, duration: 650, padding: 1.75 });
  }

  /* ------------------------------------------------------------ physics */

  forwardSpeed() {
    const fx = Math.cos(this.yaw);
    const fz = -Math.sin(this.yaw);
    return this.vel.x * fx + this.vel.y * fz;
  }

  _groundY() {
    const viewer = this.viewer;
    const floor = viewer.garageStyle === 'garage' ? (viewer._garageFloorTop || 0) : 0;
    return floor + (viewer.liftHeight || 0) + 0.002;
  }

  _input() {
    const k = this.keys;
    let throttle = 0;
    if ([...THROTTLE_KEYS].some((c) => k.has(c))) throttle += 1;
    if ([...BRAKE_KEYS].some((c) => k.has(c))) throttle -= 1;
    let steer = 0;
    if ([...RIGHT_KEYS].some((c) => k.has(c))) steer += 1;
    if ([...LEFT_KEYS].some((c) => k.has(c))) steer -= 1;
    return { throttle, steer, handbrake: k.has('Space') };
  }

  toggleLift() {
    const v = this.viewer;
    if (v.liftHeight > 0.05) {
      v.setLiftRaised(false);
      this.onToast?.('两柱举升机下降');
      return;
    }
    if (Math.abs(this.forwardSpeed()) > 0.6 || Math.hypot(this.vel.x, this.vel.y) > 0.6) {
      this.onToast?.('先把车停稳，再按 G 举升');
      return;
    }
    if (Math.hypot(this.pos.x, this.pos.y) > 2.6) {
      this.onToast?.('把车开回车库中央的举升机位（黄色标线）再按 G');
      return;
    }
    // Snap to the bay centre: the arms only line up with the jacking points
    // when the car is on the lift's centre line.
    this.pos.set(0, 0);
    this.yaw = -Math.PI / 2;
    this.vel.set(0, 0);
    v.modelGroup.position.x = 0;
    v.modelGroup.position.z = 0;
    v.modelGroup.rotation.y = this.yaw;
    v.setLiftRaised(true);
    this.onToast?.('两柱举升机升起 · 再按 G 下降');
  }

  update(dt) {
    if (!this.active) return;
    if (this.viewer.liftHeight > 0.02) {
      // Up on the lift: the car must not drive off the arms.
      this.vel.set(0, 0);
      const viewer = this.viewer;
      const targetY = this._groundY();
      viewer.modelGroup.position.y += (targetY - viewer.modelGroup.position.y) * Math.min(1, dt * 8);
      viewer.modelGroup.position.x = this.pos.x;
      viewer.modelGroup.position.z = this.pos.y;
      viewer.modelGroup.rotation.y = this.yaw;
      this._syncCamera(Math.min(1, dt * 7));
      this.onTelemetry?.({
        kmh: 0, gear: 'N', drift: false, impact: 0, muted: this.muted,
        throttle: 0, brake: 0,
      });
      this.audio.update(0.16, 0, dt);
      return;
    }
    const input = this._input();
    let remaining = Math.min(dt, 1 / 12);
    while (remaining > 1e-6) {
      const step = Math.min(remaining, STEP);
      remaining -= step;
      this._step(step, input);
    }
    // Leave the steel deck smoothly instead of dropping 6 cm at the threshold.
    const viewer = this.viewer;
    const inRoom = this._insideRoom(this.pos.x, this.pos.y);
    const target = inRoom ? this._groundY() : 0.002;
    viewer.modelGroup.position.y += (target - viewer.modelGroup.position.y) * Math.min(1, dt * 8);
    viewer.modelGroup.position.x = this.pos.x;
    viewer.modelGroup.position.z = this.pos.y;
    viewer.modelGroup.rotation.y = this.yaw;

    this._syncCamera(Math.min(1, dt * 7));
    this._updateTelemetry(input);
    const speed = Math.abs(this.forwardSpeed());
    const rev = this._rev(speed, input.throttle);
    this.audio.update(rev, Math.abs(input.throttle), dt);
    this._impact = Math.max(0, this._impact - dt * 2.4);
  }

  _step(dt, input) {
    const speed = this.forwardSpeed();
    const absSpeed = Math.abs(speed);
    // Speed-sensitive steering: 36 deg at rest, 6 deg at top speed.  Without
    // this the car snaps sideways at 180 km/h.
    const steerMax = THREE.MathUtils.lerp(0.62, 0.105, clamp(absSpeed / MAX_SPEED, 0, 1));
    const steerTarget = input.steer * steerMax;
    this.steer += (steerTarget - this.steer) * Math.min(1, dt * 7.5);

    // Engine / brake along the heading.
    let fx = Math.cos(this.yaw);
    let fz = -Math.sin(this.yaw);
    let vf = this.vel.x * fx + this.vel.y * fz;
    if (input.throttle > 0) {
      const fade = 1 - clamp(vf / MAX_SPEED, 0, 1) * 0.86;
      vf += ACCEL * fade * dt;
    } else if (input.throttle < 0) {
      if (vf > 0.4) vf -= BRAKE * dt;
      else vf -= ACCEL * 0.55 * dt;
    }
    if (input.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 20 * dt);
    // Drag + rolling resistance (so coasting settles instead of running on).
    vf *= Math.exp(-LINEAR_DRAG * dt);
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), ROLLING * vf * vf * dt + 0.22 * dt);
    vf = clamp(vf, -MAX_REVERSE, MAX_SPEED);

    // Heading: kinematic bicycle, with extra yaw while the handbrake is on.
    // The nose points at +X and a rising yaw turns it toward −Z, which is
    // screen-left from the chase camera.  D (steer > 0) has to be the
    // negative yaw rate or the car steers away from the key.
    const yawRate = -(vf / WHEELBASE) * Math.tan(this.steer) * (input.handbrake ? 1.5 : 1);
    this.yaw += yawRate * dt;
    fx = Math.cos(this.yaw);
    fz = -Math.sin(this.yaw);
    const rx = Math.sin(this.yaw);
    const rz = Math.cos(this.yaw);
    let vl = this.vel.x * rx + this.vel.y * rz;
    // Lateral grip: normal cornering bleeds sideways speed quickly; the
    // handbrake leaves most of it, which is what makes the car slide.
    const grip = input.handbrake ? 0.7 : 7.6;
    vl *= Math.exp(-grip * dt);
    this.vel.set(fx * vf + rx * vl, fz * vf + rz * vl);

    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.y + this.vel.y * dt;
    if (!this._collides(nx, nz, this.yaw)) {
      this.pos.set(nx, nz);
    } else if (!this._collides(nx, this.pos.y, this.yaw)) {
      this.pos.x = nx;
      this.vel.y *= 0.2;
      this.vel.x *= 0.7;
      this._impact = 1;
    } else if (!this._collides(this.pos.x, nz, this.yaw)) {
      this.pos.y = nz;
      this.vel.x *= 0.2;
      this.vel.y *= 0.7;
      this._impact = 1;
    } else {
      // A head-on impact: stop, with a small rebound that reads as a bump.
      this.vel.multiplyScalar(-0.12);
      this._impact = 1;
    }
  }

  _corner(x, z, yaw, lx, lz) {
    return [x + lx * Math.cos(yaw) + lz * Math.sin(yaw),
      z - lx * Math.sin(yaw) + lz * Math.cos(yaw)];
  }

  _collides(x, z, yaw) {
    const probes = [
      [HALF_LENGTH, HALF_WIDTH], [HALF_LENGTH, -HALF_WIDTH],
      [-HALF_LENGTH, HALF_WIDTH], [-HALF_LENGTH, -HALF_WIDTH],
      [HALF_LENGTH, 0], [-HALF_LENGTH, 0],
      [0, HALF_WIDTH], [0, -HALF_WIDTH],
    ];
    for (const [lx, lz] of probes) {
      const [wx, wz] = this._corner(x, z, yaw, lx, lz);
      if (this._blocked(wx, wz)) return true;
    }
    return false;
  }

  _blocked(x, z) {
    if (Math.hypot(x, z) > MAX_RADIUS) return true;
    const viewer = this.viewer;
    const room = viewer._garageRoom;
    if (room) {
      // Only the two glazed walls are solid: the front (+Z) and left (+X)
      // sides are open, which is also the way the car drives out.
      const m = 0.15;
      const wall = 0.55;
      const inFootprint = x > room.min.x - m && x < room.max.x + m
        && z > room.min.z - m && z < room.max.z + m;
      if (inFootprint && (x < room.min.x + wall || z < room.min.z + wall)) return true;
    }
    const props = viewer._garagePropBoxes;
    if (props) {
      for (const box of props) {
        if (x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ) return true;
      }
    }
    return viewer.city?.isBlocked?.(x, z) || false;
  }

  _insideRoom(x, z) {
    const room = this.viewer._garageRoom;
    if (!room) return false;
    return x > room.min.x && x < room.max.x && z > room.min.z && z < room.max.z;
  }

  /* ------------------------------------------------------------- camera */

  _syncCamera(alpha) {
    const car = new THREE.Vector3(this.pos.x, this.viewer.modelGroup.position.y, this.pos.y);
    const a = this.yaw + Math.PI + this.camYaw;
    const cp = Math.cos(this.camPitch);
    const dist = this.camDist;
    const target = new THREE.Vector3(
      car.x + Math.cos(a) * dist * cp,
      car.y + 0.9 + Math.sin(this.camPitch) * dist,
      car.z - Math.sin(a) * dist * cp,
    );
    // Inside the garage the chase camera would otherwise sit behind a wall.
    const room = this.viewer._garageRoom;
    if (this._insideRoom(this.pos.x, this.pos.y) && room) {
      target.x = clamp(target.x, room.min.x + 0.6, room.max.x - 0.6);
      target.z = clamp(target.z, room.min.z + 0.6, room.max.z - 0.6);
      target.y = clamp(target.y, 0.6, room.max.y - 0.6);
    }
    target.y = Math.max(0.55, target.y);
    if (alpha >= 1) this.camera.position.copy(target);
    else this.camera.position.lerp(target, alpha);

    const fx = Math.cos(this.yaw);
    const fz = -Math.sin(this.yaw);
    const look = new THREE.Vector3(
      car.x + fx * 2.4,
      car.y + 0.85,
      car.z + fz * 2.4,
    );
    this.camera.lookAt(look);
  }

  _rev(speed, throttle) {
    // Pseudo gearbox: the pitch climbs, drops at each shift, and the top gear
    // keeps rising with speed.
    const gears = [0, 9, 18, 29, 42, 60];
    let gear = 1;
    for (let i = 1; i < gears.length; i++) if (speed >= gears[i]) gear = i + 1;
    gear = Math.min(gear, gears.length - 1);
    const lo = gears[gear - 1];
    const hi = gears[gear];
    const frac = clamp((speed - lo) / Math.max(1, hi - lo), 0, 1);
    const idle = 0.16 + Math.max(0, throttle) * 0.22;
    return Math.max(idle, 0.24 + frac * 0.72);
  }

  telemetry() {
    const speed = this.forwardSpeed();
    return {
      kmh: Math.round(Math.abs(speed) * 3.6),
      gear: speed < -0.4 ? 'R' : Math.abs(speed) < 0.4 ? 'N' : 'D',
      drift: this.keys.has('Space') && Math.abs(speed) > 4,
      impact: this._impact,
      muted: this.muted,
    };
  }

  _updateTelemetry(input) {
    const now = performance.now();
    if (now - this._lastTelemetry < 90) return;
    this._lastTelemetry = now;
    this.onTelemetry?.({ ...this.telemetry(), throttle: Math.max(0, input.throttle), brake: Math.max(0, -input.throttle) });
  }

  onResize() {
    if (!this.active) return;
    const size = this.viewer.renderer.getSize(new THREE.Vector2());
    this.camera.aspect = size.x / Math.max(1, size.y);
    this.camera.updateProjectionMatrix();
  }
}
