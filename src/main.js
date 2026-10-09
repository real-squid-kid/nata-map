import 'leaflet/dist/leaflet.css';
import './styles.css';
import stationsConfig from '../config/stations.json';
import railway from '../config/railway.geojson?raw';
import appConfig from '../config/app.json';
import { createSectionMap } from './map.js';
import { startSnapshotPolling } from './api.js';
import { buildTrips, parseTime, recordIssues } from './trips.js';
import { getTrainPosition, motionLabels } from './motion.js';
import { automaticNight, themePeriod } from './theme.js';

const app = document.querySelector('#app');
const diameterColor = appConfig.map.diameterColors[stationsConfig.section.diameter];
const startFullscreen = new URLSearchParams(window.location.search).get('fullScreen') === 'true';
// Устанавливаем режим до создания интерфейса и первого измерения карты.
document.body.classList.toggle('map-expanded', startFullscreen);
app.style.setProperty('--diameter-color', diameterColor);
app.innerHTML = `
  <section class="instrument-panel map-panel">
    <header class="panel-header">
      <div class="brand"><span class="diameter-badge">D2</span><div><h1>nata-map</h1><p>Нахабино — Подольск</p></div></div>
      <div class="header-tools"><time id="moscow-clock"></time><button type="button" class="instrument-button theme-button" id="theme-toggle" aria-pressed="false">Ночной режим</button><button type="button" class="instrument-button overview-button" id="overview">Весь диаметр</button></div>
    </header>
    <div class="workspace">
      <section class="map-frame${startFullscreen ? ' is-expanded' : ''}" aria-label="Карта участка D2">
        <p id="api-version-warning" class="api-version-warning" role="status" aria-live="polite" hidden>Версия API сервера Nata Info отличается от ожидаемый. Что-то (или ничего) может быть боркнуто до момента применения фикса.</p>
        <div class="map-viewport">
        <div id="map" aria-label="Карта: станции и расчётные положения электричек D2"></div>
        <div class="map-toolbar" role="group" aria-label="Масштаб карты">
          <button type="button" class="instrument-button zoom-button" id="zoom-in" aria-label="Приблизить">+</button>
          <button type="button" class="instrument-button zoom-button" id="zoom-out" aria-label="Отдалить">−</button>
          <button type="button" class="instrument-button fullscreen-button" id="fullscreen" aria-label="Развернуть карту" aria-pressed="false"><span aria-hidden="true">⛶</span><span class="fullscreen-label">На весь экран</span></button>
        </div>
        <div class="map-legend"><span class="route-swatch"></span><span>D2</span><span class="lamp-swatch head-swatch"></span><span>Голова</span><span class="lamp-swatch tail-swatch"></span><span>Хвост</span></div>
        <div class="train-counter" role="status"><span id="active-trains" hidden>—</span> <span id="train-counter-label">Загрузка расписания…</span></div>
        <aside class="map-inspector inset-surface" aria-label="Карточка на карте" hidden>
          <button type="button" class="inspector-close instrument-button" aria-label="Закрыть карточку станции">×</button>
          <div class="inspector-content"></div>
        </aside>
        </div>
      </section>
      <aside class="sidebar" aria-label="Станции и сведения">
        <details class="stations-section" id="stations-section" open>
          <summary class="section-heading">Станции <span>${stationsConfig.stations.length}</span></summary>
          <ol id="station-list" class="station-list"></ol>
        </details>
        <details id="schedule-section" class="inset-surface schedule-section" open>
          <summary>Расписание</summary>
          <section id="station-details" class="station-details" aria-live="polite"></section>
        </details>
        <section id="train-details" class="inset-surface train-details" aria-live="polite" hidden></section>
        <details id="unplaced-details" class="unplaced-details" hidden><summary id="unplaced-summary"></summary><div id="unplaced-list"></div></details>
        <details class="map-diagnostics">
          <summary>Диагностика карты</summary>
          <dl>
            <div><dt>Масштаб</dt><dd id="zoom-value">—</dd></div>
            <div><dt>Коридор</dt><dd>500 м</dd></div>
            <div><dt>Запросов к Thunderforest</dt><dd id="tiles-requested">0</dd></div>
            <div><dt>Из локального кэша</dt><dd id="tiles-cached">0</dd></div>
            <div><dt>Ожидают загрузки</dt><dd id="tiles-pending">0</dd></div>
            <div><dt>Вне коридора, без запросов</dt><dd id="tiles-blocked">0</dd></div>
            <div><dt>Загружено</dt><dd id="tiles-loaded">0</dd></div>
            <div><dt>Ошибок</dt><dd id="tiles-failed">0</dd></div>
          </dl><p>Счётчики с момента открытия карты.</p>
        </details>
      </aside>
    </div>
    <footer class="panel-footer">
      <span class="map-status"><span class="status-light" id="status-light"></span><span id="tile-status" role="status">Загрузка подложки…</span></span>
      <span id="source-status" role="status">Чтение расписания…</span>
      <span>Положение по расписанию</span>
    </footer>
  </section>
`;

