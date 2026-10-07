import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';

const stations = JSON.parse(await readFile(new URL('../../config/stations.json', import.meta.url), 'utf8')).stations;
const instant = new Date('2026-10-07T12:00:00+03:00');
const iso = (seconds) => new Date(instant.getTime() + seconds * 1000).toISOString();
async function stubTiles(page, delayMs = 0, svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#d8ded5"/></svg>') {
  let intercepted = 0;
  const byTile = new Map();
  await page.route((url) => url.hostname.endsWith('.thunderforest.com'), async (route) => {
    intercepted++;
    const path = new URL(route.request().url()).pathname;
    byTile.set(path, (byTile.get(path) || 0) + 1);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return route.fulfill({ contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' },
      body: svg });
  });
  return Object.assign(() => intercepted, { byTile });
}
const fixture = () => {
  const observations = [true, false].map((toMoscow, index) => ({
    runId: `meeting-${index}`, stationId: 'grazhdanskaya', trainNo: `${6400 + index}`,
    toMoscow, departureTime: iso(0), lastSeenAt: iso(0), destination: toMoscow ? 'Подольск' : 'Нахабино',
    trainClass: 'Электричка', stops: 'Все остановки',
  }));
  return { schemaVersion: 1, publishedAt: iso(0), observations,
    stations: Object.fromEntries(stations.filter((station) => station.pollEnabled).map((station) => [station.id, {
      lastSuccessfulAt: iso(0), error: null, trains: [true, false].flatMap((toMoscow) =>
        [240, 60, -120, 180, 120].map((seconds, index) => ({
          trainNo: `${toMoscow ? 6500 : 6600}${index}`, toMoscow, departureTime: iso(seconds),
          destination: toMoscow ? 'Подольск' : 'Нахабино', trainClass: 'Электричка', stops: 'Все остановки',
        }))),
    }])) };
};

test('спрайты, встречные пути, переключение масштаба и три ближайших отправления', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: instant });
  await page.clock.setFixedTime(instant);
  await page.route('**/api/state', (route) => route.fulfill({ json: fixture() }));
  // Изолированный сценарий не расходует квоту подложки.
  const mockedTiles = await stubTiles(page);
  await page.goto('/');
  await expect(page.locator('.station-marker')).toHaveCount(37);
  await expect(page.locator('.train-visual')).toHaveCount(2);
  await page.locator('.station-button[data-station-id="grazhdanskaya"]').click();
  await page.locator('.map-diagnostics').evaluate((element) => { element.open = true; });
  await expect(page.locator('#zoom-value')).toHaveText('15');
  while (Number(await page.locator('#zoom-value').textContent()) > 13) {
    const zoom = Number(await page.locator('#zoom-value').textContent());
    await page.locator('#zoom-out').click();
    await expect(page.locator('#zoom-value')).toHaveText(`${zoom - 1}`);
  }
  await expect(page.locator('.train-visual[data-render-mode="capsule"]')).toHaveCount(2);
  await expect(page.locator('.train-outline').first()).toHaveCSS('stroke-width', '12px');
  await expect(page.locator('.train-outline').first()).not.toHaveCSS('filter', 'none');
  await mkdir('var/qa', { recursive: true });
  await page.screenshot({ path: 'var/qa/trains-z13.png' });
  await page.locator('#zoom-in').click();
  await expect(page.locator('#zoom-value')).toHaveText('14');
  await expect(page.locator('.train-visual[data-render-mode="wagons"]')).toHaveCount(2);
  for (const train of await page.locator('.train-visual').all()) {
    await expect(train.locator('.train-wagon:visible')).toHaveCount(6);
    expect(await train.locator('.train-wagon').evaluateAll((wagons) => wagons.map((wagon) => wagon.dataset.wagonRole)))
      .toEqual(['head', 'middle', 'middle', 'middle', 'middle', 'tail']);
  }
  const colors = await page.locator('.train-renderer symbol > rect:first-child').evaluateAll((rects) => rects.map((rect) => rect.getAttribute('fill')));
  expect(colors).toEqual(['#ffffff', '#DF477C', '#fa343e']);
  await page.screenshot({ path: 'var/qa/trains-z14.png' });
  for (let i = 0; i < 2; i++) {
    await page.locator('#zoom-in').click();
    await expect(page.locator('#zoom-value')).toHaveText(`${15 + i}`);
  }
  const paths = await page.locator('.train-hit').evaluateAll((paths) => paths.map((path) => {
    const length = path.getTotalLength(); const point = path.getPointAtLength(length / 2);
    const matrix = path.getScreenCTM(); return { x: point.x * matrix.a + matrix.e, y: point.y * matrix.d + matrix.f };
  }));
  const separation = Math.hypot(paths[0].x - paths[1].x, paths[0].y - paths[1].y);
  expect(separation).toBeGreaterThan(14);
  expect(separation).toBeLessThan(18);
  expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.closest('.train-visual')?.dataset.trainId, paths[0])).toBe('meeting-0');
  await page.mouse.click(paths[0].x, paths[0].y);
  await expect(page.locator('#train-details h2')).toHaveText('Поезд № 6400');
  await page.locator('.train-visual[data-train-id="meeting-1"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#train-details h2')).toHaveText('Поезд № 6401');
  for (const group of await page.locator('.departures-group').all()) {
    await expect(group.locator('.departure-button')).toHaveCount(3);
    expect(await group.locator('.departure-time').allTextContents()).toEqual(['12:01', '12:02', '12:03']);
  }
  await page.locator('#train-details .train-card-close').click();
  await page.screenshot({ path: 'var/qa/trains-z16.png' });
  await page.locator('#zoom-out').click();
  await expect(page.locator('#zoom-value')).toHaveText('15');
  await page.locator('#zoom-out').click();
  await expect(page.locator('#zoom-value')).toHaveText('14');
  await page.locator('#zoom-out').click();
  await expect(page.locator('.train-visual[data-render-mode="capsule"]')).toHaveCount(2);
  expect(errors).toEqual([]);
  expect(mockedTiles()).toBeGreaterThan(0);
});

