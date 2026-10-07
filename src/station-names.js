export const normalizeStationName = (name) => String(name || '').toLocaleLowerCase('ru-RU')
  .replaceAll('ё', 'е').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

export const matchesStationName = (name, station) => [station.name, ...(station.aliases || [])]
  .some((alias) => normalizeStationName(alias) === normalizeStationName(name));
