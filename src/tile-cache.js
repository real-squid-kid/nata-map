const NAME = 'nata-map-tiles-v1';
const MAX_ENTRIES = 2000;
const MAX_MEMORY_ENTRIES = 128;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const memory = new Map();
const pending = new Map();
let storage;
let trimming = Promise.resolve();

function remember(key, blob, savedAt = Date.now()) {
  memory.delete(key); memory.set(key, { blob, savedAt });
  while (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
}
async function diskCache() {
  if (!storage) storage = (globalThis.caches ? caches.open(NAME) : Promise.resolve(null)).catch(() => null);
  return storage;
}
export async function getTileBlob({ style, coords, apiKey, onNetwork, onCache }) {
  // В локальном ключе нет API-ключа; смена ключа не сбрасывает сохранённую карту.
  const key = new URL(`/__nata_tiles/${encodeURIComponent(style)}/${coords.z}/${coords.x}/${coords.y}.png`, location.origin).href;
  if (memory.has(key)) {
    const { blob, savedAt } = memory.get(key);
    if (Date.now() - savedAt < MAX_AGE_MS) { remember(key, blob, savedAt); onCache(); return blob; }
    memory.delete(key);
  }
  if (pending.has(key)) { onCache(); return pending.get(key); }
  const readOrFetch = async () => {
    const cache = await diskCache();
    let cached;
    try { cached = await cache?.match(key); } catch { /* Ограниченная среда: остаётся кэш вкладки. */ }
    if (cached && Date.now() - Number(cached.headers.get('x-nata-saved-at')) < MAX_AGE_MS) {
      const blob = await cached.blob(); remember(key, blob, Number(cached.headers.get('x-nata-saved-at'))); onCache(); return blob;
    }
    onNetwork();
    const url = `https://api.thunderforest.com/${encodeURIComponent(style)}/${coords.z}/${coords.x}/${coords.y}.png?apikey=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'default' });
    if (!response.ok) throw new Error(`Подложка: HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error('Подложка: ответ не является изображением');
    const blob = await response.blob();
    remember(key, blob);
    if (cache) {
      try {
        await cache.put(key, new Response(blob, { headers: { 'content-type': blob.type, 'x-nata-saved-at': String(Date.now()) } }));
        trimming = trimming.catch(() => {}).then(async () => {
          const keys = await cache.keys();
          for (const request of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(request);
        }).catch(() => {});
      } catch { /* Диск заполнен/запрещён: повторные zoom всё равно используют memory. */ }
    }
    return blob;
  };
  // Вкладки одного origin тоже используют уже сохранённый ответ вместо второго запроса.
  const task = globalThis.navigator?.locks
    ? navigator.locks.request(`nata-tile:${key}`, readOrFetch) : readOrFetch();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
