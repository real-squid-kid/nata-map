import { normalizeStationName } from './station-names.js';

function walkFallback(start, seconds, direction, stations, speed, dwell) {
  const stops = stations.filter((station) => direction * (station.alongTrackMeters - start) > 0.001)
    .sort((a, b) => direction * (a.alongTrackMeters - b.alongTrackMeters));
  let s = start;
  for (const station of stops) {
    const next = station.alongTrackMeters;
    const travel = Math.abs(next - s) / speed;
    if (seconds < travel) return { centerMeters: s + direction * seconds * speed, mode: 'fallback' };
    seconds -= travel;
    if (seconds < dwell) return { centerMeters: next, mode: 'fallback-dwell' };
    seconds -= dwell;
    s = next;
  }
  return { centerMeters: s + direction * seconds * speed, mode: 'fallback' };
}

function terminalArrival(trip, stations, motion) {
  if (!trip.terminal) return null;
  const terminalS = trip.terminal.alongTrackMeters;
  const known = trip.anchors.find((anchor) => Math.abs(anchor.s - terminalS) < 0.001);
  if (known) return known.time - motion.dwellSeconds * 500;
  const last = trip.anchors.at(-1);
  if (trip.direction * (terminalS - last.s) < 0) return null;
  const intermediate = stations.filter((station) => trip.direction * (station.alongTrackMeters - last.s) > 0.001
    && trip.direction * (terminalS - station.alongTrackMeters) > 0.001).length;
  return last.time + motion.dwellSeconds * 500
    + Math.abs(terminalS - last.s) / (motion.fallbackSpeedKmh / 3.6) * 1000
    + intermediate * motion.dwellSeconds * 1000;
}

function scheduledLeg(a, b, stations, motion) {
  const direction = Math.sign(b.s - a.s);
  const stops = stations.filter((station) => !station.pollEnabled
    && direction * (station.alongTrackMeters - a.s) > 0.001
    && direction * (b.s - station.alongTrackMeters) > 0.001)
    .sort((x, y) => direction * (x.alongTrackMeters - y.alongTrackMeters));
  const start = a.time + motion.dwellSeconds * 500;
  const end = b.time - motion.dwellSeconds * 500;
  const movingMs = end - start - stops.length * motion.dwellSeconds * 1000;
  if (movingMs <= 0 || a.s === b.s) return null;
  const speed = Math.abs(b.s - a.s) / movingMs;
  let time = start; let s = a.s;
  const segments = [];
  for (const station of [...stops, { alongTrackMeters: b.s }]) {
    const next = station.alongTrackMeters;
    const arrival = time + Math.abs(next - s) / speed;
    segments.push({ start: time, end: arrival, from: s, to: next, mode: 'schedule' });
    if (next !== b.s) {
      segments.push({ start: arrival, end: arrival + motion.dwellSeconds * 1000, from: next, to: next, mode: 'schedule-dwell' });
      time = arrival + motion.dwellSeconds * 1000;
    }
    s = next;
  }
  return segments;
}

function computeTrainPosition(trip, now, stations, motion, geometryLength) {
  const halfDwellMs = motion.dwellSeconds * 500;
  const speed = motion.fallbackSpeedKmh / 3.6;
  const halfLength = motion.trainLengthMeters / 2;
  const anchors = trip.anchors;
  if (!anchors.length) return { visible: false, mode: 'unplaced' };
  const arrivalAtTerminal = terminalArrival(trip, stations, motion);
  if (arrivalAtTerminal !== null && now >= arrivalAtTerminal) {
    return {
      centerMeters: trip.terminal.alongTrackMeters,
      visible: now < arrivalAtTerminal + motion.terminalDwellSeconds * 1000,
      mode: 'terminal',
    };
  }
  const visibility = (result) => ({ ...result,
    visible: result.centerMeters + halfLength > 0 && result.centerMeters - halfLength < geometryLength });
  for (const anchor of anchors) {
    if (now >= anchor.time - halfDwellMs && now <= anchor.time + halfDwellMs) {
      return visibility({ centerMeters: anchor.s, mode: 'dwell' });
    }
  }
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1];
    const b = anchors[i];
    const start = a.time + halfDwellMs;
    const end = b.time - halfDwellMs;
    if (end > start && now > start && now < end) {
      const segment = scheduledLeg(a, b, stations, motion)?.find((part) => now >= part.start && now <= part.end);
      if (segment) return visibility({ centerMeters: segment.from + (segment.to - segment.from) * (now - segment.start) / (segment.end - segment.start), mode: segment.mode });
      return visibility({ centerMeters: a.s + (b.s - a.s) * (now - start) / (end - start), mode: 'schedule' });
    }
  }
  // Ближайший по времени известный якорь используется и при противоречивых интервалах.
  const anchor = [...anchors].sort((a, b) => Math.abs(now - a.time) - Math.abs(now - b.time))[0];
  const before = now < anchor.time;
  const elapsed = before ? (anchor.time - halfDwellMs - now) / 1000 : (now - anchor.time - halfDwellMs) / 1000;
  return visibility(walkFallback(anchor.s, Math.max(0, elapsed), before ? -trip.direction : trip.direction,
    stations, speed, motion.dwellSeconds));
}

