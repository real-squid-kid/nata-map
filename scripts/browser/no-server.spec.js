import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile(new URL('../../config/stations.json', import.meta.url), 'utf8'));
const readSnapshot = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('nata-map-no-server-v1', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const request = open.result.transaction('snapshots').objectStore('snapshots').get('current');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  };
}));

async function interceptSource(context, calls) {
  await context.route((url) => url.hostname.endsWith('.thunderforest.com'), (route) => route.fulfill({
    contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' },
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>',
  }));
  await context.route('https://mcd.nata-info.ru/api/v2**', (route) => {
    const stationId = Number(new URL(route.request().url()).searchParams.get('station'));
    calls.push(stationId);
    if (stationId === 3986) return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: 'unavailable' });
    const offset = stationId === 4139 ? 60 : 240;
    const trains = [4139, 4137].includes(stationId) ? [{
      trainNo: 7392, toMoscow: true, departureTime: new Date(Date.now() + offset * 1000).toISOString(),
      scheduleTime: new Date(Date.now() + offset * 1000).toISOString(),
      i18n: { ru: { destination: 'Подольск', trainClass: { name: 'Электричка' } } },
    }] : [];
    return route.fulfill({ json: { stationId, trains, needReload: false },
      headers: { 'access-control-allow-origin': '*' } });
  });
}

test('один опросчик на две вкладки, полный цикл и пауза после перезагрузки', async ({ context }) => {
  test.setTimeout(60000);
  const calls = [];
  await interceptSource(context, calls);
  const first = await context.newPage();
  const second = await context.newPage();
  const errors = [];
  first.on('pageerror', (error) => errors.push(error.message));
  second.on('pageerror', (error) => errors.push(error.message));
  await first.goto('/');
  await expect.poll(() => calls.length, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
  await second.goto('/');
  await expect(first.locator('.station-marker')).toHaveCount(37);
  await first.locator('#fullscreen').click();
  await expect(first.locator('.map-frame')).toHaveClass(/is-expanded/);
  await first.keyboard.press('Escape');
  await expect(first.locator('.map-frame')).not.toHaveClass(/is-expanded/);
  await expect.poll(async () => (await readSnapshot(first))?.collector?.status,
    { timeout: 45000 }).toBe('waiting');
  const snapshot = await readSnapshot(first);
  expect(errors).toEqual([]);
  expect(calls).toEqual(config.pollStationApiIds);
  expect(snapshot.observations.length).toBeGreaterThanOrEqual(2);
  await expect(first.locator('.train-visual')).toHaveCount(1);
  expect(snapshot.stations.pl_treh_vokzalov?.error ||
    Object.values(snapshot.stations).find((state) => state.apiStationId === 3986)?.error).toContain('503');
  await expect(second.locator('#source-status')).toContainText('22/23');
  await first.reload();
  await second.reload();
  await first.waitForTimeout(1500);
  expect(calls).toHaveLength(23);
  expect(Date.parse((await readSnapshot(second)).collector.nextCycleAt)).toBeGreaterThan(Date.now());
  expect(errors).toEqual([]);
});

test('после закрытия вкладки-лидера другая продолжает цикл', async ({ context }) => {
  test.setTimeout(60000);
  const calls = [];
  await interceptSource(context, calls);
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto('/');
  await second.goto('/');
  await expect.poll(() => calls.length, { timeout: 12000 }).toBeGreaterThanOrEqual(3);
  const before = (await readSnapshot(second)).collector.nextStationIndex;
  await first.close();
  await expect.poll(async () => (await readSnapshot(second))?.collector?.status,
    { timeout: 45000 }).toBe('waiting');
  expect(calls).toEqual(config.pollStationApiIds);
  expect(before).toBeGreaterThanOrEqual(2);
});
