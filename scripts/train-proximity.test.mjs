import test from 'node:test';
import assert from 'node:assert/strict';
import { getCloseTrainIds } from '../src/train-proximity.js';

const train = (id, centerMeters, direction = 1) => ({ id, centerMeters, direction });

test('близость включает ровно 1000 м, но исключает встречные поезда и расстояния больше порога', () => {
  assert.deepEqual([...getCloseTrainIds([train('a', 0), train('b', 1000)])].sort(), ['a', 'b']);
  assert.equal(getCloseTrainIds([train('a', 0), train('b', 1000.01)]).size, 0);
  assert.equal(getCloseTrainIds([train('a', 0), train('b', 0, -1)]).size, 0);
});

test('каждый участник группы получает знак, включая совпавшие позиции и обратное направление', () => {
  const trains = [train('c', 1900, -1), train('a', 0, -1), train('b', 950, -1), train('d', 950, -1), train('far', 4000, -1)];
  assert.deepEqual([...getCloseTrainIds(trains)].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(trains[0].id, 'c');
});

test('после расхождения или исчезновения соседа знак снимается', () => {
  assert.equal(getCloseTrainIds([train('a', 500)]).size, 0);
  assert.equal(getCloseTrainIds([train('a', 500), train('b', 1501)]).size, 0);
  assert.equal(getCloseTrainIds([]).size, 0);
});
