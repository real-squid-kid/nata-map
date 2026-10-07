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
  function slice(from, to) {
    const start = Math.max(0, Math.min(length, Math.min(from, to)));
    const end = Math.max(0, Math.min(length, Math.max(from, to)));
    const result = [pointAt(start)];
    for (let index = 1; index < distances.length - 1; index++) {
      if (distances[index] > start && distances[index] < end) result.push([coordinates[index][1], coordinates[index][0]]);
    }
    result.push(pointAt(end));
    return result;
  }
  return { length, pointAt, slice };
}
