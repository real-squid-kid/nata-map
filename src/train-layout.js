// Смещение в пикселях — только условные соседние пути, без изменения геометрии движения.
export function offsetTrackPoint(s, direction, track, project, offsetPx) {
  const point = project(track.pointAt(s));
  const before = project(track.pointAt(s - 10));
  const after = project(track.pointAt(s + 10));
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const norm = Math.hypot(dx, dy) || 1;
  return { x: point.x - dy / norm * direction * offsetPx, y: point.y + dx / norm * direction * offsetPx };
}

export function getTrainLayout({ track, project, centerMeters, direction, trainLengthMeters, options, zoom, night = false }) {
  const half = trainLengthMeters / 2;
  const start = centerMeters - half;
  const end = centerMeters + half;
  const at = (s) => offsetTrackPoint(s, direction, track, project, options.directionOffsetPx);
  const points = track.positions(start, end).map(at);
  const slotLength = trainLengthMeters / options.wagonCount;
  const wagons = [];
  for (let index = 0; index < options.wagonCount; index++) {
    const frontS = centerMeters + direction * (half - index * slotLength);
    const rearS = centerMeters + direction * (half - (index + 1) * slotLength);
    if (Math.max(frontS, rearS) <= 0 || Math.min(frontS, rearS) >= track.length) continue;
    const front = at(frontS);
    const rear = at(rearS);
    const distance = Math.hypot(front.x - rear.x, front.y - rear.y);
    if (distance < 0.01) continue;
    const unit = { x: (front.x - rear.x) / distance, y: (front.y - rear.y) / distance };
    const gapPx = Math.min(distance * 0.3, Math.max(1.2, options.wagonGapMeters / slotLength * distance));
    const frontGap = index > 0 ? gapPx / 2 : 0;
    const rearGap = index < options.wagonCount - 1 ? gapPx / 2 : 0;
    wagons.push({
      index,
      role: index === 0 ? 'head' : index === options.wagonCount - 1 ? 'tail' : 'middle',
      x: (front.x + rear.x + unit.x * (rearGap - frontGap)) / 2,
      y: (front.y + rear.y + unit.y * (rearGap - frontGap)) / 2,
      angle: Math.atan2(unit.y, unit.x) * 180 / Math.PI,
      length: Math.max(0.01, distance - frontGap - rearGap),
      width: options.wagonWidthPx,
    });
  }
  const headS = centerMeters + direction * half;
  const tailS = centerMeters - direction * half;
  const mode = zoom >= (night ? options.nightSpriteMinZoom : options.spriteMinZoom) ? 'wagons' : 'capsule';
  const head = headS >= 0 && headS <= track.length ? at(headS) : null;
  let arrow = null;
  if (mode === 'capsule' && head) {
    const before = at(headS - direction * 10);
    const after = at(headS + direction * 10);
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const distance = Math.hypot(dx, dy);
    // Экранный зазор сохраняет читаемость стрелки при любом масштабе.
    if (distance > 0.01) arrow = {
      x: head.x + dx / distance * 13,
      y: head.y + dy / distance * 13,
      angle: Math.atan2(dy, dx) * 180 / Math.PI,
    };
  }
  return {
    mode, arrow,
    points, wagons, center: at(centerMeters),
    head,
    tail: tailS >= 0 && tailS <= track.length ? at(tailS) : null,
  };
}
