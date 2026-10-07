import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile } from 'node:fs/promises';

const raw = JSON.parse(await readFile(process.argv[2] || 'var/d2_RAW.geojson', 'utf8'));
let extensions = [];
try { extensions = JSON.parse(await readFile('var/d2-extensions.geojson', 'utf8')).features; raw.features.push(...extensions); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const catalog = JSON.parse(await readFile('config/d2-stations.json', 'utf8'));
const lines = raw.features.map((feature) => {
  assert.equal(feature.geometry.type, 'LineString');
  assert(feature.geometry.coordinates.every((point) => point.length === 2 && point.every(Number.isFinite)));
  return feature.geometry.coordinates;
});
const key = (point) => point.join(',');
const endpoints = new Map();
for (const [index, line] of lines.entries()) for (const point of [line[0], line.at(-1)]) {
  const id = key(point);
  if (!endpoints.has(id)) endpoints.set(id, []);
  endpoints.get(id).push(index);
}
assert([...endpoints.values()].every((links) => links.length <= 2), 'В линии обнаружено ответвление');
const leaves = [...endpoints.entries()].filter(([, links]) => links.length === 1).map(([id]) => id.split(',').map(Number));
assert.equal(leaves.length, 2, 'Ожидались два конца непрерывного маршрута');
const R = 6371008.8;
const rad = (value) => value * Math.PI / 180;
const distance = (a, b) => {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};
const firstStation = catalog.stations[0].location;
leaves.sort((a, b) => distance(a, [firstStation.longitude, firstStation.latitude]) - distance(b, [firstStation.longitude, firstStation.latitude]));
let tip = leaves[0];
const used = new Set();
const coordinates = [tip];
while (used.size < lines.length) {
  const next = endpoints.get(key(tip)).find((index) => !used.has(index));
  assert(next !== undefined, 'Маршрут содержит несвязанные компоненты');
  const line = key(lines[next][0]) === key(tip) ? lines[next] : [...lines[next]].reverse();
  coordinates.push(...line.slice(1));
  tip = line.at(-1); used.add(next);
}
const cumulativeMeters = [0];
for (let i = 1; i < coordinates.length; i++) cumulativeMeters.push(cumulativeMeters.at(-1) + distance(coordinates[i - 1], coordinates[i]));
const round = (value) => Math.round(value * 1000) / 1000;
function projectStation(station) {
  const origin = [station.location.longitude, station.location.latitude];
  const scale = Math.cos(rad(origin[1]));
  const xy = (point) => ({ x: R * rad(point[0] - origin[0]) * scale, y: R * rad(point[1] - origin[1]) });
  let best = null;
  for (let i = 1; i < coordinates.length; i++) {
    const a = xy(coordinates[i - 1]); const b = xy(coordinates[i]);
    const dx = b.x - a.x; const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy)));
    const gap = Math.hypot(a.x + t * dx, a.y + t * dy);
    if (!best || gap < best.gap) best = { gap, s: cumulativeMeters[i - 1] + t * (cumulativeMeters[i] - cumulativeMeters[i - 1]),
      point: coordinates[i - 1].map((value, dim) => value + t * (coordinates[i][dim] - value)) };
  }
  assert(best.gap < 150, `Станция ${station.name} удалена от маршрута на ${round(best.gap)} м`);
  return { ...station, apiToMoscowDirectionStep: station.directionZone === 'north' ? 1 : station.directionZone === 'south' ? -1 : null,
    alongTrackMeters: round(best.s), trackLocation: { longitude: best.point[0], latitude: best.point[1] }, trackOffsetMeters: round(best.gap) };
}
const stations = catalog.stations.map(projectStation);
for (let i = 1; i < stations.length; i++) assert(stations[i].alongTrackMeters > stations[i - 1].alongTrackMeters, 'Нарушен порядок станций');
const total = round(cumulativeMeters.at(-1));
const config = { ...catalog, schemaVersion: 3, status: undefined,
  section: { ...catalog.section, id: 'd2-nakhabino-podolsk', geometryFile: 'railway.geojson', geometryStatus: 'connected-and-station-alignment-checked',
    distanceUnit: 'meters', geometryRole: 'representative-path-for-both-directions', geometryLengthMeters: total,
    stationSpanMeters: round(stations.at(-1).alongTrackMeters - stations[0].alongTrackMeters),
    geometryExtensionBeforeMeters: stations[0].alongTrackMeters, geometryExtensionAfterMeters: round(total - stations.at(-1).alongTrackMeters) }, stations };
const geometry = { type: 'FeatureCollection', features: [{ type: 'Feature',
  properties: { source: 'OpenStreetMap, relation 10309306; user-provided Overpass GeoJSON; connected railway extensions from OSM API', attribution: 'OpenStreetMap contributors',
    extensionWayIds: extensions.flatMap((feature) => feature.properties.wayIds),
    stationOrder: stations.map((station) => station.id), cumulativeMeters: cumulativeMeters.map(round) },
  geometry: { type: 'LineString', coordinates } }] };
for (const [from, to] of [['config/stations.json', 'var/mvp-stations.json'], ['config/railway.geojson', 'var/mvp-railway.geojson']]) {
  try { await copyFile(from, to, 1); } catch (error) { if (error.code !== 'EEXIST') throw error; }
}
await writeFile('config/stations.json', JSON.stringify(config, null, 2) + '\n');
await writeFile('config/railway.geojson', JSON.stringify(geometry) + '\n');
console.log(JSON.stringify({ stations: stations.length, vertices: coordinates.length, lengthMeters: total,
  extensions: [config.section.geometryExtensionBeforeMeters, config.section.geometryExtensionAfterMeters],
  maxOffsetMeters: Math.max(...stations.map((station) => station.trackOffsetMeters)) }));
