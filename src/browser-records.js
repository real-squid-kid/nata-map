import { normalizeStationName } from './station-names.js';
import { parseTime } from './trips.js';

const moscowDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
});
const moscowDay = (time) => {
  const parts = Object.fromEntries(moscowDate.formatToParts(time).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const validTime = (value) => {
  const time = parseTime(value);
  return Number.isFinite(time) ? time : null;
};

export function normalizeStation(response, stationId) {
  if (!response || typeof response !== 'object' || response.stationId !== stationId || !Array.isArray(response.trains)) {
    throw new Error('Неверная структура ответа станции');
  }
  const text = (value) => typeof value === 'string' ? value : null;
  return {
    needReload: response.needReload === true,
    trains: response.trains.map((train) => {
      if (!train || typeof train !== 'object' || Array.isArray(train)) throw new Error('Неверная структура записи поезда');
      const ru = train.i18n?.ru;
      const delay = train.delaySeconds;
      return {
        trainNo: typeof train.trainNo === 'string' || Number.isInteger(train.trainNo) ? String(train.trainNo) : null,
        toMoscow: typeof train.toMoscow === 'boolean' ? train.toMoscow : null,
        departureTime: text(train.departureTime),
        scheduleTime: text(train.scheduleTime),
        delaySeconds: (typeof delay === 'number' || (typeof delay === 'string' && delay.trim()))
          && Number.isFinite(Number(delay)) ? Math.trunc(Number(delay)) : null,
        trainLength: text(train.trainLength),
        destination: text(ru?.destination),
        trainClass: text(ru?.trainClass?.name),
        stops: text(ru?.stops),
      };
    }),
  };
}

export function travelDirection(train, station, stations = [], destinationDirections = {}) {
  const destination = normalizeStationName(train.destination);
  if (destination && Number.isFinite(station.alongTrackMeters) && stations.length) {
    for (const [name, direction] of Object.entries(destinationDirections)) {
      if (normalizeStationName(name) === destination && [-1, 1].includes(direction)) return direction;
    }
    const distances = stations.map((item) => item.alongTrackMeters).filter(Number.isFinite);
    for (const terminal of stations) {
      if (!Number.isFinite(terminal.alongTrackMeters)) continue;
      if (![terminal.name, ...(terminal.aliases || [])].some((name) => normalizeStationName(name) === destination)) continue;
      if (terminal.alongTrackMeters === Math.min(...distances)) return -1;
      if (terminal.alongTrackMeters === Math.max(...distances)) return 1;
      const delta = terminal.alongTrackMeters - station.alongTrackMeters;
      return Math.abs(delta) > 0.001 ? Math.sign(delta) : null;
    }
  }
  if ([-1, 1].includes(train.travelDirection)) return train.travelDirection;
  if (typeof train.toMoscow !== 'boolean') return null;
  const step = station.apiToMoscowDirectionStep ?? 1;
  return [-1, 1].includes(step) ? (train.toMoscow ? step : -step) : null;
}

async function trainHash(train) {
  const bytes = new TextEncoder().encode(JSON.stringify(train));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function mergeObservations(history, trains, station, seenAt, windowSeconds, stations = [], destinationDirections = {}) {
  for (const source of trains) {
    const train = { ...source, travelDirection: travelDirection(source, station, stations, destinationDirections),
      alongTrackMeters: station.alongTrackMeters ?? null };
    const departure = validTime(train.departureTime);
    let runId = null;
    if (train.trainNo !== null && train.travelDirection !== null && departure !== null) {
      const identityTime = validTime(train.scheduleTime) ?? departure;
      const runs = new Map();
      const excluded = new Set();
      for (const old of history.values()) {
        const oldDirection = old.travelDirection ?? (old.toMoscow ? 1 : -1);
        if (old.trainNo !== train.trainNo || oldDirection !== train.travelDirection || !old.runId) continue;
        const oldTime = validTime(old.scheduleTime) ?? validTime(old.departureTime);
        if (oldTime === null) continue;
        if (old.stationId === station.id && Math.abs(identityTime - oldTime) > 1_800_000) excluded.add(old.runId);
        const run = runs.get(old.runId) || { minimum: oldTime, maximum: oldTime, distance: Infinity };
        run.minimum = Math.min(run.minimum, oldTime);
        run.maximum = Math.max(run.maximum, oldTime);
        run.distance = Math.min(run.distance, Math.abs(identityTime - oldTime));
        runs.set(old.runId, run);
      }
      const candidate = [...runs].filter(([id, run]) => !excluded.has(id)
        && Math.max(run.maximum, identityTime) - Math.min(run.minimum, identityTime) <= windowSeconds * 1000)
        .sort((a, b) => a[1].distance - b[1].distance)[0];
      runId = candidate?.[0] ?? `${moscowDay(departure)}:${train.trainNo}:${train.travelDirection}:${Math.floor(departure / 1000)}`;
    }
    const id = runId !== null ? `${runId}:${station.id}` : `${station.id}:unplaced:${await trainHash(train)}`;
    const previous = history.get(id);
    history.set(id, { ...train, id, runId, stationId: station.id,
      firstSeenAt: previous?.firstSeenAt ?? train.firstSeenAt ?? seenAt, lastSeenAt: seenAt });
  }
  return history;
}

export async function rebuildObservationHistory(observations, stations, windowSeconds, destinationDirections = {}) {
  const stationMap = new Map(stations.map((station) => [station.id, station]));
  const history = new Map();
  for (const observation of [...observations].sort((a, b) => (validTime(a.lastSeenAt) ?? 0) - (validTime(b.lastSeenAt) ?? 0))) {
    const station = stationMap.get(observation.stationId);
    if (station) await mergeObservations(history, [observation], station, observation.lastSeenAt,
      windowSeconds, stations, destinationDirections);
  }
  return history;
}

export function trimHistory(history, cutoff) {
  for (const [id, observation] of history) {
    if ((validTime(observation.departureTime) ?? validTime(observation.lastSeenAt) ?? 0) < cutoff) history.delete(id);
  }
}
