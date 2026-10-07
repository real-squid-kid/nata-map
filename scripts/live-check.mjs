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
assert.equal(snapshots.length, 3);
assert(snapshots.every((s) => s.lastSuccessfulAt && s.trains.length && s.error === null));
const model = buildTrips(state, config);
const now = Date.now();
const active = model.trips.map((trip) => ({ trip, position: getTrainPosition(trip, now, config.stations, app.motion, config.section.geometryLengthMeters) }))
  .filter((entry) => entry.position.visible);
assert(model.trips.some((trip) => trip.anchors.length > 1), 'Нужны сопоставленные времена нескольких станций');
assert(active.every((entry) => Number.isFinite(entry.position.centerMeters)));
console.log(JSON.stringify({
  stations: snapshots.map((s) => ({ id: s.apiStationId, records: s.trains.length, updated: s.lastSuccessfulAt, needReload: s.needReload })),
  trips: model.trips.length, withMultipleAnchors: model.trips.filter((trip) => trip.anchors.length > 1).length,
  active: active.map(({ trip, position }) => ({ trainNo: trip.trainNo, direction: trip.direction, anchors: trip.anchors.length, mode: position.mode })),
  unplaced: model.unplaced.length,
}, null, 2));