test('живой снимок и настоящая подложка', async ({ page, request }) => {
  const response = await request.get('/api/state');
  expect(response.ok()).toBeTruthy();
  const snapshot = await response.json();
  const successfulStations = Object.values(snapshot.stations).filter((station) => station.lastSuccessfulAt).length;
  expect(Object.keys(snapshot.stations)).toHaveLength(23);
  expect(successfulStations).toBeGreaterThan(0);
  expect(Object.values(snapshot.stations).every((station) => station.lastSuccessfulAt || station.error)).toBe(true);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#source-status')).toContainText(`${successfulStations}/23 станции`);
  await expect.poll(async () => Number(await page.locator('#tiles-loaded').textContent()), { timeout: 20000 }).toBeGreaterThan(0);
  expect(await page.locator('.corridor-tile[data-in-corridor="false"] img').count()).toBe(0);
  for (const group of await page.locator('.departures-group').all()) expect(await group.locator('.departure-button').count()).toBeLessThanOrEqual(3);
  await mkdir('var/qa', { recursive: true });
  await page.screenshot({ path: 'var/qa/live-map.png' });
  await page.locator('.station-button[data-station-id="grazhdanskaya"]').click();
  await expect(page.locator('#zoom-value')).toHaveText('15');
  await page.locator('#zoom-out').click();
  await expect(page.locator('#zoom-value')).toHaveText('14');
  await expect.poll(async () => {
    return Number(await page.locator('#tiles-pending').textContent());
  }, { timeout: 20000 }).toBe(0);
  await expect(page.locator('#tiles-failed')).toHaveText('0');
  await page.screenshot({ path: 'var/qa/live-map-z14.png' });
  console.log(JSON.stringify({ successfulStations, activeTrains: Number(await page.locator('#active-trains').textContent()),
    loadedTiles: Number(await page.locator('#tiles-loaded').textContent()), failedTiles: Number(await page.locator('#tiles-failed').textContent()) }));
  expect(errors).toEqual([]);
});

