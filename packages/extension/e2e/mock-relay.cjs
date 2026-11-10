// Local stand-in for the relay: same paths, answers from the saved fixtures.
const http = require('http');
const fs = require('fs');
const path = require('path');
const FIX = path.join(__dirname, '../src/lib/converter/__tests__/fixtures/');
const cors = { 'Access-Control-Allow-Origin': '*' };

/** A box body and a gold pad, with materials inline the way EasyEDA writes them (d 0.0 = solid). */
const box = (x0, y0, z0, x1, y1, z1, base) => {
  const v = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) v.push(`v ${x} ${y} ${z}`);
  const f = [[1, 2, 4, 3], [5, 7, 8, 6], [1, 5, 6, 2], [3, 4, 8, 7], [1, 3, 7, 5], [2, 6, 8, 4]]
    .map((q) => `f ${q.map((i) => i + base).join(' ')}`);
  return { v, f };
};
const body = box(-1, -0.6, 0, 1, 0.6, 0.5, 0);
const pad = box(-1.4, -0.3, 0, 1.4, 0.3, 0.12, 8);
/** Edge cases for the layout checks, built from the real TPS2116 data. */
const base = () => JSON.parse(fs.readFileSync(path.join(FIX, 'C3235557.json'), 'utf8'));
const LONG = 'TPS2116DRLRX-Q1-VERYLONGORDERINGCODE-WITH-NO-SPACES-AT-ALL-0123456789';
const EDGE = {
  // Every text field as long as it gets, no spaces to break on.
  C9999991: () => {
    const d = base();
    const c = d.result.dataStr.head.c_para;
    c['Manufacturer Part'] = LONG;
    c.Manufacturer = 'Texas Instruments Incorporated Semiconductor Group (德州仪器) Long Name';
    c.package = 'SOT-583-8_L2.1-W1.6-P0.50-LS1.6-BL-EXTRA-LONG-PACKAGE-NAME-0123456789';
    d.result.title = LONG;
    d.result.packageDetail.title = c.package;
    d.result.lcsc.number = 'C9999991';
    return d;
  },
  // Nothing optional: no maker, package, datasheet, author, or 3D model.
  C9999992: () => {
    const d = base();
    const c = d.result.dataStr.head.c_para;
    delete c.Manufacturer; delete c.Supplier; delete c.package;
    d.result.packageDetail.dataStr.shape = d.result.packageDetail.dataStr.shape.filter((x) => !x.startsWith('SVGNODE'));
    d.result.verify = false;
    d.result.owner = {};
    d.result.lcsc.number = 'C9999992';
    return d;
  },
};
/** Fifteen matches with extreme stock and price values. */
const MANY = Array.from({ length: 15 }, (_, i) => ({
  componentModelEn: i % 3 === 0 ? `${LONG}-${i}` : `PART-${i}`,
  lcscGoodsUrl: `https://www.lcsc.com/product-detail/C99999${10 + i}.html`,
  componentSpecificationEn: i % 2 ? 'SOT-583-8_L2.1-W1.6-P0.50-LS1.6-BL' : '',
  stockCount: [0, 3, 123456789][i % 3],
  componentPrices: i % 4 ? [{ productPrice: 1234.5678 }] : [],
  firstSortAccordingNameEn: 'Power Management ICs',
}));

const COLOURED_OBJ = [
  'newmtl body', 'Ka 0.1 0.1 0.1', 'Kd 0.12 0.12 0.13', 'd 0.0', 'endmtl',
  'newmtl pins', 'Kd 0.86 0.75 0.42', 'd 0.0', 'endmtl',
  ...body.v, ...pad.v,
  'usemtl body', ...body.f,
  'usemtl pins', ...pad.f,
  '',
].join('\n');
module.exports = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, ...cors }); res.end(body); };
  if (u.pathname === '/') return send(200, 'text/plain', 'kicad-part-relay ok v2');
  // A relay from before versioning, for the "outdated" note.
  if (u.pathname === '/old/' || u.pathname === '/old') return send(200, 'text/plain', 'kicad-part-relay ok');
  if (u.pathname === '/jlcpcb/search') {
    const kw = u.searchParams.get('keyword');
    if (kw === 'SLOW') {
      // Hold the answer so the "searching" state can be seen.
      return setTimeout(() => send(200, 'application/json', JSON.stringify({ code: 200, data: { componentPageInfo: { list: [] } } })), 4000);
    }
    if (kw === 'MANY') return send(200, 'application/json', JSON.stringify({ code: 200, data: { componentPageInfo: { list: MANY } } }));
    const hit = /TPS2116|C3235557/i.test(kw);
    const list = hit ? [{ componentModelEn: 'TPS2116DRLR', lcscGoodsUrl: 'https://www.lcsc.com/product-detail/C3235557.html', componentCode: 'C3235557', componentSpecificationEn: 'SOT-583-8', stockCount: 12840, componentPrices: [{ productPrice: 0.4123 }], firstSortAccordingNameEn: 'Power Management ICs', secondSortAccordingNameEn: 'Power Distribution Switches' }] : [];
    return send(200, 'application/json', JSON.stringify({ code: 200, data: { componentPageInfo: { list } } }));
  }
  if (u.pathname === '/easyeda/component') {
    const id = u.searchParams.get('lcsc');
    if (EDGE[id]) return send(200, 'application/json', JSON.stringify(EDGE[id]()));
    // Match-list parts (C9999910 and up) reuse the long-name part.
    if (/^C99999[1-9]\d$/.test(id)) { const d = EDGE.C9999991(); d.result.lcsc.number = id; return send(200, 'application/json', JSON.stringify(d)); }
    const f = FIX + id + '.json';
    return fs.existsSync(f) ? send(200, 'application/json', fs.readFileSync(f)) : send(200, 'application/json', '{"success":false}');
  }
  if (u.pathname === '/easyeda/model') return send(200, 'application/octet-stream', 'ISO-10303-21;\nHEADER;\n/* mock STEP for e2e */\nENDSEC;\nEND-ISO-10303-21;\n');
  if (u.pathname === '/easyeda/model-obj') return send(200, 'text/plain', COLOURED_OBJ);
  send(404, 'application/json', '{"error":"not found","status":404}');
  });
  server.listen(0, () => resolve(server));
});
