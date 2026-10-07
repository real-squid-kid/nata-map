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

export function getTrainPosition(trip, now, stations, motion, geometryLength) {
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

export const motionLabels = {
  schedule: 'По временам станций', fallback: 'Расчёт со скоростью 60 км/ч',
  'fallback-dwell': 'Условная стоянка', dwell: 'Стоянка на станции', terminal: 'Стоянка на конечной',
};
