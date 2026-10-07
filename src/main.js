import './styles.css';
import stationsConfig from '../config/stations.json';

const app = document.querySelector('#app');
const panel = document.createElement('section');
panel.className = 'instrument-panel p-6 sm:p-8';

const heading = document.createElement('h1');
heading.className = 'text-xl font-semibold';
heading.textContent = 'nata-map';

const section = document.createElement('p');
section.className = 'mt-2 text-sm text-stone-600';
section.textContent = 'Стрешнево — Марьина Роща';

const stations = document.createElement('ol');
stations.className = 'inset-surface mt-6 space-y-3 p-5';
for (const station of stationsConfig.stations) {
  const item = document.createElement('li');
  item.className = 'text-sm';
  item.textContent = station.name;
  stations.append(item);
}

const status = document.createElement('p');
status.className = 'mt-5 text-sm text-stone-600';
status.textContent = 'Карта ещё не подключена.';
panel.append(heading, section, stations, status);
app.append(panel);
