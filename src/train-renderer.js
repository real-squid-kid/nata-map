import L from 'leaflet';
import { getTrainLayout } from './train-layout.js';
import { getTrainPosition } from './motion.js';
import { getCloseTrainIds } from './train-proximity.js';

const NS = 'http://www.w3.org/2000/svg';
const proximityMessage = 'Поезда подозрительно близко. Возможно, они идут по разным путям.';
const svgElement = (name, attributes = {}) => {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};
const pathData = (points) => points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');

export function createTrainRenderer({ map, track, stations, motion, color, options, onSelect, isNight }) {
  const root = svgElement('svg', { class: 'train-renderer leaflet-zoom-hide', width: 1, height: 1 });
  const prefix = `train-sprite-${L.Util.stamp(map)}`;
  const defs = svgElement('defs');
  const colors = { head: '#ffffff', middle: color, tail: '#fa343e' };
  for (const [role, fill] of Object.entries(colors)) {
    const symbol = svgElement('symbol', { id: `${prefix}-${role}`, viewBox: '0 0 100 28', preserveAspectRatio: 'none' });
    symbol.append(svgElement('rect', { x: 1, y: 2, width: 98, height: 24, rx: 7, fill, stroke: '#25333f', 'stroke-width': 1.1, 'vector-effect': 'non-scaling-stroke' }));
    symbol.append(svgElement('rect', { x: 12, y: 8, width: 66, height: 12, rx: 3, fill: role === 'head' ? '#dce5ec' : '#fff', opacity: role === 'head' ? 1 : 0.24 }));
    for (const y of [4, 21]) {
      for (const x of [18, 39, 60]) symbol.append(svgElement('rect', { x, y, width: 13, height: 3, rx: 1, fill: '#213844', opacity: 0.85 }));
    }
    if (role === 'head') symbol.append(svgElement('rect', { x: 83, y: 7, width: 8, height: 14, rx: 2, fill: '#243d4b' }));
    if (role === 'tail') symbol.append(svgElement('rect', { x: 6, y: 7, width: 6, height: 14, rx: 2, fill: '#8e1423' }));
    defs.append(symbol);
  }
  root.append(defs);
  const warnings = svgElement('g', { class: 'train-warnings' });
  root.append(warnings);
  map.getPane('trains').append(root);
  // Viewport SVG совпадает с окном карты, а viewBox — с координатами Leaflet.
  function updateViewport() {
    const size = map.getSize();
    const origin = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(root, origin);
    root.setAttribute('width', size.x);
    root.setAttribute('height', size.y);
    root.setAttribute('viewBox', `${origin.x} ${origin.y} ${size.x} ${size.y}`);
  }
  map.on('move resize viewreset', updateViewport);
  updateViewport();
  const entries = new Map();
  const project = (latLng) => map.project(latLng, map.getZoom()).subtract(map.getPixelOrigin());
  let tooltip = null;
  let tooltipOwner = null;
  let tooltipKind = null;
  const closeTooltip = () => {
    const element = tooltip?.getElement();
    tooltip?.remove();
    // Leaflet откладывает удаление на время fade: старое пояснение не должно накладываться на новое.
    element?.remove();
    tooltip = null; tooltipOwner = null; tooltipKind = null;
  };
  map.on('click', closeTooltip);

  function createTrain(trip) {
    const group = svgElement('g', { class: 'train-visual', tabindex: 0, role: 'button', 'data-train-id': trip.id });
    const capsule = svgElement('g', { class: 'train-capsule' });
    const outline = svgElement('path', { class: 'train-outline', fill: 'none', stroke: '#fffdf6', 'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    const body = svgElement('path', { class: 'train-body', fill: 'none', stroke: color, 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    const head = svgElement('circle', { r: 3, fill: '#fff', class: 'train-head' });
    const tail = svgElement('circle', { r: 3, fill: '#fa343e', class: 'train-tail' });
    const arrow = svgElement('path', { class: 'train-direction-arrow', d: 'M-4 -5 L4 0 L-4 5 L-1 0 Z', fill: '#fffdf6', stroke: '#25333f', 'stroke-width': 1.2, 'stroke-linejoin': 'round' });
    capsule.append(outline, body, head, tail, arrow);
    const wagons = svgElement('g', { class: 'train-wagons' });
    const sprites = [];
    for (let index = 0; index < options.wagonCount; index++) {
      const role = index === 0 ? 'head' : index === options.wagonCount - 1 ? 'tail' : 'middle';
      const wagon = svgElement('g', { class: `train-wagon train-wagon-${role}`, 'data-wagon-role': role });
      const sprite = svgElement('use', { href: `#${prefix}-${role}` });
      wagon.append(sprite); wagons.append(wagon); sprites.push({ wagon, sprite });
    }
    const hit = svgElement('path', { class: 'train-hit', stroke: 'transparent', 'stroke-width': options.wagonWidthPx + 4, fill: 'none', 'stroke-linecap': 'round' });
    group.append(capsule, wagons, hit); root.insertBefore(group, warnings);
    const warning = svgElement('g', { class: 'train-proximity-warning', tabindex: 0, role: 'button', 'aria-label': proximityMessage, 'data-train-id': trip.id });
    warning.style.display = 'none';
    warning.append(svgElement('circle', { r: 10 }));
    const question = svgElement('text', { x: 0, y: 0, 'text-anchor': 'middle', dy: '.35em', 'aria-hidden': 'true' });
    question.textContent = '?'; warning.append(question); warnings.append(warning);
    const entry = { group, capsule, outline, body, head, tail, arrow, wagons, sprites, hit, warning, trip, layout: null, warningPoint: null };
    const openTooltip = () => {
      closeTooltip();
      tooltipOwner = entry;
      tooltipKind = 'train';
      const label = document.createElement('span');
      label.textContent = `№ ${entry.trip.trainNo} · ${entry.trip.destination || 'Конечная неизвестна'}`;
      tooltip = L.tooltip({ direction: 'top', className: 'station-tooltip', offset: [0, -8] })
        .setLatLng(map.layerPointToLatLng(L.point(entry.layout.center.x, entry.layout.center.y))).setContent(label).addTo(map);
    };
    group.addEventListener('mouseenter', openTooltip);
    group.addEventListener('focus', openTooltip);
    group.addEventListener('mouseleave', closeTooltip);
    group.addEventListener('blur', closeTooltip);
    group.addEventListener('click', (event) => { event.stopPropagation(); onSelect(entry.trip); });
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelect(entry.trip); }
    });
    L.DomEvent.disableClickPropagation(group);
    const openWarning = (event) => {
      event?.stopPropagation();
      if (tooltipOwner === entry && tooltipKind === 'warning') return;
      closeTooltip(); tooltipOwner = entry; tooltipKind = 'warning';
      const label = document.createElement('span'); label.textContent = proximityMessage;
      tooltip = L.tooltip({ direction: 'top', className: 'station-tooltip train-proximity-tooltip', offset: [0, -12] })
        .setLatLng(map.layerPointToLatLng(L.point(entry.warningPoint.x, entry.warningPoint.y))).setContent(label).addTo(map);
    };
    warning.addEventListener('mouseenter', openWarning);
    warning.addEventListener('focus', openWarning);
    warning.addEventListener('click', openWarning);
    warning.addEventListener('mouseleave', closeTooltip);
    warning.addEventListener('blur', closeTooltip);
    warning.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openWarning(event); }
      if (event.key === 'Escape') closeTooltip();
    });
    L.DomEvent.disableClickPropagation(warning);
    return entry;
  }

  function render(trips, now) {
    const visible = new Set();
    const positioned = trips.map((trip) => ({ trip, position: getTrainPosition(trip, now, stations, motion, track.length) }))
      .filter(({ position }) => position.visible);
    const close = getCloseTrainIds(positioned.map(({ trip, position }) => ({ id: trip.id, direction: trip.direction, centerMeters: position.centerMeters })));
    const warningPoints = [];
    for (const { trip, position } of positioned) {
      visible.add(trip.id);
      let entry = entries.get(trip.id);
      if (!entry) { entry = createTrain(trip); entries.set(trip.id, entry); }
      entry.trip = trip;
      entry.group.setAttribute('opacity', position.opacity);
      const layout = getTrainLayout({ track, project, centerMeters: position.centerMeters, direction: trip.direction,
        trainLengthMeters: motion.trainLengthMeters, options, zoom: map.getZoom(), night: isNight() });
      entry.layout = layout;
      entry.warning.style.display = close.has(trip.id) ? '' : 'none';
      if (close.has(trip.id)) {
        const point = { x: layout.center.x, y: layout.center.y - 25 };
        // Совпавшие составы сохраняют отдельные доступные знаки вопроса.
        while (warningPoints.some((other) => Math.abs(other.x - point.x) < 24 && Math.abs(other.y - point.y) < 24)) point.y -= 24;
        warningPoints.push(point); entry.warningPoint = point;
        entry.warning.setAttribute('transform', `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`);
      } else if (tooltipOwner === entry && tooltipKind === 'warning') closeTooltip();
      if (tooltipOwner === entry) {
        const point = tooltipKind === 'warning' ? entry.warningPoint : layout.center;
        tooltip.setLatLng(map.layerPointToLatLng(L.point(point.x, point.y)));
      }
      entry.group.dataset.renderMode = layout.mode;
      entry.group.dataset.direction = trip.direction;
      entry.group.setAttribute('aria-label', `Поезд № ${trip.trainNo} · ${trip.destination || 'Конечная неизвестна'}`);
      const path = pathData(layout.points);
      entry.hit.setAttribute('d', path);
      entry.capsule.style.display = layout.mode === 'capsule' ? '' : 'none';
      entry.wagons.style.display = layout.mode === 'wagons' ? '' : 'none';
      if (layout.mode === 'capsule') {
        entry.outline.setAttribute('d', path); entry.body.setAttribute('d', path);
        entry.arrow.style.display = layout.arrow ? '' : 'none';
        if (layout.arrow) entry.arrow.setAttribute('transform', `translate(${layout.arrow.x.toFixed(2)} ${layout.arrow.y.toFixed(2)}) rotate(${layout.arrow.angle.toFixed(2)})`);
        for (const role of ['head', 'tail']) {
          entry[role].style.display = layout[role] ? '' : 'none';
          if (layout[role]) { entry[role].setAttribute('cx', layout[role].x); entry[role].setAttribute('cy', layout[role].y); }
        }
      } else {
        for (const { wagon } of entry.sprites) wagon.style.display = 'none';
        for (const wagon of layout.wagons) {
          const target = entry.sprites[wagon.index];
          target.wagon.style.display = '';
          target.wagon.setAttribute('transform', `translate(${wagon.x.toFixed(2)} ${wagon.y.toFixed(2)}) rotate(${wagon.angle.toFixed(2)})`);
          target.sprite.setAttribute('x', -wagon.length / 2); target.sprite.setAttribute('y', -wagon.width / 2);
          target.sprite.setAttribute('width', wagon.length); target.sprite.setAttribute('height', wagon.width);
        }
      }
    }
    for (const [id, entry] of entries) {
      if (!visible.has(id)) {
        if (tooltipOwner === entry) closeTooltip();
        entry.group.remove(); entry.warning.remove(); entries.delete(id);
      }
    }
    return visible.size;
  }
  return { render, destroy() { map.off('move resize viewreset', updateViewport); map.off('click', closeTooltip); closeTooltip(); root.remove(); entries.clear(); } };
}
