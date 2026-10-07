import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getTrainPosition } from '../src/motion.js';
import { buildTrips, parseTime } from '../src/trips.js';
import { createTrackGeometry } from '../src/geometry.js';

const motion = JSON.parse(await readFile(new URL('../config/app.json', import.meta.url), 'utf8')).motion;
const stations = [100, 1100, 2100, 3100].map((s, index) => ({ id: `s${index}`, name: `Станция ${index}`, alongTrackMeters: s }));
const T = Date.parse('2026-10-07T09:34:30Z');
const trip = (anchors, extra = {}) => ({ anchors: anchors.map(([s, time]) => ({ s, time })), direction: 1, terminal: null, ...extra });
const position = (train, now) => getTrainPosition(train, now, stations, motion, 4000);

test('12:34:30 по Москве: стоянка строго ±15 секунд без повторного прибавления задержки', () => {
  const train = trip([[1100, T]]);
  assert.equal(position(train, T - 15000).centerMeters, 1100);
  assert.equal(position(train, T + 15000).centerMeters, 1100);
  assert(position(train, T - 16000).centerMeters < 1100);
  assert(position(train, T + 16000).centerMeters > 1100);
});

test('равномерное движение между двумя якорями, совпадение со временем прибытия', () => {
  const train = trip([[1100, T], [2100, T + 120000]]);
  assert.equal(position(train, T + 60000).centerMeters, 1600);
  assert.equal(position(train, T + 60000).mode, 'schedule');
  assert.equal(position(train, T + 105000).centerMeters, 2100);
});

test('станция без API между якорями: 30 с стоянки без сдвига известных времён в обе стороны', () => {
  for (const direction of [1, -1]) {
    const anchors = direction > 0 ? [[1100, T], [3100, T + 180000]] : [[3100, T], [1100, T + 180000]];
    const train = trip(anchors, { direction });
    for (const offset of [75000, 90000, 105000]) {
      assert.equal(position(train, T + offset).centerMeters, 2100);
    }
    assert.equal(position(train, T + 90000).mode, 'schedule-dwell');
    assert.equal(position(train, T + 165000).centerMeters, anchors[1][0]);
    assert.equal(position(train, T + 180000).mode, 'dwell');
  }
});

test('резервный расчёт включает стоянки вперёд и назад, не сдвигая якорь', () => {
  const train = trip([[1100, T]]);
  assert.equal(motion.fallbackSpeedKmh, 75);
  assert.equal(position(train, T + 15000 + 48000 + 15000).centerMeters, 2100);
  assert.equal(position(train, T + 15000 + 48000 + 30000 + 24000).centerMeters, 2600);
  assert.equal(position(train, T - 15000 - 48000 - 15000).centerMeters, 100);
  assert(Math.abs(position(train, T - 15000 - 48000 - 30000 - 2400).centerMeters - 50) < 0.001);
});

test('обратное направление и голова/хвост используют убывание расстояния', () => {
  const train = trip([[2100, T], [1100, T + 120000]], { direction: -1 });
  assert.equal(position(train, T + 60000).centerMeters, 1600);
  assert(position(train, T - 20000).centerMeters > 2100);
  assert(position(train, T + 140000).centerMeters < 1100);
});

test('при противоречивых временах нет NaN и деления на ноль', () => {
  const train = trip([[1100, T], [2100, T + 10000]]);
  const result = position(train, T + 40000);
  assert(Number.isFinite(result.centerMeters));
  assert.equal(result.mode, 'fallback');
});

test('конечная: ровно 120 с от прибытия, без дополнительных 30 с', () => {
  const train = trip([[2100, T]], { terminal: stations[2] });
  assert(position(train, T - 15000).visible);
  assert.equal(position(train, T).mode, 'terminal');
  assert(position(train, T + 104999).visible);
  assert(!position(train, T + 105000).visible);
});

test('резервное прибытие на конечную учитывает промежуточную условную остановку', () => {
  const train = trip([[1100, T]], { terminal: stations[3] });
  const arrival = T + 15000 + 96000 + 30000;
  assert.equal(position(train, arrival).mode, 'terminal');
  assert.equal(position(train, arrival).centerMeters, 3100);
  assert(!position(train, arrival + 120000).visible);
});

test('поезд исчезает после выхода всего состава; старые времена не замораживаются', () => {
  const train = trip([[3100, T]]);
  const atEdge = T + 15000 + (4000 - 3100) / (motion.fallbackSpeedKmh / 3.6) * 1000;
  assert(position(train, atEdge).visible);
  assert(!position(train, atEdge + 5000).visible);
  assert(!position(train, T + 3600000).visible);
});

test('Рижский вокзал: растворение ровно за 30 с после отправления от Дмитровской', () => {
  const branchStations = stations.map((station, index) => index === 1 ? { ...station, id: 'dmitrovskaya' } : station);
  const train = trip([[1100, T]], { destination: 'Рижский вокзал' });
  const pos = (now) => getTrainPosition(train, now, branchStations, motion, 4000);
  assert.equal(pos(T + 15000).opacity, 1);
  assert.equal(pos(T + 30000).opacity, 0.5);
  assert.equal(pos(T + 30000).mode, 'exit');
  assert(pos(T + 44999).visible);
  assert(!pos(T + 45000).visible);
  assert.equal(pos(T + 45000).opacity, 0);
  assert.equal(getTrainPosition({ ...train, direction: -1 }, T + 30000, branchStations, motion, 4000).opacity, 1);
});

