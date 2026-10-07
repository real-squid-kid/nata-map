import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const stations = await readJson('../config/stations.json');
const railway = await readJson('../config/railway.geojson');
const app = await readJson('../config/app.json');

// Проверяем восстановление переданных данных, включая единицы и соответствие расстояний.
assert.equal(stations.stations.length, 37);
assert.equal(stations.pollStationApiIds.length, 23);
assert.deepEqual(stations.stations.filter((s) => s.pollEnabled).map((s) => s.apiStationId).sort(), [...stations.pollStationApiIds].sort());
assert.equal(railway.type, 'FeatureCollection');
assert.equal(railway.features.length, 1);
const { geometry, properties } = railway.features[0];
assert.equal(geometry.type, 'LineString');
assert(geometry.coordinates.length >= 1312);
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
  assert(station.alongTrackMeters >= 0 && station.alongTrackMeters <= total + 0.001);
  assert.equal(station.apiToMoscowDirectionStep, station.directionZone === 'north' ? 1 : station.directionZone === 'south' ? -1 : null);
  if (index > 0) assert(station.alongTrackMeters > stations.stations[index - 1].alongTrackMeters);
  assert(Math.abs(distance(
    [station.location.longitude, station.location.latitude],
    [station.trackLocation.longitude, station.trackLocation.latitude],
  ) - station.trackOffsetMeters) < 0.05, 'Повреждена проекция станции');
}
assert.equal(app.timezone, stations.timezone);
assert.equal(app.motion.anchorField, 'departureTime');
assert(app.collector.minRequestIntervalMs >= 1000);
assert(app.collector.cyclePauseSeconds >= 300);
assert.equal(app.map.trainRendering.wagonCount, 6);
assert.equal(app.map.trainRendering.spriteMinZoom, 14);
assert.equal(app.map.trainRendering.nightSpriteMinZoom, 15);
assert(app.map.nightDimmingOpacity > app.map.dimmingOpacity);
const fadeCoverage = app.motion.fallbackSpeedKmh / 3.6 * app.motion.edgeFadeSeconds + app.motion.trainLengthMeters / 2;
assert(stations.section.geometryExtensionBeforeMeters > fadeCoverage);
assert(stations.section.geometryExtensionAfterMeters > fadeCoverage);
const fullD2 = await readJson('../config/d2-stations.json');
assert.deepEqual(stations.section.destinationDirections, fullD2.section.destinationDirections);
assert(Object.values(stations.section.destinationDirections).every((direction) => direction === 1 || direction === -1));
assert.equal(fullD2.stations.length, 37);
assert.equal(fullD2.pollStationApiIds.length, 23);
assert.equal(new Set(fullD2.stations.map((station) => station.id)).size, fullD2.stations.length);
assert.equal(new Set(fullD2.pollStationApiIds).size, fullD2.pollStationApiIds.length);
assert.equal(fullD2.stations[0].id, 'nakhabino');
assert.equal(fullD2.stations.at(-1).id, 'podolsk');
for (const [order, station] of fullD2.stations.entries()) {
  assert.equal(station.order, order);
  assert(station.location.latitude > 55.4 && station.location.latitude < 55.9);
  assert(station.location.longitude > 37.1 && station.location.longitude < 37.8);
  if (order > 0) assert.notDeepEqual(station.location, fullD2.stations[order - 1].location, 'У соседних станций одинаковые координаты');
}
console.log(`D2 проверен: ${stations.stations.length} станций, ${stations.pollStationApiIds.length} ID API, ${geometry.coordinates.length} вершин, ${total.toFixed(3)} м.`);