test('планшет: центр станции, сворачивание и полноэкранная карта', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.route('**/api/state', (route) => route.fulfill({ json: fixture() }));
  const mockedTiles = await stubTiles(page);
  await page.goto('/');
  await page.locator('#stations-section > summary').click();
  await expect(page.locator('#station-list')).toBeHidden();
  await page.locator('#stations-section > summary').click();
  await page.locator('#schedule-section > summary').click();
  await expect(page.locator('#station-details')).toBeHidden();
  // Обновление данных сохраняет свёрнутое состояние.
  await page.waitForResponse('**/api/state');
  await expect(page.locator('#station-details')).toBeHidden();
  await page.locator('#schedule-section > summary').click();
  await page.locator('.map-diagnostics').evaluate((element) => { element.open = true; });
  for (const id of ['nakhabino', 'podolsk', 'grazhdanskaya']) {
    await page.locator(`.station-button[data-station-id="${id}"]`).click();
    await expect(page.locator('#zoom-value')).toHaveText('15');
    const frame = await page.locator('#map').boundingBox();
    const marker = await page.locator(`.station-marker[data-station-id="${id}"]`).boundingBox();
    expect(Math.abs(marker.x + marker.width / 2 - (frame.x + frame.width / 2))).toBeLessThan(2);
    expect(Math.abs(marker.y + marker.height / 2 - (frame.y + frame.height / 2))).toBeLessThan(2);
  }
  await expect.poll(async () => (await page.locator('.map-panel').boundingBox()).height).toBe(552);
  await page.locator('#fullscreen').click();
  await expect(page.locator('#fullscreen')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect.poll(async () => (await page.locator('#map').boundingBox()).width).toBe(1024);
  await expect.poll(async () => (await page.locator('#map').boundingBox()).height).toBe(600);
  const stationCenterError = async () => {
    const frame = await page.locator('#map').boundingBox();
    const marker = await page.locator('.station-marker[data-station-id="grazhdanskaya"]').boundingBox();
    return Math.hypot(marker.x + marker.width / 2 - frame.x - frame.width / 2,
      marker.y + marker.height / 2 - frame.y - frame.height / 2);
  };
  await expect.poll(stationCenterError).toBeLessThan(2);
  await page.screenshot({ path: 'var/qa/tablet-fullscreen.png' });
  await page.locator('#fullscreen').click();
  await expect(page.locator('#fullscreen')).toHaveAttribute('aria-pressed', 'false');
  // Разворачивание всегда остаётся в окне браузера, Fullscreen API не нужен.
  await page.locator('.map-frame').evaluate((element) => { element.requestFullscreen = undefined; });
  await page.locator('#fullscreen').click();
  await expect(page.locator('.map-frame')).toHaveClass(/is-expanded/);
  await expect.poll(async () => (await page.locator('#map').boundingBox()).width).toBe(1024);
  await expect.poll(stationCenterError).toBeLessThan(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#fullscreen')).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: 'var/qa/tablet-panel.png' });
  expect(mockedTiles()).toBeGreaterThan(0);
});

test('поезд на Рижский вокзал растворяется после Дмитровской', async ({ page }) => {
  await page.clock.install({ time: instant });
  await page.clock.setFixedTime(instant);
  const state = fixture();
  state.observations = [{ ...state.observations[0], stationId: 'dmitrovskaya', destination: 'Рижский вокзал' }];
  await page.route('**/api/state', (route) => route.fulfill({ json: state }));
  const mockedTiles = await stubTiles(page);
  await page.goto('/');
  const train = page.locator('.train-visual');
  await expect(train).toHaveCount(1);
  await expect(train).toHaveAttribute('opacity', '1');
  await page.clock.setFixedTime(new Date(iso(30)));
  await expect(train).toHaveAttribute('opacity', '0.5');
  await page.clock.setFixedTime(new Date(iso(45)));
  await expect(train).toHaveCount(0);
  expect(mockedTiles()).toBeGreaterThan(0);
});

test('локальный кэш переживает zoom и перезагрузку; ночной режим меняет порог вагонов', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: instant });
  await page.clock.setFixedTime(instant);
  await page.route('**/api/state', (route) => route.fulfill({ json: fixture() }));
  const requests = await stubTiles(page);
  await page.goto('/');
  await page.locator('.map-diagnostics').evaluate((element) => { element.open = true; });
  const settled = async () => {
    await expect.poll(async () => Number(await page.locator('#tiles-loaded').textContent())).toBeGreaterThan(0);
    await expect(page.locator('#tiles-pending')).toHaveText('0');
    await expect(page.locator('#tiles-failed')).toHaveText('0');
  };
  await settled();
  await page.locator('.station-button[data-station-id="grazhdanskaya"]').click();
  await expect(page.locator('#zoom-value')).toHaveText('15');
  await settled();
  await page.locator('#zoom-out').click();
  await expect(page.locator('#zoom-value')).toHaveText('14');
  await settled();
  const warmRequests = requests();
  expect(warmRequests).toBeGreaterThan(0);
  for (let repeat = 0; repeat < 3; repeat++) {
    await page.locator('#zoom-in').click();
    await expect(page.locator('#zoom-value')).toHaveText('15');
    await settled();
    await page.locator('#zoom-out').click();
    await expect(page.locator('#zoom-value')).toHaveText('14');
    await settled();
  }
  const frame = await page.locator('#map').boundingBox();
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await page.mouse.wheel(0, -120);
  await expect(page.locator('#zoom-value')).toHaveText('15');
  await settled();
  await page.mouse.wheel(0, 120);
  await expect(page.locator('#zoom-value')).toHaveText('14');
  await settled();
  expect(requests()).toBe(warmRequests);
  expect(Number(await page.locator('#tiles-cached').textContent())).toBeGreaterThan(0);
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await expect(page.locator('.leaflet-dimming-pane')).toHaveCSS('background-color', 'rgba(18, 23, 20, 0.68)');
  await expect(page.locator('.train-visual[data-render-mode="capsule"]')).toHaveCount(2);
  await expect(page.locator('.train-body').first()).toHaveCSS('stroke', 'rgb(255, 240, 213)');
  await page.screenshot({ path: 'var/qa/night-z14.png' });
  await page.locator('#zoom-in').click();
  await expect(page.locator('#zoom-value')).toHaveText('15');
  await expect(page.locator('.train-visual[data-render-mode="wagons"]')).toHaveCount(2);
  await expect(page.locator('.train-visual').first().locator('.train-wagon:visible')).toHaveCount(6);
  await expect(page.locator('.train-wagon-head').first()).not.toHaveCSS('filter', 'none');
  await expect(page.locator('.train-wagon-tail').first()).not.toHaveCSS('filter', 'none');
  await settled();
  await page.screenshot({ path: 'var/qa/night-z15.png' });
  await page.reload();
  await page.locator('.map-diagnostics').evaluate((element) => { element.open = true; });
  await settled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.locator('.station-button[data-station-id="grazhdanskaya"]').click();
  await expect(page.locator('#zoom-value')).toHaveText('15');
  await settled();
  expect(requests()).toBe(warmRequests);
  await expect(page.locator('#tiles-requested')).toHaveText('0');
  const cache = await page.evaluate(async () => {
    const entries = await (await caches.open('nata-map-tiles-v1')).keys();
    return { count: entries.length, hasApiKey: entries.some((entry) => entry.url.includes('apikey')) };
  });
  expect(cache.count).toBeGreaterThan(0);
  expect(cache.hasApiKey).toBe(false);
  const anotherTab = await page.context().newPage();
  await anotherTab.route('**/api/state', (route) => route.fulfill({ json: fixture() }));
  const extraRequests = await stubTiles(anotherTab);
  await anotherTab.goto('/');
  await expect.poll(async () => Number(await anotherTab.locator('#tiles-loaded').textContent())).toBeGreaterThan(0);
  await expect(anotherTab.locator('#tiles-pending')).toHaveText('0');
  expect(extraRequests()).toBe(0);
  await anotherTab.close();
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ warmedNetworkRequests: warmRequests, repeatedZoomAndReloadRequests: requests() - warmRequests, savedTiles: cache.count }));
});

