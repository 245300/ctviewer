/**
 * Clip adaptation shared by the runtime character controller and the offline
 * ground bake (tools/ground_bake.html).
 *
 * The shared animation library is baked on the reference rig (colphne), so
 * every other character needs its Hips translation rebased onto its own hip
 * height.  The clips also carry no floor-contact solve - a lying pose can put
 * the armour through the pavement - so a per-character, per-clip lift table is
 * measured once offline and applied here.
 */
import * as THREE from 'three';

/** Rebase a clip's Hips translation onto a character's own hip height. */
export function adaptHipsClip(clip, hip, refHip, rest) {
  if (!hip || !refHip || !rest || Math.abs(hip - refHip) < 0.003) return clip;
  const out = clip.clone();
  const s = hip / refHip;
  for (const track of out.tracks) {
    if (track.name !== 'Hips.position') continue;
    const v = track.values;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = rest.x + v[i] * s;
      v[i + 1] = rest.y + (v[i + 1] - refHip) * s;
      v[i + 2] = rest.z + v[i + 2] * s;
    }
  }
  return out;
}

/** Add a measured lift table ({ n, y: [...] }, sampled uniformly) to a clip. */
export function applyGroundLift(clip, lift) {
  if (!lift || !lift.y || lift.y.length < 2) return clip;
  const track = clip.tracks.find((t) => t.name === 'Hips.position');
  if (!track) return clip;
  const n = Math.min(lift.y.length - 1, lift.n ?? lift.y.length - 1);
  const dur = clip.duration || 1;
  const times = track.times;
  const v = track.values;
  for (let k = 0; k < times.length; k++) {
    const f = Math.min(n, Math.max(0, (times[k] / dur) * n));
    const i0 = Math.floor(f);
    const i1 = Math.min(n, i0 + 1);
    const a = f - i0;
    v[k * 3 + 1] += lift.y[i0] * (1 - a) + lift.y[i1] * a;
  }
  return clip;
}

/**
 * Sample every clip's skinned bounds and return the lift each needs so its
 * lowest vertex never goes under y = 0.  Airborne frames sample above the floor
 * and get no lift, so jumps keep leaving the ground.  Runs the mixer, so call
 * it before the character is shown.
 */
export function measureGroundLift(actions, root, mixer, { maxSamples = 48 } = {}) {
  // Hair, fur and dangling tassels are not what the character stands on: a long
  // ponytail sprawls a metre under the pavement when its owner lies down, and
  // lifting the body to clear it would float the whole character.  Measure the
  // body and its clothing only.
  const skipMat = /hair|fur|tassel|ribbon|brow|eye|emotion|glass/i;
  const bodyMeshes = [];
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const mats = [].concat(o.material || []);
    if (mats.length && mats.every((m) => m && skipMat.test(m.name || ''))) return;
    bodyMeshes.push(o);
  });
  const out = {};
  for (const name of Object.keys(actions)) {
    const action = actions[name];
    const clip = action.getClip();
    if (!clip.tracks.some((t) => t.name === 'Hips.position')) continue;
    const dur = clip.duration || 1;
    const n = Math.max(8, Math.min(maxSamples, Math.round(dur * 10)));
    const corr = new Float32Array(n + 1);
    mixer.stopAllAction();
    action.reset();
    // LoopOnce keeps the final sample at the clip's last frame.  With the
    // default repeat loop, setTime(duration) wraps to frame 0 - harmless for
    // cycles, but Stand Up ends standing and starts lying down, so the wrap
    // would lift its last pose half a metre into the air.
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveWeight(1);
    action.play();
    let worst = 0;
    for (let i = 0; i <= n; i++) {
      mixer.setTime((dur * i) / n);
      root.updateMatrixWorld(true);
      let minY = Infinity;
      for (const o of bodyMeshes) {
        o.computeBoundingBox?.();
        if (o.boundingBox) minY = Math.min(minY, o.boundingBox.min.y);
      }
      corr[i] = minY < -0.004 ? -minY : 0;
      if (corr[i] > worst) worst = corr[i];
    }
    action.stop();
    if (worst <= 0.004) {
      out[name] = { n, y: Array.from(corr) };
      continue;
    }
    // widen each sample by 75 % of its neighbours so a key cannot land on a
    // step; a max filter never reintroduces penetration
    out[name] = {
      n,
      y: Array.from(corr, (v, i) => +Math.max(
        v,
        corr[Math.max(0, i - 1)] * 0.75,
        corr[Math.min(n, i + 1)] * 0.75,
      ).toFixed(4)),
    };
  }
  mixer.stopAllAction();
  mixer.setTime(0);
  return out;
}

export { THREE };
