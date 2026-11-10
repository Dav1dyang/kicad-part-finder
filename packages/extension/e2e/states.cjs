/**
 * State gallery: drives the built extension through every UI state and saves
 * one contact sheet per theme, for design review. Run after `vite build`:
 *   node e2e/states.cjs
 * Prints the folder with light.png and dark.png.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const p = require('path');
const startRelay = require('./mock-relay.cjs');

const DIST = p.join(__dirname, '../dist');
const OUT = fs.mkdtempSync(p.join(os.tmpdir(), 'kpf-states-'));
const WIDTH = 360;

async function grantFolder(page) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const lib = await root.getDirectoryHandle('kicad-libraries', { create: true });
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
}

async function run(scheme) {
  const relay = await startRelay();
  const RELAY = `http://localhost:${relay.address().port}`;
  const ctx = await chromium.launchPersistentContext(p.join(OUT, `profile-${scheme}`), {
    headless: true,
    channel: 'chromium',
    colorScheme: scheme,
    viewport: { width: WIDTH, height: 900 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const page = await ctx.newPage();
  const url = `chrome-extension://${id}/src/sidepanel/index.html`;
  const shots = [];
  const shot = async (name, opts = {}) => {
    await page.waitForTimeout(opts.wait ?? 250);
    const file = p.join(OUT, `${scheme}-${String(shots.length + 1).padStart(2, '0')}.png`);
    const target = opts.selector ? page.locator(opts.selector) : page;
    await target.screenshot({ path: file, ...(opts.selector ? {} : { fullPage: !opts.viewport }) });
    shots.push({ name, file });
  };
  const search = async (q) => {
    await page.fill('#searchInput', q);
    await page.press('#searchInput', 'Enter');
    await page.waitForSelector('#partCard:not(.hidden), #searchStatus.error, #candidateSection:not(.hidden)', { timeout: 15000 });
  };

  // 1. First run: nothing set up.
  await page.goto(url);
  await shot('First run', { viewport: true });

  // 2. Relay test failing.
  await page.fill('#relayUrlInputSetup', 'http://localhost:1');
  await page.click('#relayTestBtnSetup');
  await page.waitForSelector('#relayNoteSetup.is-error', { timeout: 15000 });
  await shot('Relay unreachable', { selector: '#setupView' });

  // 3. Relay set, no folder: search works, install disabled.
  await sw.evaluate((u) => chrome.storage.local.set({ relayUrl: u }), RELAY);
  await page.reload();
  await search('C3235557');
  await shot('No folder yet (Install off)');

  // 4. Folder connected, verified part, keyboard focus on Install.
  await grantFolder(page);
  await page.reload();
  await search('C3235557');
  await page.focus('#bucketSelect');
  await page.keyboard.press('Tab');
  await shot('Verified part, focus on Install');

  // 5. Library dropdown focused (the open menu is the system's own).
  await page.focus('#bucketSelect');
  await shot('Library select focused', { selector: '.dest-field' });

  // 6. Hover on a secondary action and a source link.
  await page.hover('.source-link');
  await shot('Hover: other source', { selector: '#secondarySources' });

  // 7. Searching.
  await page.fill('#searchInput', 'SLOW');
  await page.press('#searchInput', 'Enter');
  await shot('Searching', { selector: '.search-block', wait: 400 });
  await page.waitForSelector('#searchStatus.error', { timeout: 15000 });
  await shot('No match', { selector: '.search-block' });

  // 8. Several matches.
  await search('MANY');
  await page.waitForSelector('#partCard:not(.hidden)', { timeout: 15000 });
  await shot('Several matches', { selector: '#candidateSection' });

  // 9. Community part with a missing pad: checks open.
  await search('C9999992');
  await shot('Community part, checks open');

  // 10. Installing, then installed.
  await search('C3235557');
  await page.click('#installBtn');
  await page.waitForSelector('#installBtn.is-done', { timeout: 15000 });
  await shot('Installed', { selector: '.card-foot' });

  // 11. A part detected on the page while a card is open.
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'PART_DETECTED', part: { mpn: 'LM358DR', source: 'digikey', pageUrl: '' } }));
  await page.waitForSelector('#detectedOffer:not(.hidden)', { timeout: 5000 }).catch(() => {});
  await shot('Detected part offered', { selector: '.search-block' });

  // 12. Settings, shortcuts open, one being recorded.
  await page.click('#settingsBtn');
  await page.click('.shortcuts-disclosure > summary');
  await page.click('#panelShortcuts .keys-btn');
  await shot('Settings, recording a shortcut', { selector: '#settingsPanel' });
  await page.keyboard.press('Escape');

  // 13. Drawings up close: symbol and footprint must read in both themes.
  await page.click('#settingsBtn');
  await page.click('#previewTabSymbol');
  await shot('Symbol drawing', { selector: '.preview' });
  await page.click('#previewTabFootprint');
  await shot('Footprint drawing', { selector: '.preview' });

  // 14. 3D tab.
  await page.click('#previewTab3d');
  await shot('3D preview', { selector: '.preview', wait: 1500 });

  await ctx.close();
  relay.close();
  return shots;
}

async function sheet(browser, scheme, shots) {
  const page = await browser.newPage({ viewport: { width: 4 * 380 + 40, height: 800 } });
  const cells = shots
    .map((s) => `<figure><figcaption>${s.name}</figcaption><img src="data:image/png;base64,${fs.readFileSync(s.file).toString('base64')}"></figure>`)
    .join('');
  await page.setContent(`<style>body{margin:16px;display:grid;grid-template-columns:repeat(4,360px);gap:24px 20px;align-items:start;font:600 14px Helvetica;background:#fff}figure{margin:0}img{width:360px;display:block}figcaption{margin:0 0 6px}</style>${cells}`);
  await page.screenshot({ path: p.join(OUT, `${scheme}.png`), fullPage: true });
  await page.close();
}

(async () => {
  const browser = await chromium.launch();
  for (const scheme of ['light', 'dark']) await sheet(browser, scheme, await run(scheme));
  await browser.close();
  console.log(OUT);
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
