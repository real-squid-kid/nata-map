export function createTrackGeometry(feature) {
  const coordinates = feature.geometry.coordinates;
  const distances = feature.properties.cumulativeMeters;
  const length = distances.at(-1);
  function pointAt(meters) {
    const s = Math.max(0, Math.min(length, meters));
    let low = 0;
    let high = distances.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (distances[middle] <= s) low = middle; else high = middle;
    }
    const fraction = (s - distances[low]) / (distances[high] - distances[low]);
    const start = coordinates[low];
    const end = coordinates[high];
    return [start[1] + (end[1] - start[1]) * fraction, start[0] + (end[0] - start[0]) * fraction];
  }
  function positions(from, to) {
    const start = Math.max(0, Math.min(length, Math.min(from, to)));
    const end = Math.max(0, Math.min(length, Math.max(from, to)));
    const result = [start];
    let low = 1; let high = distances.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (distances[middle] <= start) low = middle + 1; else high = middle;
    }
    for (let index = low; index < distances.length - 1 && distances[index] < end; index++) result.push(distances[index]);
    result.push(end);
    return result;
  }
  const slice = (from, to) => positions(from, to).map(pointAt);
  return { length, pointAt, slice, positions };
}