const apiKey = (import.meta.env.VITE_THUNDERFOREST_API_KEY || '').trim();
const stationButtons = new Map();
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const formatter = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const clockFormatter = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const formatTime = (time) => Number.isFinite(typeof time === 'number' ? time : parseTime(time))
  ? formatter.format(typeof time === 'number' ? time : parseTime(time)) : '—';
let sectionMap;
let snapshot = { stations: {}, observations: [] };
let model = { trips: [], unplaced: [] };
let selectedStation = stationsConfig.stations.find((station) => station.id === 'dmitrovskaya');
let selectedTrain = null;
let localError = null;
let hasTimetable = false;
const trainCounter = document.querySelector('#active-trains');

function showTrain(trip) {
  selectedTrain = { tripId: trip.id };
  renderTrainDetails();
  openInspector('train');
}

function showRecord(record, station) {
  const trip = model.trips.find((candidate) => candidate.trainNo === record.trainNo
    && candidate.anchors.some((anchor) => anchor.stationId === station.id && anchor.toMoscow === record.toMoscow && anchor.departureTime === record.departureTime));
  if (trip) showTrain(trip);
  else { selectedTrain = { record, station }; renderTrainDetails(); openInspector('train'); }
}

function renderStationDetails() {
  const station = selectedStation;
  const details = document.querySelector('#station-details');
  const focusedKey = details.contains(document.activeElement) ? document.activeElement.dataset.departureKey : null;
  const heading = element('h2', station.name);
  const nodes = [heading];
  if (!station.pollEnabled) {
    nodes.push(element('p', 'Источник расписания для этой станции не подключён.', 'schedule-status'));
  } else {
    const state = snapshot.stations[station.id];
    const status = !state?.lastSuccessfulAt ? (state?.error ? 'Расписание недоступно.' : 'Ожидание первого расписания.')
      : `${state.error ? 'Последние данные' : 'Обновлено'} ${formatTime(state.lastSuccessfulAt)}`;
    nodes.push(element('p', status, 'station-distance'));
    if (state?.error) nodes.push(element('p', state.lastSuccessfulAt
      ? 'Ошибка обновления; сохранённое расписание продолжает использоваться.' : 'Источник не передал расписание станции.', 'source-note'));
    for (const [direction, label] of [[true, 'В Москву'], [false, 'Из Москвы']]) {
      const group = element('section', undefined, 'departures-group');
      group.append(element('h3', label));
      const departures = (state?.trains || []).filter((train) => train.toMoscow === direction
        && Number.isFinite(parseTime(train.departureTime)) && parseTime(train.departureTime) + 15000 >= Date.now())
        .sort((a, b) => parseTime(a.departureTime) - parseTime(b.departureTime)).slice(0, appConfig.client.stationDeparturesPerDirection);
      if (!departures.length) group.append(element('p', state?.lastSuccessfulAt ? 'Нет ближайших отправлений.' : 'Нет данных.', 'empty-departures'));
      for (const train of departures) {
        const button = element('button', undefined, 'departure-button');
        button.type = 'button';
        button.dataset.departureKey = `${train.trainNo}:${train.departureTime}:${train.toMoscow}`;
        const time = element('time', formatTime(train.departureTime), 'departure-time');
        if (train.departureTime) time.dateTime = train.departureTime;
        const content = element('span', undefined, 'departure-content');
        content.append(element('span', train.destination || 'Конечная неизвестна'),
          element('span', train.trainNo ? `№ ${train.trainNo}` : 'Без номера', 'departure-number'));
        button.append(time, content);
        button.addEventListener('click', () => showRecord(train, station));
        group.append(button);
      }
      nodes.push(group);
    }
    const unknownDirection = (state?.trains || []).filter((record) => typeof record.toMoscow !== 'boolean').length;
    if (unknownDirection) nodes.push(element('p', `Неизвестно направление: ${unknownDirection}. Записи доступны в списке без позиции.`, 'source-note'));
  }
  details.replaceChildren(...nodes);
  if (focusedKey) {
    const replacement = [...details.querySelectorAll('.departure-button')].find((button) => button.dataset.departureKey === focusedKey);
    replacement?.focus({ preventScroll: true });
  }
}

