// Локальные географические метры: учитываем широту участка, а не масштаб Web Mercator.
const EARTH_RADIUS_METERS = 6371008.8;
const radians = (degrees) => degrees * Math.PI / 180;

export function tileBounds({ x, y, z }) {
  const count = 2 ** z;
  const latitude = (row) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / count))) * 180 / Math.PI;
  return {
    west: x / count * 360 - 180,
    east: (x + 1) / count * 360 - 180,
    south: latitude(y + 1),
    north: latitude(y),
  };
}

function pointSegmentDistanceSquared(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return (point.x - start.x - t * dx) ** 2 + (point.y - start.y - t * dy) ** 2;
}

function pointRectangleDistanceSquared(point, rect) {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.bottom - point.y, 0, point.y - rect.top);
  return dx * dx + dy * dy;
}

function segmentIntersectsRectangle(start, end, rect) {
  // Liang–Barsky: пересечение отрезка со всем прямоугольником, включая его границу.
  let enter = 0;
  let leave = 1;
  for (const [value, delta, minimum, maximum] of [
    [start.x, end.x - start.x, rect.left, rect.right],
    [start.y, end.y - start.y, rect.bottom, rect.top],
  ]) {
    if (delta === 0) {
      if (value < minimum || value > maximum) return false;
    } else {
      const first = (minimum - value) / delta;
      const last = (maximum - value) / delta;
      enter = Math.max(enter, Math.min(first, last));
      leave = Math.min(leave, Math.max(first, last));
      if (enter > leave) return false;
    }
  }
  return true;
}

function segmentRectangleDistanceSquared(start, end, rect) {
  if (segmentIntersectsRectangle(start, end, rect)) return 0;
  return Math.min(
    pointRectangleDistanceSquared(start, rect),
    pointRectangleDistanceSquared(end, rect),
    ...[
      { x: rect.left, y: rect.bottom }, { x: rect.left, y: rect.top },
      { x: rect.right, y: rect.bottom }, { x: rect.right, y: rect.top },
    ].map((corner) => pointSegmentDistanceSquared(corner, start, end)),
  );
}

export function createCorridor({ coordinates, stationLocations, bufferMeters }) {
  if (coordinates.length < 2 || !Number.isFinite(bufferMeters) || bufferMeters < 0) {
    throw new Error('Некорректная геометрия коридора');
  }
  const originLongitude = coordinates[0][0];
  const referenceLatitude = coordinates.reduce((sum, point) => sum + point[1], 0) / coordinates.length;
  const longitudeScale = EARTH_RADIUS_METERS * Math.cos(radians(referenceLatitude));
  const project = ([longitude, latitude]) => ({
    x: radians(longitude - originLongitude) * longitudeScale,
    y: radians(latitude - referenceLatitude) * EARTH_RADIUS_METERS,
  });
  const line = coordinates.map(project);
  const stations = stationLocations.map(project);
  const bufferSquared = bufferMeters ** 2;

  function intersectsBounds(bounds) {
    const southwest = project([bounds.west, bounds.south]);
    const northeast = project([bounds.east, bounds.north]);
    const rectangle = {
      left: southwest.x, right: northeast.x, bottom: southwest.y, top: northeast.y,
    };
    if (stations.some((station) => pointRectangleDistanceSquared(station, rectangle) <= bufferSquared)) {
      return true;
    }
    for (let index = 1; index < line.length; index++) {
      if (segmentRectangleDistanceSquared(line[index - 1], line[index], rectangle) <= bufferSquared) {
        return true;
      }
    }
    return false;
  }

  return {
    intersectsBounds,
    intersectsTile: (coords) => intersectsBounds(tileBounds(coords)),
  };
}
