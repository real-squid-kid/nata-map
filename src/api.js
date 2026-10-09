import { mergeObservations, normalizeStation, rebuildObservationHistory, trimHistory } from './browser-records.js';
import { readSnapshot, writeSnapshot } from './browser-store.js';

const LOCK = 'nata-map-browser-collector-v1';
const CHANNEL = 'nata-map-browser-snapshot-v1';
const emptySnapshot = () => ({ schemaVersion: 1, directionNormalizationVersion: 3,
  stations: {}, observations: [], collector: { status: 'waiting', revision: 0 } });
const iso = (time) => new Date(time).toISOString();

function delay(ms, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function fetchStation(stationId, options, signal) {
  const url = new URL('/api/v2', options.baseUrl);
  url.searchParams.set('station', stationId);
  url.searchParams.set('build', options.build);
  const timeout = AbortSignal.timeout(options.requestTimeoutSeconds * 1000);
  const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store',
    signal: AbortSignal.any([signal, timeout]) });
  if (!response.ok) throw new Error(`API вернул HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error('Ответ API слишком большой');
  return normalizeStation(JSON.parse(body), stationId);
}

export async function runCollectorCycle({ snapshot, config, options, request, publish, sleep, signal, now = Date.now }) {
  let history = new Map(snapshot.observations.map((observation) => [observation.id, observation]));
  if (snapshot.collector.status !== 'collecting') {
    snapshot.collector.status = 'collecting';
    snapshot.collector.cycleStartedAt = iso(now());
    snapshot.collector.nextStationIndex = 0;
    await publish(snapshot);
  }
  const stations = new Map(config.stations.filter((station) => station.apiStationId !== null)
    .map((station) => [station.apiStationId, station]));
  for (let index = snapshot.collector.nextStationIndex || 0; index < config.pollStationApiIds.length; index++) {
    if (signal.aborted) throw signal.reason;
    const apiId = config.pollStationApiIds[index];
    const station = stations.get(apiId);
    if (!station) throw new Error(`Станция API ${apiId} отсутствует в каталоге`);
    const remaining = (snapshot.collector.lastRequestStartedUnix || 0) * 1000 + options.minRequestIntervalMs - now();
    if (remaining > 0) await sleep(remaining, signal);
    const started = now();
    snapshot.collector.lastRequestStartedUnix = started / 1000;
    const seenAt = iso(started);
    const previous = snapshot.stations[station.id] || { trains: [], lastSuccessfulAt: null };
    snapshot.stations[station.id] = { ...previous, stationId: station.id, apiStationId: apiId, fetchedAt: seenAt };
    await publish(snapshot);
    try {
      const result = await request(apiId, options, signal);
      if (signal.aborted) throw signal.reason;
      const nextHistory = new Map(history);
      await mergeObservations(nextHistory, result.trains, station, seenAt, options.tripMatchWindowSeconds,
        config.stations, config.section.destinationDirections);
      history = nextHistory;
      snapshot.stations[station.id] = { ...snapshot.stations[station.id], ...result,
        lastSuccessfulAt: iso(now()), error: null };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      snapshot.stations[station.id] = { ...snapshot.stations[station.id], error: error.message || String(error) };
    }
    snapshot.collector.nextStationIndex = index + 1;
    snapshot.observations = [...history.values()];
    await publish(snapshot);
  }
  trimHistory(history, now() - options.historyRetentionHours * 3_600_000);
  snapshot.observations = [...history.values()];
  snapshot.collector.status = 'waiting';
  snapshot.collector.cycleCompletedAt = iso(now());
  snapshot.collector.nextCycleAt = iso(now() + options.cyclePauseSeconds * 1000);
  snapshot.collector.nextStationIndex = 0;
  await publish(snapshot);
}

export function startSnapshotPolling({ config, options, onSnapshot, onError }) {
  const controller = new AbortController();
  const channel = new BroadcastChannel(CHANNEL);
  let latestRevision = -1;
  const emit = (snapshot) => {
    if (snapshot?.schemaVersion === 1 && snapshot.collector?.revision > latestRevision) {
      latestRevision = snapshot.collector.revision;
      onSnapshot(structuredClone(snapshot));
    }
  };
  channel.onmessage = () => { readSnapshot().then(emit).catch(onError); };

  async function publish(snapshot) {
    snapshot.publishedAt = iso(Date.now());
    snapshot.collector.revision = (snapshot.collector.revision || 0) + 1;
    await writeSnapshot(snapshot);
    emit(snapshot);
    channel.postMessage('updated');
  }

  async function lead() {
    let snapshot = await readSnapshot() || emptySnapshot();
    if (snapshot.directionNormalizationVersion !== 3) {
      const history = await rebuildObservationHistory(snapshot.observations || [], config.stations,
        options.tripMatchWindowSeconds, config.section.destinationDirections);
      snapshot.observations = [...history.values()];
      snapshot.directionNormalizationVersion = 3;
      await publish(snapshot);
    }
    emit(snapshot);
    while (!controller.signal.aborted) {
      const next = Date.parse(snapshot.collector.nextCycleAt);
      if (snapshot.collector.status !== 'collecting' && Number.isFinite(next) && next > Date.now()) {
        await delay(next - Date.now(), controller.signal);
      }
      await runCollectorCycle({ snapshot, config, options,
        request: fetchStation, publish, sleep: delay, signal: controller.signal });
    }
  }

  (async () => {
    if (!navigator.locks) throw new Error('Браузер не поддерживает Web Locks для единого опросчика');
    emit(await readSnapshot());
    await navigator.locks.request(LOCK, { mode: 'exclusive', signal: controller.signal }, lead);
  })().catch((error) => { if (!controller.signal.aborted) onError(error); });

  return () => { controller.abort(); channel.close(); };
}
