import { chromium } from 'playwright';

const BASE = process.env.CTVIEWER_URL || 'http://127.0.0.1:8030/';
const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

await page.goto(`${BASE}?nosw=1&lite=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(18000);

const initial = await page.evaluate(() => ({
  car: window.__CTVIEWER__?.viewer?.currentCar?.id,
  ready: window.__CTVIEWER__?.ready?.(),
  parts: window.__CTVIEWER__?.getPartIds?.().length,
  paints: document.querySelectorAll('.paint-option').length,
  chips: document.querySelectorAll('.car-chip').length,
}));
console.log('INITIAL', initial);
const garage = await page.evaluate(() => ({
  cards: document.querySelectorAll('.library-item').length,
  presets: document.querySelectorAll('.view-presets button').length,
}));
console.log('GARAGE', garage);
if (!initial.ready || initial.parts !== 100 || initial.chips !== 28) {
  throw new Error(`initial state failed: ${JSON.stringify(initial)}`);
}
if (garage.cards !== 28 || garage.presets !== 5) {
  throw new Error(`garage/presets failed: ${JSON.stringify(garage)}`);
}

await page.evaluate(() => window.__CTVIEWER__.setPaint(4));
await page.waitForTimeout(800);
const paint = await page.evaluate(() => window.__CTVIEWER__.getState().paint);

await page.evaluate(() => window.__CTVIEWER__.setExplode(1));
await page.waitForTimeout(2200);
const explode = await page.evaluate(() => {
  const v = window.__CTVIEWER__.viewer;
  return {
    value: v.explodeCurrent,
    moved: v.meshes.slice(0, 8).filter((m) => m.position.lengthSq() > 0.0001).length,
  };
});
console.log('PAINT', paint);
console.log('EXPLODE', explode);
if (paint.id !== 'candy' || explode.value < 0.9 || explode.moved < 4) {
  throw new Error('paint or explosion check failed');
}

await page.evaluate(() => window.__CTVIEWER__.loadCar('ferrari-purosangue'));
await page.waitForTimeout(14000);
const switched = await page.evaluate(() => ({
  car: window.__CTVIEWER__.viewer.currentCar?.id,
  ready: window.__CTVIEWER__.ready(),
  parts: window.__CTVIEWER__.getPartIds().length,
  semantic: window.__CTVIEWER__.getParts().some((p) => p.label === '左前车门'),
}));
console.log('SWITCHED', switched);
if (!switched.ready || switched.car !== 'ferrari-purosangue' || switched.parts < 100 || !switched.semantic) {
  throw new Error(`switch failed: ${JSON.stringify(switched)}`);
}

await browser.close();
if (errors.length) {
  console.error('BROWSER ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('BROWSER TEST PASSED');
