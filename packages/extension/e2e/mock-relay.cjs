// Local stand-in for the relay: same paths, answers from the saved fixtures.
const http = require('http');
const fs = require('fs');
const path = require('path');
const FIX = path.join(__dirname, '../src/lib/converter/__tests__/fixtures/');
const cors = { 'Access-Control-Allow-Origin': '*' };

/** A box body and a gold pad, with materials inline the way EasyEDA writes them. */
const box = (x0, y0, z0, x1, y1, z1, base) => {
  const v = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) v.push(`v ${x} ${y} ${z}`);
  const f = [[1, 2, 4, 3], [5, 7, 8, 6], [1, 5, 6, 2], [3, 4, 8, 7], [1, 3, 7, 5], [2, 6, 8, 4]]
    .map((q) => `f ${q.map((i) => i + base).join(' ')}`);
  return { v, f };
};
const body = box(-1, -0.6, 0, 1, 0.6, 0.5, 0);
const pad = box(-1.4, -0.3, 0, 1.4, 0.3, 0.12, 8);
const COLOURED_OBJ = [
  'newmtl body', 'Ka 0.1 0.1 0.1', 'Kd 0.12 0.12 0.13', 'd 1', 'endmtl',
  'newmtl pins', 'Kd 0.86 0.75 0.42', 'd 1', 'endmtl',
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
  if (u.pathname === '/jlcpcb/search') {
    const kw = u.searchParams.get('keyword');
    const hit = /TPS2116|C3235557/i.test(kw);
    const list = hit ? [{ componentModelEn: 'TPS2116DRLR', lcscGoodsUrl: 'https://www.lcsc.com/product-detail/C3235557.html', componentCode: 'C3235557', componentSpecificationEn: 'SOT-583-8', stockCount: 12840, componentPrices: [{ productPrice: 0.4123 }], firstSortAccordingNameEn: 'Power Management ICs', secondSortAccordingNameEn: 'Power Distribution Switches' }] : [];
    return send(200, 'application/json', JSON.stringify({ code: 200, data: { componentPageInfo: { list } } }));
  }
  if (u.pathname === '/easyeda/component') {
    const id = u.searchParams.get('lcsc');
    const f = FIX + id + '.json';
    return fs.existsSync(f) ? send(200, 'application/json', fs.readFileSync(f)) : send(200, 'application/json', '{"success":false}');
  }
  if (u.pathname === '/easyeda/model') return send(200, 'application/octet-stream', 'ISO-10303-21;\nHEADER;\n/* mock STEP for e2e */\nENDSEC;\nEND-ISO-10303-21;\n');
  if (u.pathname === '/easyeda/model-obj') return send(200, 'text/plain', COLOURED_OBJ);
  send(404, 'application/json', '{"error":"not found","status":404}');
  });
  server.listen(0, () => resolve(server));
});
