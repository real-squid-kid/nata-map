import L from 'leaflet';

export function createCorridorTileLayer({ corridor, apiKey, style, minZoom, maxZoom, onStats }) {
  const stats = { requested: 0, blocked: 0, loaded: 0, failed: 0, withoutKey: 0 };
  const notify = () => onStats({ ...stats });
  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('div');
      tile.className = 'corridor-tile';
      tile.dataset.tileCoords = `${coords.z}/${coords.x}/${coords.y}`;
      const allowed = corridor.intersectsTile(coords);
      tile.dataset.inCorridor = String(allowed);

      // Сначала геометрическая проверка. У внешней ячейки нет ни img, ни внешнего src.
      if (!allowed || !apiKey) {
        tile.dataset.tileState = allowed ? 'without-key' : 'blocked';
        stats[allowed ? 'withoutKey' : 'blocked']++;
        notify();
        requestAnimationFrame(() => done(null, tile));
        return tile;
      }

      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      tile.dataset.tileState = 'loading';
      image.onload = () => {
        tile.dataset.tileState = 'loaded';
        stats.loaded++;
        notify();
        done(null, tile);
      };
      image.onerror = () => {
        tile.dataset.tileState = 'error';
        image.remove();
        stats.failed++;
        notify();
        // Ошибка подложки не мешает геометрии, станциям и завершению загрузки слоя.
        done(new Error('Не удалось загрузить тайл подложки'), tile);
      };
      tile.append(image);
      stats.requested++;
      notify();
      image.src = `https://api.thunderforest.com/${encodeURIComponent(style)}/${coords.z}/${coords.x}/${coords.y}.png?apikey=${encodeURIComponent(apiKey)}`;
      return tile;
    },
  });

  return new Layer({
    tileSize: 256, minZoom, maxZoom,
    noWrap: true,
    keepBuffer: 0,
    updateWhenIdle: true,
    updateWhenZooming: false,
    attribution: 'Maps © <a href="https://www.thunderforest.com/" target="_blank" rel="noopener">Thunderforest</a>',
  });
}