test('Рижский вокзал без якоря Дмитровской: расчёт её отправления при 75 км/ч и стоянке 30 с', () => {
  const branchStations = stations.map((station, index) => index === 1 ? { ...station, id: 'dmitrovskaya' } : station);
  const train = trip([[100, T]], { destination: 'Москва (Рижский вокзал)' });
  const departure = T + 15000 + 48000 + 30000;
  assert.equal(getTrainPosition(train, departure, branchStations, motion, 4000).opacity, 1);
  assert.equal(getTrainPosition(train, departure + 15000, branchStations, motion, 4000).opacity, 0.5);
  assert(!getTrainPosition(train, departure + 30000, branchStations, motion, 4000).visible);
});

test('внешняя конечная: поезд продолжает ехать за Подольск/Нахабино и постепенно исчезает', () => {
  const ends = [{ id: 'nakhabino', alongTrackMeters: 1000 }, { id: 'podolsk', alongTrackMeters: 3000 }];
  for (const [s, direction] of [[3000, 1], [1000, -1]]) {
    const train = trip([[s, T]], { direction, destination: 'Вне D2' });
    const result = getTrainPosition(train, T + 30000, ends, motion, 5000);
    assert(result.visible);
    assert.equal(result.opacity, 0.5);
    assert(direction * (result.centerMeters - s) > 0);
    assert(!getTrainPosition(train, T + 45000, ends, motion, 5000).visible);
  }
});

test('конечная на D2: двухминутная стоянка без растворения и дальнейшего движения', () => {
  const terminal = { id: 'podolsk', alongTrackMeters: 3000 };
  const train = trip([[3000, T]], { terminal, destination: 'Подольск' });
  const result = getTrainPosition(train, T + 90000, [terminal], motion, 5000);
  assert(result.visible);
  assert.equal(result.opacity, 1);
  assert.equal(result.centerMeters, 3000);
  assert(!getTrainPosition(train, T + 105000, [terminal], motion, 5000).visible);
});

test('алиасы конечных Каланчёвская/Кубанская распознаются как станции D2', () => {
  const config = { stations: [{ id: 's0', name: 'Люблино', aliases: ['Кубанская'], alongTrackMeters: 1000 }],
    section: { toMoscowDirectionStep: 1, fromMoscowDirectionStep: -1 } };
  const model = buildTrips({ observations: [{ runId: 'alias', stationId: 's0', trainNo: '42', toMoscow: true,
    departureTime: new Date(T).toISOString(), destination: 'Кубанская' }] }, config);
  assert.equal(model.trips[0].terminal.id, 's0');
});

test('geometry.slice сохраняет изгиб и длину в метрах, а не прямую между станциями', () => {
  const track = createTrackGeometry({ properties: { cumulativeMeters: [0, 100, 200] }, geometry: { coordinates: [[37, 55], [37.001, 55], [37.001, 55.001]] } });
  assert.deepEqual(track.slice(20, 180), [[55, 37.0002], [55, 37.001], [55.0008, 37.001]]);
  assert.deepEqual(track.pointAt(-80), [55, 37]);
  assert.deepEqual(track.pointAt(300), [55.001, 37.001]);
});

test('история одного runId переживает полночь и исчезновение отправления из табло', () => {
  const config = { stations, section: { toMoscowDirectionStep: 1, fromMoscowDirectionStep: -1 } };
  const observations = [
    { runId: 'same', trainNo: '6420', toMoscow: true, stationId: 's1', departureTime: '2026-10-07T23:59:30+03:00', lastSeenAt: '2026-10-07T23:58:00+03:00' },
    { runId: 'same', trainNo: '6420', toMoscow: true, stationId: 's2', departureTime: '2026-10-08T00:01:30+03:00', lastSeenAt: '2026-10-08T00:00:00+03:00' },
    { runId: 'next-day', trainNo: '6420', toMoscow: true, stationId: 's1', departureTime: '2026-10-08T23:59:30+03:00' },
  ];
  const result = buildTrips({ observations, stations: {} }, config);
  assert.equal(result.trips.length, 2);
  assert.equal(result.trips[0].anchors.length, 2);
  assert.equal(result.trips[0].warnings.length, 0);
});

test('нет номера/времени/направления: сохранение причин, без вымышленного совпадения', () => {
  const result = buildTrips({ observations: [], stations: { s1: { trains: [{ trainNo: null, toMoscow: null, departureTime: '12:34' }] } } },
    { stations, section: { toMoscowDirectionStep: 1, fromMoscowDirectionStep: -1 } });
  assert.equal(result.trips.length, 0);
  assert.equal(result.unplaced.length, 1);
  assert.equal(result.unplaced[0].issues.length, 3);
  assert(Number.isNaN(parseTime('2026-10-07T12:34:30')));
});

test('восстановление после неактивной вкладки: позиция определяется абсолютным временем', () => {
  const train = trip([[1100, T], [2100, T + 120000]]);
  position(train, T);
  assert.equal(position(train, T + 60000).centerMeters, 1600);
  assert.equal(position(train, T + 105000).centerMeters, 2100);
});

test('реальные нормализованные данные пригодны для модели, если локальный снимок существует', async (t) => {
  let state;
  try { state = JSON.parse(await readFile(new URL('../var/state.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Нет локального снимка'); return; } throw error; }
  const config = JSON.parse(await readFile(new URL('../config/stations.json', import.meta.url), 'utf8'));
  const result = buildTrips(state, config);
  for (const train of result.trips) {
    const center = getTrainPosition(train, Date.now(), config.stations, motion, config.section.geometryLengthMeters).centerMeters;
    assert(Number.isFinite(center));
  }
});
