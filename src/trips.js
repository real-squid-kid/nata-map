export function parseTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
}

export function recordIssues(record, station) {
  const issues = [];
  if (record.trainNo === null || record.trainNo === undefined || record.trainNo === '') issues.push('Нет номера поезда');
  if (typeof record.toMoscow !== 'boolean') issues.push('Неизвестно направление');
  if (!Number.isFinite(parseTime(record.departureTime))) issues.push('Нет пригодного времени отправления');
  if (!station || !Number.isFinite(station.alongTrackMeters)) issues.push('Нет привязки к пути');
  return issues;
}

const normalizeName = (name) => String(name || '').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();

export function buildTrips(snapshot, config) {
  const stations = new Map(config.stations.map((station) => [station.id, station]));
  const groups = new Map();
  for (const observation of snapshot.observations || []) {
    const station = stations.get(observation.stationId);
    if (!observation.runId || recordIssues(observation, station).length) continue;
    if (!groups.has(observation.runId)) groups.set(observation.runId, []);
    groups.get(observation.runId).push(observation);
  }
  const trips = [];
  for (const [id, observations] of groups) {
    const latest = [...observations].sort((a, b) => (parseTime(b.lastSeenAt) || 0) - (parseTime(a.lastSeenAt) || 0))[0];
    const direction = latest.toMoscow ? config.section.toMoscowDirectionStep : config.section.fromMoscowDirectionStep;
    const anchors = observations.map((record) => ({
      ...record, time: parseTime(record.departureTime), station: stations.get(record.stationId),
      s: stations.get(record.stationId).alongTrackMeters,
    })).sort((a, b) => direction * (a.s - b.s));
    const warnings = [];
    for (let i = 1; i < anchors.length; i++) {
      if (anchors[i].time - anchors[i - 1].time <= 30000) warnings.push('Противоречивые временные точки');
    }
    const terminal = config.stations.find((station) => normalizeName(station.name) === normalizeName(latest.destination)) || null;
    trips.push({ id, trainNo: latest.trainNo, direction, toMoscow: latest.toMoscow, anchors, terminal,
      destination: latest.destination, trainClass: latest.trainClass, stops: latest.stops,
      warnings: [...new Set(warnings)], observations });
  }
  const unplaced = [];
  for (const [stationId, state] of Object.entries(snapshot.stations || {})) {
    const station = stations.get(stationId);
    for (const [index, record] of (state.trains || []).entries()) {
      const issues = recordIssues(record, station);
      if (issues.length) unplaced.push({ ...record, station, id: `${stationId}:${index}`, issues });
    }
  }
  return { trips, unplaced };
}