test('быстрый zoom при незавершённой загрузке не дублирует тайлы и не оставляет ошибок', async ({ page }) => {
  await page.route('**/api/state', (route) => route.fulfill({ json: fixture() }));
  const requests = await stubTiles(page, 700);
  await page.goto('/');
  await page.locator('.map-diagnostics').evaluate((element) => { element.open = true; });
  await page.locator('.station-button[data-station-id="grazhdanskaya"]').click();
  await expect(page.locator('#zoom-value')).toHaveText('15');
  await page.locator('#zoom-out').click();
  await expect(page.locator('#zoom-value')).toHaveText('14');
  await page.locator('#zoom-in').click();
  await expect(page.locator('#zoom-value')).toHaveText('15');
  await expect.poll(async () => Number(await page.locator('#tiles-loaded').textContent())).toBeGreaterThan(0);
  await expect(page.locator('#tiles-pending')).toHaveText('0');
  await expect(page.locator('#tiles-failed')).toHaveText('0');
  expect(requests()).toBeGreaterThan(0);
  expect(Math.max(...requests.byTile.values())).toBe(1);
});

test('автоматическая ночь по Москве, ручной выбор до следующего периода и переход через полночь', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-07T18:59:00+03:00') });
  await page.clock.setFixedTime(new Date('2026-10-07T18:59:00+03:00'));
  await page.route('**/api/state', (route) => route.fulfill({ json: fixture() }));
  await stubTiles(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.clock.setFixedTime(new Date('2026-10-07T19:00:00+03:00'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.clock.setFixedTime(new Date('2026-10-08T00:01:00+03:00'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.clock.setFixedTime(new Date('2026-10-08T07:00:00+03:00'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.clock.setFixedTime(new Date('2026-10-08T19:00:00+03:00'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
});

test('список без скачков hover, мягкий край тайлов и карточки поверх развёрнутой карты', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: instant });
  await page.route('**/api/state', (route) => route.fulfill({ json: fixture() }));
  const requests = await stubTiles(page, 0, '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#bed0b3"/><path d="M-10 60 Q128 0 266 100 M80 -10 Q200 130 70 266" stroke="#f4efd9" stroke-width="16" fill="none"/><path d="M-10 60 Q128 0 266 100 M80 -10 Q200 130 70 266" stroke="#9da69b" stroke-width="1" fill="none"/></svg>');
  await page.goto('/');
  const list = page.locator('#station-list');
  expect((await list.boundingBox()).height).toBeLessThanOrEqual(320);
  const row = page.locator('.station-button[data-station-id="dmitrovskaya"]');
  const before = await row.boundingBox();
  await row.hover();
  expect(await row.boundingBox()).toEqual(before);
  await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(row.locator('.station-name')).not.toHaveCSS('box-shadow', 'none');
  const blur = page.locator('.tile-edge-blur').first();
  await expect(blur).toHaveCSS('backdrop-filter', 'blur(5px)');
  await expect(page.locator('.corridor-tile[data-in-corridor="false"] img')).toHaveCount(0);
  // Здесь часы идут: Leaflet использует Date.now для появления тайлов.
  await expect(page.locator('#tiles-pending')).toHaveText('0');
  await expect(page.locator('.corridor-tile[data-tile-state="loaded"]').first()).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'var/qa/frontend-day.png' });
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.locator('.station-button[data-station-id="grazhdanskaya"]').click();
  await page.locator('#fullscreen').click();
  await expect(page.locator('.map-inspector')).toBeHidden();
  const marker = page.locator('.station-marker[data-station-id="grazhdanskaya"]');
  await marker.focus(); await page.keyboard.press('Space');
  await expect(page.locator('.map-inspector #station-details h2')).toHaveText('Гражданская');
  await page.locator('.inspector-close').click();
  await expect(page.locator('.map-inspector')).toBeHidden();
  await page.locator('.train-visual').first().focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.map-inspector #train-details')).toBeVisible();
  await page.screenshot({ path: 'var/qa/frontend-expanded-card.png' });
  await page.locator('.map-inspector .train-card-close').click();
  await expect(page.locator('.map-inspector')).toBeHidden();
  await expect(page.locator('#fullscreen')).toBeFocused();
  await page.locator('.train-visual').first().focus(); await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar #train-details')).toBeVisible();
  await expect(page.locator('#fullscreen')).toBeFocused();
  await page.locator('#theme-toggle').click();
  await page.screenshot({ path: 'var/qa/frontend-night.png' });
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  await page.locator('#fullscreen').click();
  await expect.poll(async () => (await page.locator('#map').boundingBox()).height).toBe(780);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'var/qa/frontend-mobile.png' });
  expect(requests()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
