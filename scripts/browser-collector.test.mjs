import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeStation, travelDirection, mergeObservations, rebuildObservationHistory } from '../src/browser-records.js';
import { runCollectorCycle } from '../src/api.js';

const config = JSON.parse(await readFile(new URL('../config/stations.json', import.meta.url), 'utf8'));
const byId = new Map(config.stations.map((station) => [station.id, station]));
const options = { minRequestIntervalMs: 1000, cyclePauseSeconds: 300,
  historyRetentionHours: 36, tripMatchWindowSeconds: 10800 };
const record = { trainNo: '7392', toMoscow: false, destination: 'Подольск',
  departureTime: '2026-10-09T20:00:00+03:00', scheduleTime: '2026-10-09T19:55:00+03:00' };

test('браузерный адаптер сохраняет только используемые поля и проверяет станцию', () => {
  const station = normalizeStation({ stationId: 4139, from: 'private', needReload: true, trains: [{
    trainNo: 7392, toMoscow: true, departureTime: record.departureTime, scheduleTime: record.scheduleTime,
    delaySeconds: 60, equipment: 'private', i18n: { ru: { destination: 'Подольск',
      trainClass: { name: 'Электричка' }, stops: 'Все остановки' } },
  }] }, 4139);
  assert.equal(station.needReload, true);
  assert.equal(station.trains[0].trainNo, '7392');
  assert.equal(station.trains[0].destination, 'Подольск');
  assert.equal(station.trains[0].equipment, undefined);
  assert.equal(station.from, undefined);
  assert.throws(() => normalizeStation({ stationId: 4137, trains: [] }, 4139));
});

test('известная конечная определяет север и юг вопреки флагам источника', () => {
  for (const [destination, expected] of [['Подольск', 1], ['Серпухов', 1], ['Нахабино', -1]]) {
    for (const toMoscow of [true, false]) {
      for (const id of ['rizhskaya', 'dmitrovskaya', 'pererva']) {
        assert.equal(travelDirection({ destination, toMoscow, travelDirection: -expected }, byId.get(id),
          config.stations, config.section.destinationDirections), expected);
      }
    }
  }
});

test('уточнение задержки сохраняет рейс, повтор номера отделяется', async () => {
  const station = byId.get('rizhskaya');
  const history = new Map();
  await mergeObservations(history, [record], station, '2026-10-09T19:00:00Z', 10800,
    config.stations, config.section.destinationDirections);
  const firstId = [...history.keys()][0];
  await mergeObservations(history, [{ ...record, departureTime: '2026-10-09T20:20:00+03:00' }],
    station, '2026-10-09T19:01:00Z', 10800, config.stations, config.section.destinationDirections);
  assert.equal(history.size, 1);
  assert.equal([...history.keys()][0], firstId);
  assert.equal(history.get(firstId).departureTime, '2026-10-09T20:20:00+03:00');
  await mergeObservations(history, [{ ...record, scheduleTime: '2026-10-09T21:00:00+03:00',
    departureTime: '2026-10-09T21:05:00+03:00' }], station, '2026-10-09T19:02:00Z', 10800,
  config.stations, config.section.destinationDirections);
  assert.equal(history.size, 2);
  assert([...history.values()].every((item) => item.travelDirection === 1));
});

test('миграция направления объединяет ошибочный дубль Рижской без сдвига времени', async () => {
  const observations = [
    { ...record, id: 'old-a', runId: 'wrong-a', stationId: 'dmitrovskaya', toMoscow: true,
      travelDirection: 1, lastSeenAt: '2026-10-09T19:00:00+03:00' },
    { ...record, id: 'old-b', runId: 'wrong-b', stationId: 'rizhskaya', toMoscow: false,
      travelDirection: -1, departureTime: '2026-10-09T20:08:00+03:00',
      scheduleTime: '2026-10-09T20:03:00+03:00', lastSeenAt: '2026-10-09T19:08:00+03:00' },
  ];
  const repaired = await rebuildObservationHistory(observations, config.stations, 10800,
    config.section.destinationDirections);
  assert.equal(repaired.size, 2);
  assert.equal(new Set([...repaired.values()].map((item) => item.runId)).size, 1);
  assert.deepEqual([...repaired.values()].map((item) => item.travelDirection), [1, 1]);
  assert.deepEqual([...repaired.values()].map((item) => item.departureTime), observations.map((item) => item.departureTime));
});

test('полный цикл запрашивает 23 станции не чаще раза в секунду, сохраняет ошибку и паузу', async () => {
  let clock = Date.parse('2026-10-09T12:00:00Z');
  const requests = [];
  let publications = 0;
  const snapshot = { schemaVersion: 1, stations: {}, observations: [], collector: { status: 'waiting' } };
  await runCollectorCycle({ snapshot, config, options, now: () => clock, signal: new AbortController().signal,
    sleep: async (ms) => { clock += ms; }, publish: async () => { publications++; },
    request: async (apiId) => {
      requests.push({ apiId, at: clock });
      if (apiId === 3986) throw new Error('API вернул HTTP 503');
      return { trains: [], needReload: false };
    } });
  assert.deepEqual(requests.map((item) => item.apiId), config.pollStationApiIds);
  assert(requests.slice(1).every((item, index) => item.at - requests[index].at >= 1000));
  assert.equal(snapshot.stations[byId.get('pl_treh_vokzalov')?.id]?.error ||
    Object.values(snapshot.stations).find((item) => item.apiStationId === 3986).error, 'API вернул HTTP 503');
  assert.equal(snapshot.collector.status, 'waiting');
  assert.equal(Date.parse(snapshot.collector.nextCycleAt) - clock, 300_000);
  assert(publications >= 47);
});

test('после смены вкладки незаконченный цикл продолжается со следующей станции', async () => {
  let clock = Date.parse('2026-10-09T12:00:00Z');
  const partial = { ...config, pollStationApiIds: config.pollStationApiIds.slice(0, 3) };
  const requests = [];
  const snapshot = { schemaVersion: 1, stations: {}, observations: [], collector: {
    status: 'collecting', nextStationIndex: 1, lastRequestStartedUnix: clock / 1000,
  } };
  await runCollectorCycle({ snapshot, config: partial, options, now: () => clock,
    signal: new AbortController().signal, sleep: async (ms) => { clock += ms; }, publish: async () => {},
    request: async (id) => { requests.push(id); return { trains: [], needReload: false }; } });
  assert.deepEqual(requests, partial.pollStationApiIds.slice(1));
});