function departureAtStation(trip, station, stations, motion) {
  const known = trip.anchors.find((anchor) => Math.abs(anchor.s - station.alongTrackMeters) < 0.001);
  if (known) return known.time + motion.dwellSeconds * 500;
  const preceding = trip.anchors.filter((anchor) => trip.direction * (station.alongTrackMeters - anchor.s) > 0)
    .sort((a, b) => trip.direction * (b.s - a.s))[0];
  if (!preceding) return null;
  const following = trip.anchors.find((anchor) => trip.direction * (anchor.s - station.alongTrackMeters) > 0);
  if (following && following.time - preceding.time > motion.dwellSeconds * 1000) {
    const segments = scheduledLeg(preceding, following, stations, motion);
    const dwell = segments?.find((part) => part.mode === 'schedule-dwell' && Math.abs(part.to - station.alongTrackMeters) < 0.001);
    if (dwell) return dwell.end;
    const moving = segments?.find((part) => part.mode === 'schedule' && trip.direction * (station.alongTrackMeters - part.from) >= 0 && trip.direction * (part.to - station.alongTrackMeters) >= 0);
    if (moving) return moving.start + (moving.end - moving.start) * (station.alongTrackMeters - moving.from) / (moving.to - moving.from);
    const fraction = (station.alongTrackMeters - preceding.s) / (following.s - preceding.s);
    return preceding.time + motion.dwellSeconds * 500
      + (following.time - preceding.time - motion.dwellSeconds * 1000) * fraction;
  }
  const intermediate = stations.filter((candidate) => trip.direction * (candidate.alongTrackMeters - preceding.s) > 0.001
    && trip.direction * (station.alongTrackMeters - candidate.alongTrackMeters) > 0.001).length;
  return preceding.time + motion.dwellSeconds * 500
    + Math.abs(station.alongTrackMeters - preceding.s) / (motion.fallbackSpeedKmh / 3.6) * 1000
    + (intermediate + 1) * motion.dwellSeconds * 1000;
}

export function getTrainPosition(trip, now, stations, motion, geometryLength) {
  const position = computeTrainPosition(trip, now, stations, motion, geometryLength);
  const rule = (motion.exitRules || []).find((candidate) => candidate.direction === trip.direction
    && candidate.destinationAliases.some((name) => normalizeStationName(name) === normalizeStationName(trip.destination)));
  const exits = stations.filter((station) => (motion.coverageExitStationIds || []).includes(station.id))
    .sort((a, b) => a.alongTrackMeters - b.alongTrackMeters);
  const station = rule ? stations.find((candidate) => candidate.id === rule.afterStationId)
    : !trip.terminal && trip.destination ? (trip.direction > 0 ? exits.at(-1) : exits[0]) : null;
  const fadeAt = station ? departureAtStation(trip, station, stations, motion) : null;
  const duration = (rule?.fadeSeconds || motion.edgeFadeSeconds || 30) * 1000;
  const opacity = fadeAt === null ? 1 : Math.max(0, Math.min(1, 1 - (now - fadeAt) / duration));
  return { ...position, opacity, visible: position.visible && opacity > 0,
    mode: opacity < 1 ? 'exit' : position.mode };
}

export const motionLabels = {
  schedule: 'По временам станций', fallback: 'Расчёт со скоростью 75 км/ч',
  'schedule-dwell': 'Условная стоянка',
  'fallback-dwell': 'Условная стоянка', dwell: 'Стоянка на станции', terminal: 'Стоянка на конечной',
  exit: 'Уход за пределы линии',
};
