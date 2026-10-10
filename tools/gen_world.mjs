// Builds the World Map's hex tiles from Natural Earth (public domain) country shapes.
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/nvkelso/natural-earth-vector ne
//   (cd ne && git sparse-checkout set --no-cone /geojson/ne_50m_admin_0_countries.geojson \
//      /geojson/ne_50m_populated_places_simple.geojson /geojson/ne_10m_geography_regions_polys.geojson /geojson/ne_50m_lakes.geojson)
//   node tools/gen_world.mjs ne/geojson <game folder>
// Writes src/world.js (the server's copy: tile coordinates and countries) and <game folder>/map/world.json (the game's copy,
// with country names in the game's 8 languages). The map uses the Equal Earth projection, so every tile covers the same area
// of the real world, and pointy-top hexes in axial coordinates (q, r).
import fs from 'node:fs';
import path from 'node:path';

const [dir, gameDir] = process.argv.slice(2);
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const TARGET = +(process.env.TILES || 5000);

// Equal Earth projection (Šavrič, Patterson, Jenny 2018), radius 1
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;
function project(lon, lat) {
  const l = lon * Math.PI / 180, t = Math.asin(M * Math.sin(lat * Math.PI / 180)), t2 = t * t, t6 = t2 * t2 * t2;
  return [2 * Math.sqrt(3) * l * Math.cos(t) / (3 * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1)), A4 * t6 * t2 * t + A3 * t6 * t + A2 * t2 * t + A1 * t];
}
function unproject(x, y) {
  let t = y;
  for (let i = 0; i < 20; i++) { const t2 = t * t, t6 = t2 * t2 * t2, f = A4 * t6 * t2 * t + A3 * t6 * t + A2 * t2 * t + A1 * t - y, d = 9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1; t -= f / d; if (Math.abs(f) < 1e-12) break }
  const t2 = t * t, t6 = t2 * t2 * t2, lon = 3 * x * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1) / (2 * Math.sqrt(3) * Math.cos(t));
  return [lon * 180 / Math.PI, Math.asin(Math.sin(t) / M) * 180 / Math.PI];
}

// polygons with bounding boxes, in lon/lat
function polys(geom) { return geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [] }
function prep(features, keep) {
  const out = [];
  for (const f of features) { if (keep && !keep(f)) continue;
    for (const p of polys(f.geometry)) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
      out.push({ f, rings: p, box: [x0, y0, x1, y1], area: (x1 - x0) * (y1 - y0) }) } }
  return out;
}
function inRing(r, x, y) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c } return c }
function hit(list, x, y) {
  for (const p of list) { const b = p.box; if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    if (inRing(p.rings[0], x, y) && !p.rings.slice(1).some(h => inRing(h, x, y))) return p.f }
  return null;
}

const countries = read('ne_50m_admin_0_countries.geojson').features.filter(f => f.properties.CONTINENT !== 'Antarctica' && f.properties.ADM0_A3 !== 'ATF');
const code = p => { const c = p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : p.ADM0_A3 === 'SOL' ? 'SO' : p.ADM0_A3 === 'CYN' ? 'CY' : p.ADM0_A3 === 'KAS' ? 'IN' : null; return c };
const CP = prep(countries, f => code(f.properties));
CP.sort((a, b) => a.area - b.area);                                     // small shapes first: an enclave wins over the country around it
const lakes = prep(read('ne_50m_lakes.geojson').features, f => (f.properties.scalerank ?? 9) <= 1);
const regions = read('ne_10m_geography_regions_polys.geojson').features;
const DESERT = prep(regions, f => f.properties.FEATURECLA === 'Desert');
const MOUNT = prep(regions, f => (f.properties.FEATURECLA === 'Range/mtn' && f.properties.SCALERANK <= 3) || /Tibet/.test(f.properties.NAME || ''));
const TUNDRA = prep(regions, f => f.properties.FEATURECLA === 'Tundra');
const places = read('ne_50m_populated_places_simple.geojson').features.map(f => f.properties);

// hex grid in projected units: pointy-top, axial (q, r); y grows downward on screen
const SQ3 = Math.sqrt(3);
const centre = (s, q, r) => [s * SQ3 * (q + r / 2), s * 1.5 * r];
const XMAX = 2.7066, YMAX = 1.3175, LATMIN = -57;
const OFF = [[0, 0], ...[0, 1, 2, 3, 4, 5].map(k => [Math.cos(Math.PI / 6 + k * Math.PI / 3) * .62, Math.sin(Math.PI / 6 + k * Math.PI / 3) * .62])];
function countryAt(lon, lat) { if (lat < LATMIN) return null; if (hit(lakes, lon, lat)) return null; return hit(CP, lon, lat) }
function grid(s) {
  const tiles = [], rmax = Math.ceil(YMAX / (1.5 * s)) + 1;
  for (let r = -rmax; r <= rmax; r++) { const qmax = Math.ceil(XMAX / (SQ3 * s)) + Math.abs(r);
    for (let q = -qmax; q <= qmax; q++) { const [cx, cy] = centre(s, q, r); if (Math.abs(cx) > XMAX || Math.abs(cy) > YMAX) continue;
      const votes = new Map(); let land = 0;
      for (const [ox, oy] of OFF) { const [lon, lat] = unproject(cx + ox * s, -(cy + oy * s)); if (!(Math.abs(lon) <= 180)) continue;
        const f = countryAt(lon, lat); if (!f) continue; land++; const c = code(f.properties); votes.set(c, (votes.get(c) || 0) + 1) }
      if (land >= 3 || (land >= 1 && votes.size && countryAt(...unproject(cx, -cy)))) {
        const cc = [...votes].sort((a, b) => b[1] - a[1])[0][0]; tiles.push({ q, r, cc }) } } }
  return tiles;
}
// find the hex size that gives about TARGET land tiles
let lo = 0.005, hi = 0.05, tiles, s;
for (let i = 0; i < 14; i++) { s = (lo + hi) / 2; tiles = grid(s); if (tiles.length > TARGET) lo = s; else hi = s; if (Math.abs(tiles.length - TARGET) < TARGET * .01) break }
console.log('hex size', s.toFixed(5), 'tiles', tiles.length);

