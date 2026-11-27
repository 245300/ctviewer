#!/usr/bin/env node
/**
 * Re-encode the Unity Classical_city textures for the web.
 *
 * The originals are 4096² TIFs (50–115 MB each). The FBX is a *binary* file, so
 * its texture references can only be repointed at names of exactly the same
 * byte length - `building_a.tif` → `building_a.jpg` works, `.webp` does not.
 * Hence JPEG, and hence the fixed file names.
 *
 * `Glass.jpg` is deliberately not produced here: the FBX references it but the
 * Unity project never had such a texture (Glass.mat is a plain transparent
 * material). It is handled as a real glass material at export time instead; see
 * tools/fbx2glb.html.
 *
 * Usage: node scripts/city_textures.mjs [--size 2048] [--quality 86]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SRC = 'D:/Project/unity 赛车游戏/My project/天天赛车/Assets/CineMachines/Classical_city/Textures';
// Derived, not shipped: the runtime reads only assets/scenes/city/city.glb.
const OUT = 'models_src/_unity_city/web';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SIZE = Number(opt('size', '2048'));
const QUALITY = Number(opt('quality', '86'));

// Source TIF → name the FBX asks for. Foliage is the one set that carries real
// transparency: its leaves are cut out of a flat sheet, so it has to stay a
// format that has an alpha channel or every bush becomes a black rectangle.
// `.tif` → `.png` is the same byte length, which is what a binary FBX allows.
const MAP = {
  'building_a.tif': 'building_a.jpg',
  'building_b.tif': 'building_b.jpg',
  'ground.tif': 'ground.jpg',
  'props_a.tif': 'props_a.jpg',
  'props_b.tif': 'props_b.jpg',
  'banner.tif': 'banner.jpg',
  'road_a.tif': 'Road.jpg',
  'vegetation_a.tif': 'vegetation_a.png',
  'vegetation_b.tif': 'vegetation_b.png',
};
const PNG = new Set(['vegetation_a.png', 'vegetation_b.png']);

// The Unity set ships a night window-light map per facade. The FBX does not
// reference them (Unity swaps them in per scene), so they are exported under
// their own names and wired to each material's emissive slot by the converter.
const EMISSIVE = {
  'building_a_light_night.tif': 'building_a_lit.jpg',
  'building_b_light.tif': 'building_b_lit.jpg',
  'banner_light.tif': 'banner_lit.jpg',
};

const JOBS = [
  ...Object.entries(MAP),
  ...Object.entries(EMISSIVE),
];

fs.mkdirSync(OUT, { recursive: true });
const READ = {
  // libvips refuses >50 MB cumulative for a single pipeline unless told so.
  limitInputPixels: false,
  unlimited: true,
  sequentialRead: true,
};

/**
 * The RGB of a 4-band sheet, with the alpha dropped *before* any resampling.
 *
 * Almost every sheet in this kit carries an alpha channel that only the two
 * foliage shaders read - the rest are opaque Standard materials. Left in place,
 * libvips premultiplies by alpha on resize and composites onto black on JPEG
 * write, which is what turned a sheet averaging 117/255 into a 6/255 black slab.
 * Every route through sharp's own alpha handling reproduces that, so the pixels
 * are read raw and repacked as a plain three-channel image.
 */
async function rgbOnly(from) {
  const { data, info } = await sharp(from, READ).raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 3) return { buf: data, width: info.width, height: info.height };
  const px = info.width * info.height;
  const rgb = Buffer.allocUnsafe(px * 3);
  for (let i = 0; i < px; i++) {
    rgb[i * 3] = data[i * info.channels];
    rgb[i * 3 + 1] = data[i * info.channels + 1];
    rgb[i * 3 + 2] = data[i * info.channels + 2];
  }
  return { buf: rgb, width: info.width, height: info.height };
}

let total = 0;
for (const [src, dest] of JOBS) {
  const from = path.join(SRC, src);
  if (!fs.existsSync(from)) {
    console.warn(`skip ${src} (missing)`);
    continue;
  }
  const to = path.join(OUT, dest);
  const t0 = Date.now();
  const cutout = PNG.has(dest);
  const limit = cutout ? Math.min(SIZE, 1024) : SIZE;

  let pipe;
  if (cutout) {
    // Foliage keeps its alpha, so it also keeps libvips' premultiplied resize -
    // that is what stops dark halos fringing the leaves.
    pipe = sharp(from, READ).resize(limit, null, { fit: 'inside', withoutEnlargement: true });
  } else {
    const { buf, width, height } = await rgbOnly(from);
    pipe = sharp(buf, { raw: { width, height, channels: 3 } })
      .resize(limit, null, { fit: 'inside', withoutEnlargement: true });
  }
  pipe = pipe.toColourspace('srgb');
  pipe = cutout
    ? pipe.png({ compressionLevel: 9, palette: false })
    : pipe.jpeg({ quality: QUALITY, chromaSubsampling: '4:4:4', mozjpeg: true });
  await pipe.toFile(to);
  const kb = Math.round(fs.statSync(to).size / 1024);
  total += kb;
  console.log(`${dest.padEnd(18)} ${String(kb).padStart(5)} KB  (${Date.now() - t0} ms)`);
}
console.log(`total ${total} KB at ${SIZE}px q${QUALITY}`);
