import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTrackGeometry } from '../src/geometry.js';
import { getTrainLayout } from '../src/train-layout.js';

const app = JSON.parse(await readFile(new URL('../config/app.json', import.meta.url), 'utf8'));
const track = createTrackGeometry({ geometry: { coordinates: [[0, 0], [1000, 0]] }, properties: { cumulativeMeters: [0, 1000] } });
const project = ([y, x]) => ({ x, y });
const layout = (extra = {}) => getTrainLayout({ track, project, centerMeters: 500, direction: 1,
  trainLengthMeters: 160, options: app.map.trainRendering, zoom: 14, ...extra });

test('шесть вагонов с z14 днём и с z15 ночью', () => {
  assert.equal(layout({ zoom: 13 }).mode, 'capsule');
  assert.equal(layout({ zoom: 14 }).mode, 'wagons');
  assert.equal(layout({ zoom: 14, night: true }).mode, 'capsule');
  assert.equal(layout({ zoom: 15, night: true }).mode, 'wagons');
  assert.deepEqual(layout().wagons.map((wagon) => wagon.role), ['head', 'middle', 'middle', 'middle', 'middle', 'tail']);
});

test('встречные составы в одной позиции имеют разные пути и противоположные головы', () => {
  const forward = layout();
  const backward = layout({ direction: -1 });
  assert.equal(forward.center.x, backward.center.x);
  assert.equal(Math.abs(forward.center.y - backward.center.y), 16);
  assert(Math.abs(forward.center.y - backward.center.y) > app.map.trainRendering.wagonWidthPx + 2);
  assert(forward.head.x > forward.tail.x);
  assert(backward.head.x < backward.tail.x);
  assert.equal(forward.wagons[0].angle, 0);
  assert.equal(Math.abs(backward.wagons[0].angle), 180);
});

test('вагоны имеют зазоры, крайние точки сохраняют длину состава 160 м', () => {
  const result = layout();
  assert.equal(result.head.x - result.tail.x, 160);
  for (let index = 1; index < result.wagons.length; index++) {
    const front = result.wagons[index - 1];
    const rear = result.wagons[index];
    const gap = front.x - front.length / 2 - (rear.x + rear.length / 2);
    assert(Math.abs(gap - 3) < 1e-9);
  }
});

test('на границе покрытия невидимые вагоны и огни убираются, видимые обрезаются', () => {
  const result = layout({ centerMeters: -20 });
  assert.deepEqual(result.wagons.map((wagon) => wagon.index), [0, 1, 2]);
  assert.equal(result.tail, null);
  assert.equal(result.head.x, 60);
  assert(result.wagons[2].length < result.wagons[0].length);
  assert.equal(layout({ centerMeters: 1081 }).wagons.length, 0);
});

test('кривой путь сохраняет изгиб капсулы и поворачивает каждый вагон отдельно', () => {
  const curved = createTrackGeometry({ geometry: { coordinates: [[0, 0], [500, 0], [800, 300]] }, properties: { cumulativeMeters: [0, 500, 924.264] } });
  const result = layout({ track: curved });
  assert.equal(result.points.length, 3);
  assert(result.wagons[0].angle > 40 && result.wagons[0].angle < 50);
  assert.equal(result.wagons.at(-1).angle, 0);
  for (const wagon of result.wagons) assert(Number.isFinite(wagon.x) && Number.isFinite(wagon.y) && wagon.length > 0);
});