// every country gets at least one tile: tiny ones take the hex over their label point (even out at sea)
const key = (q, r) => q + ',' + r, byKey = new Map(tiles.map(t => [key(t.q, t.r), t]));
function hexAt(x, y) {           // projected point -> axial hex (cube rounding)
  const qf = (SQ3 / 3 * x - y / 3) / s, rf = (2 / 3 * y) / s, xf = qf, zf = rf, yf = -xf - zf;
  let rx = Math.round(xf), ry = Math.round(yf), rz = Math.round(zf); const dx = Math.abs(rx - xf), dy = Math.abs(ry - yf), dz = Math.abs(rz - zf);
  if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry; return [rx, rz];
}
const seen = new Set(tiles.map(t => t.cc));
const byCountry = new Map(); for (const f of countries) { const c = code(f.properties); if (c && !byCountry.has(c)) byCountry.set(c, f) }
for (const [c, f] of byCountry) { if (seen.has(c)) continue; const p = f.properties, [x, y] = project(p.LABEL_X, p.LABEL_Y), [q, r] = hexAt(x, -y), k = key(q, r);
  if (byKey.has(k)) { const t = byKey.get(k), n = tiles.filter(o => o.cc === t.cc).length; if (n > 3) { t.cc = c; seen.add(c) } }
  else { const t = { q, r, cc: c }; tiles.push(t); byKey.set(k, t); seen.add(c) } }

// terrain: d desert, m mountain, s snow and ice, t tundra, f northern forest, j jungle, g grassland, c city (capitals, megacities)
const capitals = places.filter(p => p.featurecla === 'Admin-0 capital' || p.pop_max > 8e6);
for (const t of tiles) { const [cx, cy] = centre(s, t.q, t.r), [lon, lat] = unproject(cx, -cy); t.lon = lon; t.lat = lat;
  let ter = 'g';
  if (t.cc === 'GL' || lat > 72) ter = 's';
  else if (hit(DESERT, lon, lat)) ter = 'd';
  else if (hit(MOUNT, lon, lat)) ter = lat > 50 ? 's' : 'm';
  else if (hit(TUNDRA, lon, lat) || lat > 64) ter = 't';
  else if (lat > 52) ter = 'f';
  else if (Math.abs(lat) < 13) ter = 'j';
  t.t = ter }
// deserts the regions file leaves as plain grass: the big dry belts, roughly
for (const t of tiles) if (t.t === 'g') { const { lon, lat } = t;
  if ((lat > 15 && lat < 32 && lon > -15 && lon < 60) || (lat > -32 && lat < -19 && lon > 117 && lon < 141) || (lat > 38 && lat < 46 && lon > 92 && lon < 112) || (lat > -28 && lat < -18 && lon > 13 && lon < 24)) t.t = 'd' }
for (const p of capitals) { const [x, y] = project(p.longitude, p.latitude), [q, r] = hexAt(x, -y), t = byKey.get(key(q, r)); if (t && (p.featurecla === 'Admin-0 capital' ? t.cc === p.iso_a2 || true : true)) { t.t = 'c'; t.city = t.city || p.name } }

// output: countries by tile count, names in the game's languages
const ccs = [...new Set(tiles.map(t => t.cc))];
const meta = ccs.map(c => { const f = byCountry.get(c), p = f.properties;
  return { cc: c, name: c === 'US' ? 'USA' : p.NAME || p.NAME_EN, es: p.NAME_ES, pt: p.NAME_PT, fr: p.NAME_FR, de: p.NAME_DE, ru: p.NAME_RU, tr: p.NAME_TR, zh: p.NAME_ZH } });
const ci = new Map(ccs.map((c, i) => [c, i]));
tiles.sort((a, b) => a.r - b.r || a.q - b.q);
const T = 'dmstfjgc';
const packed = tiles.map(t => [t.q, t.r, ci.get(t.cc), T.indexOf(t.t)]);
fs.writeFileSync('src/world.js', `// World Map tiles, made by tools/gen_world.mjs from Natural Earth. Tile id = index. Each tile is [q, r, country, terrain]:
// axial hex coordinates, an index into COUNTRIES (ISO codes) and an index into TERRAIN.
export const HEX = ${s.toFixed(6)};
export const TERRAIN = '${T}';
export const COUNTRIES = ${JSON.stringify(ccs)};
export const TILES = ${JSON.stringify(packed)};
`);
fs.mkdirSync(path.join(gameDir, 'map'), { recursive: true });
fs.writeFileSync(path.join(gameDir, 'map', 'world.json'), JSON.stringify({ hex: +s.toFixed(6), terrain: T, countries: meta, tiles: packed, cities: tiles.map((t, i) => t.city ? [i, t.city] : null).filter(Boolean) }));
const count = {}; for (const t of tiles) count[t.t] = (count[t.t] || 0) + 1;
console.log('countries', ccs.length, 'terrain', count, 'UY', tiles.filter(t => t.cc === 'UY').length, 'US', tiles.filter(t => t.cc === 'US').length, 'RU', tiles.filter(t => t.cc === 'RU').length, 'singletons', ccs.filter(c => tiles.filter(t => t.cc === c).length < 3).length);