function selectStation(station, pan = true) {
  selectedStation = station;
  for (const [id, button] of stationButtons) button.setAttribute('aria-pressed', String(id === station.id));
  renderStationDetails();
  sectionMap?.selectStation(station, { pan });
  const list = document.querySelector('#station-list');
  const button = stationButtons.get(station.id);
  if (list.clientHeight && button) {
    const row = button.getBoundingClientRect(); const bounds = list.getBoundingClientRect();
    if (row.top < bounds.top) list.scrollTop += row.top - bounds.top - 5;
    else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom + 5;
  }
  if (pan) openInspector('station');
}

function directionLabel(trip, record) {
  const pivot = stationsConfig.stations.find((station) => station.id === stationsConfig.section.directionPivotStationId);
  if (!trip || !pivot) return record.toMoscow ? 'В Москву' : 'Из Москвы';
  const now = Date.now();
  const position = getTrainPosition(trip, now, stationsConfig.stations, appConfig.motion, stationsConfig.section.geometryLengthMeters);
  const after = trip.direction * (position.centerMeters - pivot.alongTrackMeters);
  return after <= 0.001 ? 'В Москву' : 'Из Москвы';
}

function renderTrainDetails() {
  const details = document.querySelector('#train-details');
  if (!selectedTrain) { details.hidden = true; if (inspector.dataset.kind === 'train') closeInspector(); return; }
  const trip = selectedTrain.tripId ? model.trips.find((candidate) => candidate.id === selectedTrain.tripId) : null;
  const record = trip || selectedTrain.record;
  if (!record) { selectedTrain = null; details.hidden = true; if (inspector.dataset.kind === 'train') closeInspector(); return; }
  details.hidden = false;
  const header = element('div', undefined, 'train-card-header');
  header.append(element('h2', record.trainNo ? `Поезд № ${record.trainNo}` : 'Поезд без номера'));
  const close = element('button', '×', 'train-card-close');
  close.type = 'button'; close.setAttribute('aria-label', 'Закрыть карточку поезда');
  close.addEventListener('click', () => {
    const onMap = inspector.dataset.kind === 'train';
    selectedTrain = null; renderTrainDetails();
    if (onMap) fullscreenButton.focus({ preventScroll: true });
  });
  header.append(close);
  const nodes = [header, element('p', record.destination || 'Конечная неизвестна', 'train-destination'),
    element('p', record.trainClass || 'Тип неизвестен', 'station-distance')];
  if (typeof record.toMoscow === 'boolean') nodes.push(element('p', directionLabel(trip, record), 'train-direction station-distance'));
  if (trip) {
    const position = getTrainPosition(trip, Date.now(), stationsConfig.stations, appConfig.motion, stationsConfig.section.geometryLengthMeters);
    nodes.push(element('p', position.visible ? motionLabels[position.mode] : 'Вне участка', 'motion-mode'));
    for (const warning of trip.warnings) nodes.push(element('p', warning, 'source-note'));
    const anchors = element('ul', undefined, 'train-anchors');
    for (const anchor of trip.anchors) anchors.append(element('li', `${anchor.station.name} · ${formatTime(anchor.time)}`));
    nodes.push(anchors);
  } else {
    for (const issue of recordIssues(record, selectedTrain.station)) nodes.push(element('p', issue, 'source-note'));
  }
  const context = trip ? (trip.anchors.find((anchor) => anchor.stationId === selectedStation.id) || trip.anchors.at(-1)) : record;
  if (context.scheduleTime) {
    let timing = `Время API ${formatTime(context.departureTime)} · план ${formatTime(context.scheduleTime)}`;
    if (typeof context.delaySeconds === 'number' && context.delaySeconds !== 0) {
      timing += ` · отклонение ${context.delaySeconds > 0 ? '+' : '−'}${Math.abs(context.delaySeconds)} с`;
    }
    nodes.push(element('p', timing, 'station-distance'));
  }
  nodes.push(element('p', record.stops || 'Остановки неизвестны.', 'train-stops'));
  details.replaceChildren(...nodes);
}

