import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCorridor, tileBounds } from '../src/corridor.js';

const metersToDegrees = (meters) => meters / 6371008.8 * 180 / Math.PI;
const bounds = (west, south, east, north) => ({ west, south, east, north });
const line = (coordinates, stationLocations = [], bufferMeters = 500) => createCorridor({ coordinates, stationLocations, bufferMeters });

test('тайл разрешён при пересечении края, даже если его центр далеко от пути', () => {
  const corridor = line([[-0.01, 0], [0.03, 0]]);
  assert(corridor.intersectsBounds(bounds(0, -0.04, 0.02, 0.0001)));
});

test('пересечение отрезком снаружи в снаружи, без вершин внутри прямоугольника', () => {
  assert(line([[-0.02, -0.02], [0.02, 0.02]], [], 0).intersectsBounds(bounds(-0.001, -0.001, 0.001, 0.001)));
});

test('500-метровая граница: 490 м разрешено, 510 м отклонено', () => {
  const corridor = line([[-0.01, 0], [0.01, 0]]);
  assert(corridor.intersectsBounds(bounds(-0.001, metersToDegrees(490), 0.001, 0.01)));
  assert(!corridor.intersectsBounds(bounds(-0.001, metersToDegrees(510), 0.001, 0.01)));
});

test('круглый буфер у конца линии, а не расширенный квадрат bbox', () => {
  const corridor = line([[-0.02, 0], [0, 0]]);
  assert(corridor.intersectsBounds(bounds(metersToDegrees(300), metersToDegrees(300), 0.01, 0.01)));
  assert(!corridor.intersectsBounds(bounds(metersToDegrees(400), metersToDegrees(400), 0.01, 0.01)));
});

test('буфер вокруг исходной станции тоже разрешает тайл', () => {
  const rectangle = bounds(-0.0001, -0.0201, 0.0001, -0.0199);
  assert(!line([[-0.01, 0], [0.01, 0]]).intersectsBounds(rectangle));
  assert(line([[-0.01, 0], [0.01, 0]], [[0, -0.02]]).intersectsBounds(rectangle));
});

test('метры долготы учитывают московскую широту', () => {
  const longitudeOffset = (meters) => metersToDegrees(meters) / Math.cos(55.8 * Math.PI / 180);
  const corridor = line([[37, 55.79], [37, 55.81]]);
  assert(corridor.intersectsBounds(bounds(37 + longitudeOffset(490), 55.795, 37.02, 55.805)));
  assert(!corridor.intersectsBounds(bounds(37 + longitudeOffset(510), 55.795, 37.02, 55.805)));
});

test('формулы XYZ: правильные границы и ориентация север/юг', () => {
  assert.equal(tileBounds({ x: 1, y: 1, z: 1 }).west, 0);
  assert.equal(tileBounds({ x: 1, y: 1, z: 1 }).east, 180);
  assert.equal(tileBounds({ x: 1, y: 1, z: 1 }).north, 0);
  assert(tileBounds({ x: 1, y: 1, z: 1 }).south < -85);
});

test('реальная геометрия: все станции разрешены, удалённые области отклонены на z12–18', async () => {
  const railway = JSON.parse(await readFile(new URL('../config/railway.geojson', import.meta.url), 'utf8'));
  const config = JSON.parse(await readFile(new URL('../config/stations.json', import.meta.url), 'utf8'));
  const corridor = line(railway.features[0].geometry.coordinates,
    config.stations.map((s) => [s.location.longitude, s.location.latitude]));
  const tileAt = (lon, lat, z) => {
    const n = 2 ** z;
    const phi = lat * Math.PI / 180;
    return { z, x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n) };
  };
  for (let z = 12; z <= 18; z++) {
    for (const s of config.stations) assert(corridor.intersectsTile(tileAt(s.location.longitude, s.location.latitude, z)), `${s.name}, z${z}`);
    assert(!corridor.intersectsTile(tileAt(37.56, 55.85, z)));
    assert(!corridor.intersectsTile(tileAt(37.56, 55.76, z)));
  }
});
