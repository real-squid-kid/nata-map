import L from 'leaflet';
import { createCorridor } from './corridor.js';
import { createMapTileLayer } from './map-tiles.js';
import { createTrackGeometry } from './geometry.js';
import { createTrainRenderer } from './train-renderer.js';

export function createSectionMap({ container, railway, stationsConfig, options, motion, apiKey, onSelectStation, onSelectTrain, onStats, onZoom }) {
  let night = false;
  const coordinates = railway.features[0].geometry.coordinates;
  const latLngs = coordinates.map(([longitude, latitude]) => [latitude, longitude]);
  const sectionBounds = L.latLngBounds(latLngs);
  const navigationBounds = sectionBounds.pad(options.navigationPadding);
  const diameterColor = options.diameterColors[stationsConfig.section.diameter];
  const track = createTrackGeometry(railway.features[0]);
  const map = L.map(container, {
    zoomControl: false,
    minZoom: options.minZoom,
    maxZoom: options.maxZoom,
    maxBounds: navigationBounds,
    maxBoundsViscosity: 1,
    scrollWheelZoom: true,
    attributionControl: true,
  });
  // Снизу вверх: размытая подложка z12 → подробности в коридоре → затемнение → линии → станции → поезда.
  map.createPane('tile-details').style.zIndex = 210;
  for (const [name, zIndex] of [['dimming', 250], ['routes', 350], ['stations', 450], ['trains', 550]]) {
    const pane = map.createPane(name);
    pane.style.zIndex = zIndex;
  }
  const shade = map.getPane('dimming');
  shade.style.background = `rgba(18, 23, 20, ${options.dimmingOpacity})`;
  shade.style.pointerEvents = 'none';
  function updateShade() {
    const size = map.getSize();
    shade.style.width = `${size.x}px`;
    shade.style.height = `${size.y}px`;
    L.DomUtil.setPosition(shade, map.containerPointToLayerPoint([0, 0]));
  }
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>');
  L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 100 }).addTo(map);

  // Leaflet откладывает добавление слоёв до установки вида. Сначала fitBounds,
  // чтобы у добавленных ниже маркеров сразу существовали DOM-элементы.
  const fitSection = () => map.fitBounds(sectionBounds, { padding: [40, 45], maxZoom: options.overviewMaxZoom, animate: false });
  function updateNavigationBounds(zoom = map.getZoom()) {
    // Ограничиваем центр карты, позволяя окну выходить за край участка.
    // Иначе maxBounds сдвигает крайние станции относительно центра окна.
    const halfSize = map.getSize().divideBy(2);
    map.setMaxBounds(L.latLngBounds(
      map.unproject(map.project(navigationBounds.getNorthWest(), zoom).subtract(halfSize), zoom),
      map.unproject(map.project(navigationBounds.getSouthEast(), zoom).add(halfSize), zoom),
    ));
  }
  map.on('zoomend', () => { updateNavigationBounds(); onZoom(map.getZoom()); });
  map.on('resize', () => updateNavigationBounds());
  fitSection();
  updateNavigationBounds();
  onZoom(map.getZoom());
  map.on('move resize viewreset', updateShade);
  updateShade();

  const corridor = createCorridor({
    coordinates,
    stationLocations: stationsConfig.stations.map((station) => [station.location.longitude, station.location.latitude]),
    bufferMeters: options.corridorBufferMeters,
  });
  const tileStats = [{}, {}];
  const reportTileStats = (index) => (stats) => {
    tileStats[index] = stats;
    const totals = {};
    for (const key of ['requested', 'cacheHits', 'pending', 'loaded', 'failed', 'withoutKey', 'blocked']) {
      totals[key] = (tileStats[0][key] || 0) + (tileStats[1][key] || 0);
    }
    onStats(totals);
  };
  const baseTiles = createMapTileLayer({
    apiKey, style: options.tileStyle,
    minZoom: options.minZoom, maxZoom: options.maxZoom,
    nativeMaxZoom: options.tileNativeMaxZoom, onStats: reportTileStats(0),
  });
  baseTiles.addTo(map);
  const detailTiles = createMapTileLayer({
    apiKey, style: options.tileStyle,
    minZoom: options.tileNativeMaxZoom + 1, maxZoom: options.maxZoom,
    corridor, pane: 'tile-details', onStats: reportTileStats(1),
  });
  detailTiles.addTo(map);
  function updateTileBlur() {
    const steps = Math.max(0, map.getZoom() - options.tileNativeMaxZoom);
    const radius = steps * options.tileBlurStepPx;
    baseTiles.getContainer().style.filter = radius ? `blur(${radius}px)` : '';
  }
  map.on('zoom', updateTileBlur);
  updateTileBlur();

  // Светлая обводка отделяет выбранную траекторию от железных дорог подложки.
  L.polyline(latLngs, { pane: 'routes', color: '#fffef6', weight: 8, opacity: 0.95, interactive: false }).addTo(map);
  L.polyline(latLngs, { pane: 'routes', color: diameterColor, weight: 4, opacity: 1, interactive: false }).addTo(map);

  const markers = new Map();
  for (const station of stationsConfig.stations) {
    const marker = L.marker([station.trackLocation.latitude, station.trackLocation.longitude], {
      title: station.name,
      pane: 'stations',
      keyboard: true,
      riseOnHover: true,
      icon: L.divIcon({
        className: 'station-marker',
        html: '<span class="station-pin"></span>',
        iconSize: [30, 30], iconAnchor: [15, 15],
      }),
    }).addTo(map);
    const label = document.createElement('span');
    label.textContent = station.name;
    marker.bindTooltip(label, { direction: 'top', offset: [0, -9], className: 'station-tooltip' });
    const element = marker.getElement();
    element.dataset.stationId = station.id;
    element.setAttribute('aria-label', station.name);
    element.setAttribute('aria-pressed', 'false');
    element.addEventListener('focus', () => marker.openTooltip());
    element.addEventListener('blur', () => marker.closeTooltip());
    element.addEventListener('keydown', (event) => {
      if (event.key === ' ') {
        event.preventDefault();
        onSelectStation(station);
      }
    });
    marker.on('click', () => onSelectStation(station));
    markers.set(station.id, marker);
  }

  const trains = createTrainRenderer({
    map, track, stations: stationsConfig.stations, motion, color: diameterColor,
    options: options.trainRendering, onSelect: onSelectTrain, isNight: () => night,
  });

  const observer = new ResizeObserver(() => {
    map.invalidateSize({ pan: true, animate: false });
  });
  observer.observe(container);

  return {
    fitSection,
    renderTrains: trains.render,
    setNight(enabled) {
      night = enabled;
      shade.style.background = `rgba(18, 23, 20, ${enabled ? options.nightDimmingOpacity : options.dimmingOpacity})`;
    },
    zoomIn: () => map.zoomIn(),
    zoomOut: () => map.zoomOut(),
    selectStation(station, { pan = true } = {}) {
      for (const [id, marker] of markers) {
        marker.getElement().classList.toggle('is-selected', id === station.id);
        marker.getElement().setAttribute('aria-pressed', String(id === station.id));
      }
      if (pan) {
        updateNavigationBounds(options.stationFocusZoom);
        map.setView(markers.get(station.id).getLatLng(), options.stationFocusZoom, { animate: false });
      }
    },
    destroy() {
      observer.disconnect();
      trains.destroy();
      map.remove();
    },
  };
}
