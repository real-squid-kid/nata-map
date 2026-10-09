import L from 'leaflet';
import { getTileBlob } from './tile-cache.js';

export function createMapTileLayer({ apiKey, style, minZoom, maxZoom, nativeMaxZoom, corridor, pane, onStats }) {
  const stats = { requested: 0, cacheHits: 0, pending: 0, loaded: 0, failed: 0, withoutKey: 0, blocked: 0 };
  const notify = () => onStats({ ...stats });
  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('div');
      tile.className = corridor ? 'map-tile map-detail-tile' : 'map-tile map-base-tile';
      tile.dataset.tileCoords = `${coords.z}/${coords.x}/${coords.y}`;

      if (corridor && !corridor.intersectsTile(coords)) {
        tile.dataset.tileState = 'blocked';
        stats.blocked++;
        notify();
        requestAnimationFrame(() => done(null, tile));
        return tile;
      }

      if (!apiKey) {
        tile.dataset.tileState = 'without-key';
        stats.withoutKey++;
        notify();
        requestAnimationFrame(() => done(null, tile));
        return tile;
      }

      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      tile.dataset.tileState = 'loading';
      stats.pending++;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; stats.pending--; notify();
        if (!tile.discarded) done(error, tile);
      };
      tile.cancel = () => finish(null);
      image.onload = () => {
        if (settled || tile.discarded) return;
        tile.dataset.tileState = 'loaded';
        stats.loaded++;
        notify();
        finish(null);
      };
      image.onerror = () => {
        if (settled || tile.discarded) return;
        tile.dataset.tileState = 'error';
        image.remove();
        stats.failed++;
        notify();
        // Ошибка подложки не мешает геометрии, станциям и завершению загрузки слоя.
        finish(new Error('Не удалось загрузить тайл подложки'));
      };
      tile.append(image);
      notify();
      getTileBlob({ style, coords, apiKey,
        onNetwork() { stats.requested++; notify(); }, onCache() { stats.cacheHits++; notify(); },
      }).then((blob) => {
        if (tile.discarded) { finish(null); return; }
        tile.objectUrl = URL.createObjectURL(blob);
        image.src = tile.objectUrl;
      }).catch(() => image.onerror());
      return tile;
    },
  });

  const layer = new Layer({
    tileSize: 256, minZoom, maxZoom, ...(nativeMaxZoom == null ? {} : { maxNativeZoom: nativeMaxZoom }),
    ...(pane ? { pane } : {}),
    noWrap: true,
    keepBuffer: 1,
    updateWhenIdle: true,
    updateWhenZooming: false,
    attribution: 'Maps © <a href="https://www.thunderforest.com/" target="_blank" rel="noopener">Thunderforest</a>',
  });
  layer.on('tileunload', ({ tile }) => {
    tile.discarded = true;
    tile.cancel?.();
    if (tile.objectUrl) URL.revokeObjectURL(tile.objectUrl);
  });
  return layer;
}
