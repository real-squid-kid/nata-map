export function startSnapshotPolling({ intervalMs, onSnapshot, onError }) {
  let stopped = false;
  let timer;
  let controller;
  async function poll() {
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch('/api/state', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Локальный сервер: HTTP ${response.status}`);
      const snapshot = await response.json();
      if (snapshot.schemaVersion !== 1 || !snapshot.stations || !Array.isArray(snapshot.observations)) {
        throw new Error('Неверный формат локального снимка');
      }
      if (!stopped) onSnapshot(snapshot);
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      clearTimeout(timeout);
      if (!stopped) timer = setTimeout(poll, intervalMs);
    }
  }
  poll();
  return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
}