function renderUnplaced() {
  const container = document.querySelector('#unplaced-details');
  container.hidden = model.unplaced.length === 0;
  document.querySelector('#unplaced-summary').textContent = `Без позиции на карте: ${model.unplaced.length}`;
  const list = document.querySelector('#unplaced-list');
  list.replaceChildren();
  for (const record of model.unplaced) {
    const button = element('button', undefined, 'unplaced-button'); button.type = 'button';
    button.append(element('strong', `${record.station?.name || 'Неизвестная станция'} · ${record.trainNo || 'Без номера'}`),
      element('span', record.issues.join(' · ')));
    button.addEventListener('click', () => showRecord(record, record.station));
    list.append(button);
  }
}

for (const station of stationsConfig.stations) {
  const item = element('li');
  const button = element('button', undefined, 'station-button');
  button.type = 'button'; button.setAttribute('aria-pressed', 'false'); button.dataset.stationId = station.id;
  const dot = element('span', undefined, 'station-dot'); dot.setAttribute('aria-hidden', 'true');
  button.append(dot, element('span', station.name, 'station-name'));
  button.addEventListener('click', () => selectStation(station));
  item.append(button); document.querySelector('#station-list').append(item); stationButtons.set(station.id, button);
}

let statsFrame;
function renderStats(stats) {
  cancelAnimationFrame(statsFrame);
  statsFrame = requestAnimationFrame(() => {
    for (const key of ['requested', 'blocked', 'loaded', 'failed']) document.querySelector(`#tiles-${key}`).textContent = stats[key];
    document.querySelector('#tiles-cached').textContent = stats.cacheHits;
    document.querySelector('#tiles-pending').textContent = stats.pending;
    const pending = stats.pending;
    document.querySelector('#tile-status').textContent = !apiKey ? 'Подложка не подключена'
      : pending > 0 ? 'Загрузка подложки…' : stats.failed > 0 ? (stats.loaded > 0 ? 'Часть подложки не загрузилась' : 'Подложка недоступна')
      : stats.loaded > 0 ? 'Подложка загружена' : 'Серый фон вне коридора';
    document.querySelector('#status-light').dataset.state = !apiKey || stats.failed > 0 ? 'warning' : pending > 0 ? 'loading' : 'ready';
  });
}

