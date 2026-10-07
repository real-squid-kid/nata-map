// Расстояния вдоль пути между центрами видимых составов, без экранных смещений.
export function getCloseTrainIds(trains, thresholdMeters = 1000) {
  const close = new Set();
  const directions = new Map();
  for (const train of trains) {
    if (!Number.isFinite(train.centerMeters)) continue;
    if (!directions.has(train.direction)) directions.set(train.direction, []);
    directions.get(train.direction).push(train);
  }
  for (const group of directions.values()) {
    group.sort((a, b) => a.centerMeters - b.centerMeters);
    for (let i = 1; i < group.length; i++) {
      if (group[i].centerMeters - group[i - 1].centerMeters <= thresholdMeters) {
        close.add(group[i - 1].id);
        close.add(group[i].id);
      }
    }
  }
  return close;
}
