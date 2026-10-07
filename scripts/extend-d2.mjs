import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const raw = JSON.parse(await readFile(process.argv[2] || 'var/d2_RAW.geojson', 'utf8'));
const source = JSON.parse(await readFile('var/d2-route-full-preview.json', 'utf8'));
const usedWays = new Set(source.elements.filter((element) => element.type === 'relation' && element.id === 10309306)[0].members
  .filter((member) => member.type === 'way' && member.role === '').map((member) => member.ref));
const R = 6371008.8;
const rad = (degrees) => degrees * Math.PI / 180;
const distance = (a, b) => {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};
const endpoints = new Map();
for (const feature of raw.features) {
  assert.equal(feature.geometry.type, 'LineString');
  const line = feature.geometry.coordinates;
  for (const [tip, prior] of [[line[0], line[1]], [line.at(-1), line.at(-2)]]) {
    const key = tip.join(',');
    const entry = endpoints.get(key) || { tip, prior, count: 0 };
    entry.count++; endpoints.set(key, entry);
  }
}
const ends = [...endpoints.values()].filter((endpoint) => endpoint.count === 1);
assert.equal(ends.length, 2, 'Ожидались два края исходного маршрута');
const firstStation = JSON.parse(await readFile('config/d2-stations.json', 'utf8')).stations[0].location;
const first = [firstStation.longitude, firstStation.latitude];
ends.sort((a, b) => distance(a.tip, first) - distance(b.tip, first));
async function osm(path) {
  const cachePath = `var/osm-${path.replaceAll('/', '-')}.json`;
  try { return JSON.parse(await readFile(cachePath, 'utf8')).elements; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const response = await fetch(`https://api.openstreetmap.org/api/0.6/${path}.json`, {
    headers: { 'User-Agent': 'nata-map/0.1 (local railway geometry preparation)' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OSM HTTP ${response.status}; Retry-After: ${response.headers.get('retry-after') || 'не указан'}`);
  }
  const data = await response.json();
  await writeFile(cachePath, JSON.stringify(data));
  return data.elements;
}
const features = [];
for (const [index, end] of ['before', 'after'].entries()) {
  const routeTip = ends[index].tip;
  let prior = ends[index].prior;
  let node = source.elements.find((element) => element.type === 'node' && distance([element.lon, element.lat], routeTip) < 0.01);
  assert(node, 'Не найден OSM-узел края маршрута');
  const coordinates = [routeTip]; const wayIds = []; let length = 0;
  while (length < 800) {
    const tip = coordinates.at(-1);
    const candidates = (await osm(`node/${node.id}/ways`)).filter((way) => way.type === 'way'
      && way.tags?.railway === 'rail' && !usedWays.has(way.id));
    const choices = [];
    for (const candidate of candidates) {
      const full = await osm(`way/${candidate.id}/full`);
      const nodes = new Map(full.filter((element) => element.type === 'node').map((element) => [element.id, element]));
      const index = candidate.nodes.indexOf(node.id);
      for (const ids of [candidate.nodes.slice(index), candidate.nodes.slice(0, index + 1).reverse()]) {
        if (ids.length < 2) continue;
        const points = ids.map((id) => [nodes.get(id).lon, nodes.get(id).lat]);
        const dx = (tip[0] - prior[0]) * Math.cos(rad(tip[1])); const dy = tip[1] - prior[1];
        const nx = (points[1][0] - tip[0]) * Math.cos(rad(tip[1])); const ny = points[1][1] - tip[1];
        const alignment = (dx * nx + dy * ny) / (Math.hypot(dx, dy) * Math.hypot(nx, ny));
        choices.push({ candidate, points, nodes, ids, alignment });
      }
    }
    choices.sort((a, b) => b.alignment - a.alignment);
    const choice = choices[0];
    assert(choice && choice.alignment > 0.5, `Нет подходящего продолжения ${end} за краем D2`);
    usedWays.add(choice.candidate.id); wayIds.push(choice.candidate.id);
    for (const point of choice.points.slice(1)) {
      const previous = coordinates.at(-1); const segment = distance(previous, point);
      if (length + segment >= 800) {
        const t = (800 - length) / segment;
        coordinates.push(previous.map((value, axis) => value + t * (point[axis] - value))); length = 800; break;
      }
      length += segment; coordinates.push(point);
    }
    prior = coordinates.at(-2);
    node = choice.nodes.get(choice.ids.at(-1));
  }
  features.push({ type: 'Feature', properties: { source: 'OpenStreetMap API, connected main railway ways', wayIds, end },
    geometry: { type: 'LineString', coordinates } });
  console.log(JSON.stringify({ end, lengthMeters: Math.round(length), vertices: coordinates.length, wayIds }));
}
await writeFile('var/d2-extensions.geojson', JSON.stringify({ type: 'FeatureCollection', features }));
