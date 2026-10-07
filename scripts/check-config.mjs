import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const stations = await readJson('../config/stations.json');
const railway = await readJson('../config/railway.geojson');
const app = await readJson('../config/app.json');

// Проверяем восстановление переданных данных, включая единицы и соответствие расстояний.
assert.equal(stations.stations.length, 5);
assert.deepEqual(stations.pollStationApiIds, [4127, 4128, 4129]);
assert.deepEqual(stations.stations.filter((s) => s.pollEnabled).map((s) => s.apiStationId).sort(), [4127, 4128, 4129]);
assert.equal(railway.type, 'FeatureCollection');
assert.equal(railway.features.length, 1);
const { geometry, properties } = railway.features[0];
assert.equal(geometry.type, 'LineString');
assert.equal(geometry.coordinates.length, 165);
assert.equal(properties.cumulativeMeters.length, geometry.coordinates.length);
assert.equal(properties.cumulativeMeters[0], 0);
assert.equal(properties.cumulativeMeters.at(-1), stations.section.geometryLengthMeters);
assert.deepEqual(properties.stationOrder, stations.stations.map((s) => s.id));

const radians = (degrees) => degrees * Math.PI / 180;
const distance = ([lonA, latA], [lonB, latB]) => {
  const a = Math.sin(radians(latB - latA) / 2) ** 2
    + Math.cos(radians(latA)) * Math.cos(radians(latB)) * Math.sin(radians(lonB - lonA) / 2) ** 2;
  return 2 * 6371008.8 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
let total = 0;
for (let i = 0; i < geometry.coordinates.length; i++) {
  const point = geometry.coordinates[i];
  assert(point.length === 2 && point.every(Number.isFinite));
  assert(point[0] > 37 && point[0] < 38 && point[1] > 55 && point[1] < 56, 'Перепутан порядок координат');
  if (i > 0) {
    assert(properties.cumulativeMeters[i] > properties.cumulativeMeters[i - 1]);
    total += distance(geometry.coordinates[i - 1], point);
  }
  assert(Math.abs(total - properties.cumulativeMeters[i]) < 0.01, 'Повреждены накопленные расстояния');
}
for (const [index, station] of stations.stations.entries()) {
  assert.equal(station.order, index);
  assert(station.alongTrackMeters > 0 && station.alongTrackMeters < total);
  if (index > 0) assert(station.alongTrackMeters > stations.stations[index - 1].alongTrackMeters);
  assert(Math.abs(distance(
    [station.location.longitude, station.location.latitude],
    [station.trackLocation.longitude, station.trackLocation.latitude],
  ) - station.trackOffsetMeters) < 0.05, 'Повреждена проекция станции');
}
assert.equal(app.timezone, stations.timezone);
assert.equal(app.motion.anchorField, 'departureTime');
assert(app.collector.minRequestIntervalMs >= 1000);
assert(app.collector.cyclePauseSeconds >= 120);
console.log(`Конфиги проверены: 5 станций, 165 вершин, ${total.toFixed(3)} м.`);