sectionMap = createSectionMap({
  container: document.querySelector('#map'), railway: JSON.parse(railway), stationsConfig,
  options: appConfig.map, motion: appConfig.motion, apiKey,
  onSelectStation: selectStation, onSelectTrain: showTrain, onStats: renderStats,
  onZoom(zoom) {
    document.querySelector('#zoom-value').textContent = zoom;
    document.querySelector('#zoom-in').disabled = zoom >= appConfig.map.maxZoom;
    document.querySelector('#zoom-out').disabled = zoom <= appConfig.map.minZoom;
  },
});
selectStation(selectedStation, false);
let manualTheme = null;
try { manualTheme = JSON.parse(localStorage.getItem('nata-map-theme-override')); } catch { /* Локальные настройки необязательны. */ }
let night = automaticNight();
function updateTheme() {
  const next = manualTheme?.period === themePeriod() && typeof manualTheme.night === 'boolean'
    ? manualTheme.night : automaticNight();
  if (next !== night) { night = next; applyTheme(); }
}
function applyTheme() {
  document.documentElement.dataset.theme = night ? 'night' : 'day';
  sectionMap.setNight(night);
  const button = document.querySelector('#theme-toggle');
  button.setAttribute('aria-pressed', String(night));
  button.textContent = night ? 'Дневной режим' : 'Ночной режим';
  button.title = 'Автоматически: ночь с 19:00 до 07:00 по Москве. Ручной выбор действует до следующей смены периода.';
}
updateTheme();
applyTheme();
document.querySelector('#theme-toggle').addEventListener('click', () => {
  night = !night; applyTheme();
  manualTheme = { night, period: themePeriod() };
  try { localStorage.setItem('nata-map-theme-override', JSON.stringify(manualTheme)); } catch { /* Сохраняем режим текущей вкладки. */ }
});
document.querySelector('#overview').addEventListener('click', sectionMap.fitSection);
document.querySelector('#zoom-in').addEventListener('click', sectionMap.zoomIn);
document.querySelector('#zoom-out').addEventListener('click', sectionMap.zoomOut);

const mapFrame = document.querySelector('.map-frame');
const fullscreenButton = document.querySelector('#fullscreen');
const inspector = document.querySelector('.map-inspector');
let inspectedNode = null;
let inspectorPlaceholder = null;
function closeInspector() {
  if (inspectedNode) inspectorPlaceholder.replaceWith(inspectedNode);
  inspectedNode = null; inspectorPlaceholder = null;
  inspector.hidden = true; delete inspector.dataset.kind;
}
function openInspector(kind) {
  if (!mapFrame.classList.contains('is-expanded')) return;
  closeInspector();
  inspectedNode = document.querySelector(kind === 'train' ? '#train-details' : '#station-details');
  inspectorPlaceholder = document.createComment('Место карточки в боковой панели');
  inspectedNode.before(inspectorPlaceholder);
  inspector.querySelector('.inspector-content').append(inspectedNode);
  inspector.dataset.kind = kind; inspector.hidden = false; inspector.scrollTop = 0;
}
inspector.querySelector('.inspector-close').addEventListener('click', () => { closeInspector(); fullscreenButton.focus({ preventScroll: true }); });
function updateFullscreen() {
  const expanded = mapFrame.classList.contains('is-expanded');
  document.body.classList.toggle('map-expanded', expanded);
  for (const node of document.querySelectorAll('.sidebar, .panel-header, .panel-footer')) node.inert = expanded;
  if (!expanded) closeInspector();
  fullscreenButton.setAttribute('aria-pressed', String(expanded));
  fullscreenButton.setAttribute('aria-label', expanded ? 'Вернуть карту в панель' : 'Развернуть карту на всё окно браузера');
  fullscreenButton.title = expanded ? 'Вернуть карту в панель (Esc)' : 'На всё окно браузера';
  fullscreenButton.querySelector('.fullscreen-label').textContent = expanded ? 'Свернуть карту' : 'На весь экран';
}
function toggleFullscreen() {
  mapFrame.classList.toggle('is-expanded');
  updateFullscreen();
}
function exitExpanded(event) {
  if (event.key === 'Escape' && mapFrame.classList.contains('is-expanded')) {
    mapFrame.classList.remove('is-expanded'); updateFullscreen(); fullscreenButton.focus({ preventScroll: true });
  }
}
fullscreenButton.addEventListener('click', toggleFullscreen);
document.addEventListener('keydown', exitExpanded);
updateFullscreen();

