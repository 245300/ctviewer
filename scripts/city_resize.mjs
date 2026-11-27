/**
 * Resize every embedded texture in a GLB and re-pack it with meshopt.
 *
 *   node scripts/city_resize.mjs <input.glb> <output.glb> [maxSize=512] [quality=82]
 *
 * The city ships ten 2048x2048 maps (~212 MB of GPU texture) for a 620 m block
 * that is normally seen from 50 m or more. Dropping them to 512 cuts the
 * download and the VRAM by ~6x with no visible change at those distances.
 *
 * Uses sharp directly rather than `gltf-transform optimize --texture-size`:
 * the CLI's textureCompress path hits libvips' "colourspace: parameter space
 * not set" on this machine, while a direct sharp resize of the same bytes works.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const [input, output, sizeArg, qualityArg] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/city_resize.mjs <input.glb> <output.glb> [maxSize] [quality]');
  process.exit(1);
}
const maxSize = Math.max(64, Number(sizeArg) || 512);
const quality = Math.min(95, Math.max(40, Number(qualityArg) || 82));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
});

const doc = await io.read(input);
let before = 0;
let after = 0;
for (const texture of doc.getRoot().listTextures()) {
  const image = texture.getImage();
  if (!image) continue;
  before += image.byteLength;
  const isPng = (texture.getMimeType() || '').includes('png');
  const pipeline = sharp(Buffer.from(image)).resize({
    width: maxSize,
    height: maxSize,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const out = isPng
    ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
    : await pipeline.jpeg({ quality }).toBuffer();
  texture.setImage(new Uint8Array(out)).setMimeType(isPng ? 'image/png' : 'image/jpeg');
  after += out.byteLength;
}
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
await io.write(output, doc);

console.log(
  `${input} -> ${output}: textures ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB`
  + ` (max ${maxSize} px, ${doc.getRoot().listTextures().length} maps)`,
);
