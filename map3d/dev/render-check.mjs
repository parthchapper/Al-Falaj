/**
 * Headless renderer check.
 *
 * Boots the globe module in Chromium against a running gateway, lets it run
 * through a mode change, then asserts that it actually drew frames, received
 * telemetry, and logged no errors. Writes a screenshot so a human can look
 * at what the machine just approved.
 *
 *   node dev/render-check.mjs [baseUrl] [--headed]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8800';
const OUT = resolve(__dirname, '../../artifacts');

const log = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const run = async () => {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nmap3d renderer check -> ${BASE}\n`);

  // CHROMIUM_PATH lets this run against a preinstalled browser in CI images
  // that do not ship the exact build Playwright would download.
  const browser = await chromium.launch({
    headless: !process.argv.includes('--headed'),
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  page.on('console', (m) => { if (m.type() === 'error') log.push(m.text()); });
  page.on('pageerror', (e) => log.push(String(e.message)));

  // Serve the harness from the gateway origin so the import map resolves.
  await page.route('**/render-check.html', async (route) => {
    const fs = await import('node:fs/promises');
    const body = await fs.readFile(resolve(__dirname, 'render-check.html'), 'utf8');
    route.fulfill({ status: 200, contentType: 'text/html', body });
  });

  await page.goto(`${BASE}/render-check.html`, { waitUntil: 'domcontentloaded' });

  // Give it time to boot, stream telemetry, and cross a mode boundary.
  await page.waitForFunction(() => window.__report?.booted === true, null, { timeout: 25000 })
    .catch(() => {});
  await page.waitForTimeout(9000);

  const r = await page.evaluate(() => window.__report);
  const mode = await page.evaluate(() => window.__globe?.mode);

  check('module booted', r?.booted === true, r?.errors?.[0]);
  // Headless CI rasterises with SwiftShader on the CPU, so this asserts that
  // the render loop is alive, not that it hits 60 fps.
  check('WebGL render loop is running', (r?.frames ?? 0) > 25, `${r?.frames} frames`);
  check('telemetry map frames arrived', (r?.mapFrames ?? 0) > 5, `${r?.mapFrames}`);
  check('downlink lines arrived', (r?.downlinkLines ?? 0) > 0, `${r?.downlinkLines}`);
  check('scene populated', (r?.sceneChildren ?? 0) >= 2, `${r?.sceneChildren} children`);
  check('all layers constructed', (r?.layers?.length ?? 0) === 5, (r?.layers ?? []).join(','));
  check('globe reports a valid mode',
    ['ECLIPSE', 'SUN_FACING', 'ACTIVE'].includes(mode), String(mode));
  check('no page errors', (r?.errors?.length ?? 0) === 0 && log.length === 0,
    (r?.errors?.[0] ?? log[0] ?? ''));

  // Screenshot each mode so a regression in the visual treatment is visible.
  for (const m of ['ECLIPSE', 'SUN_FACING', 'ACTIVE']) {
    await fetch(`${BASE}/api/mission/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: m }),
    });
    await fetch(`${BASE}/api/mission/transport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playing: false }),
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/globe-${m.toLowerCase()}.png` });
    console.log(`  shot ${OUT}/globe-${m.toLowerCase()}.png`);
  }
  await fetch(`${BASE}/api/mission/transport`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playing: true }),
  });

  await browser.close();
  console.log(`\n${failed ? `${failed} failed` : 'all checks passed'}\n`);
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error('\nrenderer check aborted:', e.message, '\n'); process.exit(2); });
