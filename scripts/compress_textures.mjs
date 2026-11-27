#!/usr/bin/env node
/**
 * First pass of the model pipeline: resize + re-encode textures as WebP.
 *
 * `gltf-transform optimize --texture-compress webp` fails on Windows with
 * libvips "colourspace: parameter space not set" for Sketchfab textures whose
 * interpretation is unset. Piping every image through sharp's
 * `.toColourspace('srgb')` first fixes that, so the texture pass lives here and
 * the CLI optimize step runs with `--texture-compress false`.
 *
 * Usage:
 *   node scripts/compress_textures.mjs <in.glb> <out.glb> [--size 1024] [--quality 82]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const [input, output] = positional;
if (!input || !output) {
  console.error('usage: node compress_textures.mjs <in.glb> <out.glb> [--size 1024] [--quality 82]');
  process.exit(2);
}
const size = Number(option('size', '1024'));
const quality = Number(option('quality', '82'));

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const doc = await io.read(input);
await doc.transform(
  textureCompress({
    resize: [size, size],
    targetFormat: 'webp',
    // The explicit colourspace conversion is the actual fix for the libvips
    // failure; quality keeps the studio reflections clean.
    encode: (sharp) => sharp.toColourspace('srgb').webp({ quality }),
  }),
);
await io.write(output, doc);
console.log(`✓ textures -> ${output}`);
