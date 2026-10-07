import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTrips } from '../src/trips.js';
import { getTrainPosition } from '../src/motion.js';

const config = JSON.parse(await readFile(new URL('../config/stations.json', import.meta.url), 'utf8'));
const app = JSON.parse(await readFile(new URL('../config/app.json', import.meta.url), 'utf8'));
const response = await fetch('http://127.0.0.1:5173/api/state');
assert.equal(response.status, 200);
const state = await response.json();
assert.equal(state.schemaVersion, 1);
const snapshots = Object.values(state.stations);
assert.equal(snapshots.length, config.pollStationApiIds.length);
assert(snapshots.every((s) => s.lastSuccessfulAt || s.error), 'Каждая станция должна иметь результат попытки опроса');
assert(snapshots.some((s) => s.lastSuccessfulAt && s.trains.length), 'Нужно доступное реальное расписание');
const model = buildTrips(state, config);
const now = Date.now();
const active = model.trips.map((trip) => ({ trip, position: getTrainPosition(trip, now, config.stations, app.motion, config.section.geometryLengthMeters) }))
  .filter((entry) => entry.position.visible);
assert(model.trips.some((trip) => trip.anchors.length > 1), 'Нужны сопоставленные времена нескольких станций');
assert(active.every((entry) => Number.isFinite(entry.position.centerMeters)));
console.log(JSON.stringify({
  stations: snapshots.map((s) => ({ id: s.apiStationId, records: s.trains.length, updated: s.lastSuccessfulAt, needReload: s.needReload })),
  errors: snapshots.filter((s) => s.error).map((s) => ({ stationId: s.stationId, error: s.error })),
  trips: model.trips.length, withMultipleAnchors: model.trips.filter((trip) => trip.anchors.length > 1).length,
  activeTrains: active.length,
  sourceFlagsChangedWithinRun: model.trips.filter((trip) => new Set(trip.anchors.map((anchor) => anchor.toMoscow)).size > 1).length,
  directionZones: Object.fromEntries(['north', 'south'].map((zone) => [zone, config.stations.filter((station) => station.directionZone === zone && state.stations[station.id]?.lastSuccessfulAt).length])),
  unplaced: model.unplaced.length,
}, null, 2));
