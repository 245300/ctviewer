#!/usr/bin/env node
/**
 * Squeeze the exported city GLB down to something worth shipping.
 *
 * The browser export (tools/fbx2glb.html) produces a faithful but fat file:
 * every triangle carries three unwelded vertices, positions and normals are
 * Float32, and GLTFExporter re-encodes each texture as PNG. This pass fixes all
 * three - weld, quantize, meshopt, JPEG - without touching the look.
 *
 * Runtime side: KHR_mesh_quantization needs nothing (three reads it natively),
 * EXT_meshopt_compression needs MeshoptDecoder handed to GLTFLoader. See
 * js/city.js.
 *
 * Usage: node scripts/city_glb.mjs [in.glb] [out.glb]
 */
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const IN = process.argv[2] || 'assets/scenes/city/city_raw.glb';
const OUT = process.argv[3] || 'assets/scenes/city/city.glb';

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const size = (p) => (fs.existsSync(p) ? mb(fs.statSync(p).size) : '-');

// The meshopt extension pulls its encoder from the IO's dependency registry,
// not from the transform call - without this the write throws on encodeFilterOct.
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(IN);
const before = size(IN);
console.log(`in  ${IN}  ${before}`);

const step = async (label, ...ops) => {
  const t0 = Date.now();
  await doc.transform(...ops);
  console.log(`  ${label.padEnd(18)} ${Date.now() - t0} ms`);
};

await step('dedup / prune', dedup(), prune());

/**
 * Re-encode the textures by hand.
 *
 * GLTFExporter hands every image back as a PNG - it draws each one through a
 * canvas - so a 12-texture city arrives several times larger than it needs to
 * be. `textureCompress({ targetFormat: 'jpeg' })` would fix the size and destroy
 * the two foliage sheets, whose alpha channel is the shape of the bush. So the
 * alpha ones stay PNG (and smaller), the rest become JPEG.
 */
{
  const t0 = Date.now();
  const textures = doc.getRoot().listTextures();
  let png = 0, jpg = 0;
  for (const tex of textures) {
    const src = Buffer.from(tex.getImage());
    const meta = await sharp(src).metadata();
    let cutout = false;
    if (meta.hasAlpha) {
      // An all-opaque alpha channel is just padding; only keep PNG when some
      // texel is actually transparent.
      const stats = await sharp(src).stats();
      const alpha = stats.channels[3];
      cutout = Boolean(alpha && alpha.min < 240);
    }
    const out = cutout
      ? await sharp(src).resize(1024, null, { fit: 'inside' }).png({ compressionLevel: 9 }).toBuffer()
      : await sharp(src).resize(2048, null, { fit: 'inside' }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
    tex.setImage(new Uint8Array(out)).setMimeType(cutout ? 'image/png' : 'image/jpeg');
    if (cutout) png++; else jpg++;
  }
  console.log(`  ${'textures'.padEnd(18)} ${Date.now() - t0} ms · ${jpg} jpeg, ${png} png`);
}

// Weld first - it is what makes quantize worthwhile, since the FBX ships every
// triangle with its own three vertices and nothing shares.
await step('weld', weld());
await step('quantize', quantize());
await MeshoptEncoder.ready;
await step('meshopt', meshopt({ encoder: MeshoptEncoder, level: 'high' }));

await io.write(OUT, doc);
console.log(`out ${OUT}  ${size(OUT)}`);

const stats = doc.getRoot().listMeshes().length;
let verts = 0, tris = 0;
for (const m of doc.getRoot().listMeshes()) {
  for (const p of m.listPrimitives()) {
    verts += p.getAttribute('POSITION').getCount();
    tris += (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
  }
}
console.log(`${stats} meshes · ${verts} verts · ${Math.round(tris)} tris · ${doc.getRoot().listTextures().length} textures`);