const stopPolling = startSnapshotPolling({
  config: stationsConfig,
  options: appConfig.collector,
  onSnapshot(next) {
    localError = null;
    hasTimetable = next.observations.length > 0 || Object.values(next.stations).some((station) => station.lastSuccessfulAt);
    if (next.collector?.revision !== snapshot.collector?.revision) {
      snapshot = next; model = buildTrips(snapshot, stationsConfig);
      renderTrainDetails(); renderUnplaced();
    }
    renderStationDetails();
    renderSourceStatus();
  },
  onError(error) { localError = error; renderSourceStatus(); },
});

function renderSourceStatus() {
  document.querySelector('#api-version-warning').hidden = !Object.values(snapshot.stations).some((station) => station.needReload === true);
  const successful = Object.values(snapshot.stations).filter((station) => station.lastSuccessfulAt);
  const errors = Object.values(snapshot.stations).filter((station) => station.error || station.needReload);
  const latest = Math.max(...successful.map((station) => parseTime(station.lastSuccessfulAt)));
  const cycleBudgetMs = (appConfig.collector.cyclePauseSeconds
    + stationsConfig.pollStationApiIds.length * (appConfig.collector.requestTimeoutSeconds + appConfig.collector.minRequestIntervalMs / 1000) + 60) * 1000;
  const stale = Date.now() - (parseTime(snapshot.publishedAt) || 0) > cycleBudgetMs;
  trainCounter.hidden = !hasTimetable;
  const counterLabel = !hasTimetable
    ? (localError ? 'Нет данных расписания' : 'Ожидание расписания…')
    : localError ? 'поездов · нет связи с расписанием'
    : stale ? 'поездов · расписание устарело' : 'поездов на карте';
  const label = document.querySelector('#train-counter-label');
  if (label.textContent !== counterLabel) label.textContent = counterLabel;
  document.querySelector('#source-status').textContent = !successful.length
    ? (localError ? `Расписание недоступно: ${localError.message || localError}` : 'Загрузка расписания из браузера')
    : `${localError || errors.length || stale ? 'Последние данные' : 'Обновлено'} ${formatTime(latest)} · ${successful.length}/${stationsConfig.pollStationApiIds.length} станции`;
}

let frame;
let lastFrame = 0;
function animate(timestamp) {
  if (timestamp - lastFrame >= 30) {
    // Каждый кадр зависит от абсолютного времени, а не накопленного шага.
    const count = sectionMap.renderTrains(model.trips, Date.now());
    const value = hasTimetable ? String(count) : '—';
    if (trainCounter.textContent !== value) trainCounter.textContent = value;
    lastFrame = timestamp;
  }
  frame = requestAnimationFrame(animate);
}
frame = requestAnimationFrame(animate);
function updateClock() {
  updateTheme();
  const clock = document.querySelector('#moscow-clock');
  clock.textContent = `${clockFormatter.format(Date.now())} · Москва`;
  clock.dateTime = new Date().toISOString();
  renderSourceStatus();
  // Обновляем только режим уже открытой карточки, сохраняя фокус и остальную разметку.
  if (selectedTrain?.tripId) {
    const trip = model.trips.find((candidate) => candidate.id === selectedTrain.tripId);
    const mode = document.querySelector('#train-details .motion-mode');
    if (trip && mode) {
      const position = getTrainPosition(trip, Date.now(), stationsConfig.stations, appConfig.motion, stationsConfig.section.geometryLengthMeters);
      mode.textContent = position.visible ? motionLabels[position.mode] : 'Вне участка';
      document.querySelector('#train-details .train-direction').textContent = directionLabel(trip, trip);
    }
  }
}
updateClock();
const clockTimer = setInterval(updateClock, 1000);
document.addEventListener('visibilitychange', updateClock);
if (import.meta.hot) import.meta.hot.dispose(() => {
  stopPolling(); cancelAnimationFrame(statsFrame); cancelAnimationFrame(frame); clearInterval(clockTimer);
  document.removeEventListener('visibilitychange', updateClock); sectionMap.destroy();
  document.body.classList.remove('map-expanded');
  document.removeEventListener('keydown', exitExpanded);
});
