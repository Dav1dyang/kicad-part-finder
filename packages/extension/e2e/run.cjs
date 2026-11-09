/**
 * End-to-end test of the built extension in Chromium: a mock relay serves the
 * saved fixtures, and installs go to the browser's private file system.
 * Run with `pnpm test:e2e` (builds first). Needs Playwright's Chromium.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const p = require('path');
const startRelay = require('./mock-relay.cjs');
const path = p.join(__dirname, '../dist');
const OUT = fs.mkdtempSync(p.join(os.tmpdir(), 'kpf-e2e-'));
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };

(async () => {
  const relay = await startRelay();
  const RELAY = `http://localhost:${relay.address().port}`;
  const ctx = await chromium.launchPersistentContext(p.join(OUT, 'profile'), {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  ok(Boolean(id), `extension loaded, service worker running (${id})`);

  const api = await sw.evaluate(() => ({
    close: typeof chrome.sidePanel?.close,
    onOpened: typeof chrome.sidePanel?.onOpened,
    ua: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0],
  }));
  console.log('INFO  browser', api.ua, '| sidePanel.close:', api.close, '| onOpened:', api.onOpened);

  await sw.evaluate((url) => chrome.storage.local.set({ relayUrl: url }), RELAY);

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewportSize({ width: 380, height: 1000 });
  await page.goto(`chrome-extension://${id}/src/sidepanel/index.html`);

  // A real directory handle the panel can write to: the origin-private file system.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const lib = await root.getDirectoryHandle('kicad-lib', { create: true });
    const sym = await lib.getDirectoryHandle('symbols', { create: true });
    const f = await sym.getFileHandle('Lab_IC.kicad_sym', { create: true });
    const w = await f.createWritable();
    await w.write('(kicad_symbol_lib (version 20211014) (generator test)\n)\n');
    await w.close();
    await new Promise((res, rej) => {
      const req = indexedDB.open('kicad-part-finder', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => {
        const tx = req.result.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(lib, 'libraryFolder');
        tx.oncomplete = res;
        tx.onerror = rej;
      };
      req.onerror = rej;
    });
  });
  await page.reload();
  await page.waitForTimeout(500);
  ok((await page.textContent('#relayPillValue')).includes('localhost:'), 'relay pill shows the saved relay');
  ok((await page.textContent('#libPillValue')).trim() === 'kicad-lib', 'library pill shows the saved folder');

  await page.click('#settingsBtn');
  await page.click('#relayTestBtn');
  await page.waitForSelector('#relayNote.is-ok', { timeout: 5000 });
  ok(true, `relay test: "${(await page.textContent('#relayNote')).trim()}"`);
  // An older relay still works but is flagged for a redeploy.
  await page.fill('#relayUrlInput', `${RELAY}/old`);
  await page.click('#relayTestBtn');
  await page.waitForSelector('#relayNote.is-warn', { timeout: 5000 });
  ok((await page.textContent('#relayNote')).includes('outdated'), `old relay flagged: "${(await page.textContent('#relayNote')).trim()}"`);
  await page.fill('#relayUrlInput', RELAY);
  await page.click('#relayTestBtn');
  await page.waitForSelector('#relayNote.is-ok', { timeout: 5000 });
  await page.click('#settingsBtn');

  await page.fill('#searchInput', 'TPS2116DRLR');
  await page.press('#searchInput', 'Enter');
  await page.waitForSelector('#partCard:not(.hidden)', { timeout: 15000 });
  ok((await page.textContent('#cardMpn')).trim() === 'TPS2116DRLR', 'MPN search shows the card');
  ok((await page.textContent('#sourceBadge')).trim() === 'LCSC verified', 'provenance chip: LCSC verified');
  ok((await page.textContent('#checksTitle')).trim() === 'All checks passed', 'checks pass');
  ok((await page.textContent('#stockBadge')).includes('12,840'), 'stock badge from JLCPCB');
  ok((await page.inputValue('#bucketSelect')) === 'Power', 'auto-sorted into Power');
  await page.waitForTimeout(800);
  ok((await page.$$('#previewPaneSymbol svg')).length > 0, 'symbol preview rendered');
  await page.screenshot({ path: p.join(OUT, 'card.png'), fullPage: true });

  // 3D preview: the model's inline colours (gold pins) must reach the screen.
  await page.click('#previewTab3d');
  await page.waitForSelector('#previewPane3d canvas', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const shot = (await page.locator('#previewPane3d').screenshot()).toString('base64');
  await page.locator('#previewPane3d').screenshot({ path: p.join(OUT, '3d.png') });
  const gold = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i] - d[i + 2] > 50 && d[i + 1] - d[i + 2] > 25) n++;
    return n;
  }, shot);
  ok(gold > 200, `3D preview shows the model's own colours (${gold} gold pixels)`);
  await page.click('#previewTabSymbol');

  await page.click('#installBtn');
  await page.waitForSelector('#installBtn.is-done, #installBtn.is-error, #installBtn.is-partial', { timeout: 15000 });
  const status = (await page.textContent('#installStatus')).trim();
  ok((await page.getAttribute('#installBtn', 'class')).includes('is-done'), `install: "${status}"`);
  const written = await page.$$eval('#writtenList li', (els) => els.map((e) => e.textContent));
  console.log('INFO  written:', written.join(' | '));

  const files = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('kicad-lib');
    const read = async (dir, name) => (await (await dir.getFileHandle(name)).getFile()).text();
    const sym = await read(await root.getDirectoryHandle('symbols'), 'DavidLib_Power.kicad_sym');
    const pretty = await (await root.getDirectoryHandle('footprints')).getDirectoryHandle('DavidLib_Power.pretty');
    const names = [];
    for await (const [n] of pretty) names.push(n);
    const fp = await read(pretty, names[0]);
    const models = [];
    for await (const [n] of await root.getDirectoryHandle('3dmodels')) models.push(n);
    return { sym, fpName: names[0], fp, models };
  });
  ok(/\(symbol "TPS2116DRLR"/.test(files.sym), 'symbol written to DavidLib_Power.kicad_sym');
  ok(files.sym.includes(`(property "Footprint" "DavidLib_Power:${files.fpName.replace('.kicad_mod', '')}"`), 'symbol links to its footprint');
  ok(/\(pad "1"/.test(files.fp) && files.fp.includes('${DAVID_KICAD_LIB}/3dmodels/'), 'footprint written with 3D model path');
  ok(files.models.length === 1 && files.models[0].endsWith('.step'), `STEP model written (${files.models[0]})`);
  const opens = (files.sym.match(/\(/g) || []).length;
  const closes = (files.sym.match(/\)/g) || []).length;
  ok(opens === closes, 'symbol library parens balanced');

  await page.click('#installAnotherBtn');
  await page.fill('#searchInput', 'C3235557');
  await page.press('#searchInput', 'Enter');
  await page.waitForSelector('#partCard:not(.hidden)', { timeout: 15000 });
  await page.selectOption('#bucketSelect', 'Power');
  await page.click('#installBtn');
  await page.waitForSelector('#installBtn.is-done', { timeout: 15000 });
  const again = (await page.textContent('#installStatus')).trim();
  ok(again.includes('Already in DavidLib_Power'), `reinstall dedupes: "${again}"`);

  await page.click('#settingsBtn');
  await page.fill('#libPrefixInput', 'Lab');
  await page.waitForTimeout(200);
  const stored = await sw.evaluate(() => chrome.storage.local.get('libraryConfig'));
  ok(stored.libraryConfig?.prefix === 'Lab', 'prefix setting saved');
  ok((await page.textContent('#destPath')).includes('Lab_Power'), 'destination follows the new prefix');
  await page.fill('#libPrefixInput', '1bad');
  ok((await page.getAttribute('#libConfigNote', 'class')).includes('is-error'), 'invalid prefix refused with a note');
  await page.fill('#libPrefixInput', 'DavidLib');
  await page.screenshot({ path: p.join(OUT, 'settings.png'), fullPage: true });

  // Colour combinations: picking one recolours the panel and is remembered.
  // (Settings is still open from the prefix checks above.)
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--btn-primary').trim());
  await page.click('.palette-choice:has(input[value="lake"])');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--btn-primary').trim());
  const savedPalette = await sw.evaluate(() => chrome.storage.local.get('palette'));
  ok(before !== after && savedPalette.palette === 'lake', `colour combination applies and is saved (${before} -> ${after})`);
  await page.screenshot({ path: p.join(OUT, 'settings-lake.png'), fullPage: true });
  await page.click('.palette-choice:has(input[value="apple"])');

  await page.click('#settingsBtn');
  await page.fill('#searchInput', 'NOPE123XYZ');
  await page.press('#searchInput', 'Enter');
  await page.waitForSelector('#searchStatus.error', { timeout: 15000 });
  const noMatch = (await page.textContent('#searchStatus')).trim();
  ok(await page.isVisible('#secondarySources'), `no match: "${noMatch}", other sources shown`);

  // Layout under stress: extreme parts at side-panel widths, both themes.
  // Fails on sideways scrolling or text spilling out of its box.
  const layoutProblems = () =>
    page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const bad = [];
      if (document.documentElement.scrollWidth > w + 1) bad.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${w})`);
      for (const el of document.querySelectorAll('#app *')) {
        if (el.closest('.hidden, [hidden]') || el.closest('svg') || el.tagName === 'CANVAS') continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const name = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ')[0]}`;
        if (r.right > w + 0.5 || r.left < -0.5) bad.push(`${name} leaves the panel`);
        const cs = getComputedStyle(el);
        const textBox = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (textBox && cs.overflowX === 'visible' && !/INPUT|SELECT|TEXTAREA/.test(el.tagName) && el.scrollWidth > el.clientWidth + 1) {
          bad.push(`${name} text overflows (${el.scrollWidth} > ${el.clientWidth})`);
        }
      }
      return [...new Set(bad)].slice(0, 6);
    });
  const cases = [
    ['C3235557', 'normal part'],
    ['C9999991', 'very long names'],
    ['C9999992', 'no maker, package, or 3D model'],
    ['MANY', '15 matches'],
  ];
  let layoutFailures = 0;
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [320, 360, 460, 800]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [query, label] of cases) {
        await page.fill('#searchInput', query);
        await page.press('#searchInput', 'Enter');
        await page.waitForSelector('#partCard:not(.hidden), #searchStatus.error', { timeout: 15000 });
        await page.waitForTimeout(150);
        if (width === 360 && query !== 'MANY') {
          await page.screenshot({ path: p.join(OUT, `${scheme}-${query}.png`), fullPage: true });
        }
        const problems = await layoutProblems();
        if (problems.length) {
          layoutFailures++;
          console.log(`FAIL  layout ${scheme} ${width}px, ${label}: ${problems.join('; ')}`);
          await page.screenshot({ path: p.join(OUT, `layout-${scheme}-${width}-${query}.png`), fullPage: true });
        }
      }
      // Settings open, with a long relay URL in the field.
      await page.click('#settingsBtn');
      const problems = await layoutProblems();
      if (problems.length) {
        layoutFailures++;
        console.log(`FAIL  layout ${scheme} ${width}px, settings: ${problems.join('; ')}`);
      }
      await page.click('#settingsBtn');
    }
  }
  ok(layoutFailures === 0, `layout holds: 4 parts x 4 widths (320-800 px) x 2 themes, plus Settings`);

  // The page background is one continuous gradient: no seam where a second
  // tile would start below the first screen.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 360, height: 700 });
  await page.fill('#searchInput', 'C3235557');
  await page.press('#searchInput', 'Enter');
  await page.waitForSelector('#partCard:not(.hidden)', { timeout: 15000 });
  const full = (await page.screenshot({ fullPage: true })).toString('base64');
  const seam = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    // Right gutter (outside the card), averaged over a few pixels, just above and below 700px.
    const avg = (y) => {
      const d = g.getImageData(352, y, 6, 4).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
      return sum.map((v) => v / (d.length / 4));
    };
    const [a, b] = [avg(692), avg(704)];
    return Math.max(...a.map((v, k) => Math.abs(v - b[k])));
  }, full);
  ok(seam < 3, `page background has no seam below the first screen (step ${seam.toFixed(1)})`);

  // The bare part: checks say what is missing, Install still works.
  await page.setViewportSize({ width: 380, height: 1000 });
  await page.fill('#searchInput', 'C9999992');
  await page.press('#searchInput', 'Enter');
  await page.waitForSelector('#partCard:not(.hidden)', { timeout: 15000 });
  ok((await page.textContent('#sourceBadge')).trim() === 'Community part', 'unverified part is marked Community part');
  ok((await page.textContent('#checksList')).includes('No 3D model'), 'missing 3D model is reported');
  ok(!(await page.isDisabled('#installBtn')), 'a part without a 3D model can still be installed');

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);
  await ctx.close();
  relay.close();
  console.log(`Screenshots: ${OUT}`);
})()
  .catch((e) => {
    console.log('FAIL ', e.message);
    process.exitCode = 1;
  })
  // The browser and mock relay must not keep the process alive after a failure.
  .finally(() => process.exit());
