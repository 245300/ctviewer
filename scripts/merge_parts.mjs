#!/usr/bin/env node
/**
 * Assemble the "advanced" pre-split body parts of one car into a single GLB.
 *
 * The part files already carry their world transforms, so this is only about
 * names: the viewer picks parts by node name, and `door_lf` / `headlamp` /
 * `wheels_lf` are far better labels than the material-derived names stored
 * inside the files. Every mesh node is renamed after its file so parts.js can
 * look the label up instead of guessing from a mesh-name regex.
 *
 * The per-part rename happens here, then gltf-transform's own `merge` command
 * concatenates the parts, because it is the one place that knows how to fold
 * many source documents into a single-buffer GLB.
 *
 * Usage:
 *   node scripts/merge_parts.mjs <out.glb> <parts-dir> [<parts-dir> ...]
 */
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const [outPath, ...roots] = process.argv.slice(2);
if (!outPath || roots.length === 0) {
  console.error('usage: node merge_parts.mjs <out.glb> <parts-dir...>');
  process.exit(2);
}

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.name.toLowerCase().endsWith('.glb')) found.push(full);
  }
  return found;
}

const files = [];
for (const root of roots) {
  const info = await stat(root);
  if (info.isDirectory()) files.push(...(await walk(root)));
  else files.push(root);
}
files.sort();
if (files.length === 0) throw new Error('no part files found');

/**
 * `light/bagage.glb` is the hatch-mounted light glass, not the hatch panel,
 * so it gets its own token instead of colliding with `bagage`.
 */
function semanticName(file) {
  const stem = basename(file, '.glb').toLowerCase();
  if (/(^|[\\/])light[\\/]/.test(file) && stem === 'bagage') return 'tail_light_glass';
  return stem;
}

const tmp = await mkdtemp(join(tmpdir(), 'ctviewer-parts-'));
const renamed = [];
const summary = [];
try {
  for (const [index, file] of files.entries()) {
    const doc = await io.read(file);
    const stem = semanticName(file);
    const nodes = doc.getRoot().listNodes().filter((node) => node.getMesh());
    nodes.forEach((node, i) => node.setName(i ? `${stem}_${i + 1}` : stem));
    doc.getRoot().listMeshes().forEach((mesh, i) => mesh.setName(i ? `${stem}_${i + 1}` : stem));
    const target = join(tmp, `${String(index).padStart(3, '0')}-${stem}.glb`);
    await io.write(target, doc);
    renamed.push(target);
    summary.push(`${stem}(${nodes.length})`);
  }
  const cli = join(process.cwd(), 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'merge', '--merge-scenes', 'true', ...renamed, outPath], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`gltf-transform merge failed (${result.status})`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`✓ ${basename(outPath)} <- ${files.length} part files`);
console.log('  ' + summary.join(' '));
