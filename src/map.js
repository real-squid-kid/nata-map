import L from 'leaflet';
import { createCorridor } from './corridor.js';
import { createCorridorTileLayer } from './corridor-tiles.js';
import { createTrackGeometry } from './geometry.js';
import { getTrainPosition } from './motion.js';

export function createSectionMap({ container, railway, stationsConfig, options, motion, apiKey, onSelectStation, onSelectTrain, onStats, onZoom }) {
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
  // Снизу вверх: тайлы → затемнение → линии → станции → поезда.
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
  map.on('zoomend', () => onZoom(map.getZoom()));
  fitSection();
  onZoom(map.getZoom());
  map.on('move resize viewreset', updateShade);
  updateShade();

  const corridor = createCorridor({
    coordinates,
    stationLocations: stationsConfig.stations.map((station) => [station.location.longitude, station.location.latitude]),
    bufferMeters: options.corridorBufferMeters,
  });
  const tiles = createCorridorTileLayer({
    corridor, apiKey, style: options.tileStyle,
    minZoom: options.minZoom, maxZoom: options.maxZoom, onStats,
  });
  tiles.addTo(map);

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

  const trainLayers = new Map();
  function createTrain(trip) {
    const body = L.polyline([], { pane: 'trains', color: diameterColor, weight: 8, lineCap: 'round', interactive: false });
    const head = L.circleMarker([0, 0], { pane: 'trains', radius: 3, stroke: false, fillColor: '#fff', fillOpacity: 1, interactive: false, className: 'train-head' });
    const tail = L.circleMarker([0, 0], { pane: 'trains', radius: 3, stroke: false, fillColor: '#f33237', fillOpacity: 1, interactive: false, className: 'train-tail' });
    const hit = L.polyline([], { pane: 'trains', color: '#000', weight: 20, opacity: 0, className: 'train-hit' });
    const group = L.layerGroup([body, head, tail, hit]).addTo(map);
    const label = document.createElement('span');
    label.textContent = `№ ${trip.trainNo} · ${trip.destination || 'Конечная неизвестна'}`;
    hit.bindTooltip(label, { direction: 'top', className: 'station-tooltip' });
    const entry = { trip, group, body, head, tail, hit, label };
    hit.on('click', () => onSelectTrain(entry.trip));
    const element = hit.getElement();
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', label.textContent);
    element.dataset.trainId = trip.id;
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectTrain(entry.trip); }
    });
    element.addEventListener('focus', () => hit.openTooltip());
    element.addEventListener('blur', () => hit.closeTooltip());
    return entry;
  }

  function renderTrains(trips, now) {
    const visibleIds = new Set();
    for (const trip of trips) {
      const position = getTrainPosition(trip, now, stationsConfig.stations, motion, track.length);
      if (!position.visible) continue;
      visibleIds.add(trip.id);
      let entry = trainLayers.get(trip.id);
      if (!entry) { entry = createTrain(trip); trainLayers.set(trip.id, entry); }
      entry.trip = trip;
      const s = position.centerMeters;
      const halfLength = motion.trainLengthMeters / 2;
      const points = track.slice(s - halfLength, s + halfLength);
      entry.body.setLatLngs(points);
      entry.hit.setLatLngs(points);
      const headS = s + trip.direction * halfLength;
      const tailS = s - trip.direction * halfLength;
      entry.head.setLatLng(track.pointAt(headS)).setStyle({ fillOpacity: headS >= 0 && headS <= track.length ? 1 : 0 });
      entry.tail.setLatLng(track.pointAt(tailS)).setStyle({ fillOpacity: tailS >= 0 && tailS <= track.length ? 1 : 0 });
      const label = `№ ${trip.trainNo} · ${trip.destination || 'Конечная неизвестна'}`;
      if (entry.label.textContent !== label) {
        entry.label.textContent = label;
        entry.hit.getElement().setAttribute('aria-label', label);
      }
    }
    for (const [id, entry] of trainLayers) {
      if (!visibleIds.has(id)) { entry.group.remove(); trainLayers.delete(id); }
    }
    return visibleIds.size;
  }

  const observer = new ResizeObserver(() => {
    map.invalidateSize({ pan: false });
  });
  observer.observe(container);

  return {
    fitSection,
    renderTrains,
    zoomIn: () => map.zoomIn(),
    zoomOut: () => map.zoomOut(),
    selectStation(station, { pan = true } = {}) {
      for (const [id, marker] of markers) {
        marker.getElement().classList.toggle('is-selected', id === station.id);
        marker.getElement().setAttribute('aria-pressed', String(id === station.id));
      }
      if (pan) map.panTo(markers.get(station.id).getLatLng(), { animate: false });
    },
    destroy() {
      observer.disconnect();
      map.remove();
    },
  };
}
