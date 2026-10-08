import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const host = '127.0.0.1';
const apiUrl = `http://${host}:8080/api/health`;
const mapUrl = `http://${host}:5173`;

async function checkPort(port) {
  const server = createServer();
  try {
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen({ host, port, exclusive: true }, accept);
    });
  } catch {
    throw new Error(`Порт ${port} занят или недоступен. Остановите прежний сервис и повторите запуск.`);
  } finally {
    if (server.listening) await new Promise((accept) => server.close(accept));
  }
}

async function preflight(signal) {
  try {
    await access(resolve(root, 'node_modules/vite/bin/vite.js'));
  } catch {
    throw new Error('Не установлены зависимости. Выполните npm ci.');
  }
  try {
    await execute('php', ['-r', 'exit(PHP_VERSION_ID >= 80200 ? 0 : 1);'], {
      cwd: root, windowsHide: true, timeout: 5000, signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('Нужен PHP 8.2+ в PATH. Проверьте php --version.');
  }
  await Promise.all([checkPort(8080), checkPort(5173)]);
  const lockPath = resolve(root, 'var/collector.lock');
  try {
    await access(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  // Проверяем flock, а не записанный PID: файл остаётся после остановки сборщика.
  const checkLock = '$f = fopen($argv[1], "c+"); if ($f === false) exit(1); '
    + 'if (!flock($f, LOCK_EX | LOCK_NB)) exit(2); flock($f, LOCK_UN); fclose($f);';
  try {
    await execute('php', ['-r', checkLock, lockPath], {
      cwd: root, windowsHide: true, timeout: 5000, signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(error.code === 2
      ? 'Сборщик уже работает. Остановите прежний сборщик и повторите запуск.'
      : 'Не удалось проверить блокировку сборщика в var/collector.lock.');
  }
}

function launch(name, command, args, log) {
  const child = spawn(command, args, {
    cwd: root, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    const lines = createInterface({ input: stream });
    lines.on('line', (line) => log(`[${name}] ${line}`));
  }
  return child;
}

export async function waitForReady(url, signal, { health = false, timeoutMs = 15000, request = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await request(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(1000, timeoutMs))]),
      });
      if (health) {
        if (response.ok && (await response.json()).status === 'ok') return;
        await response.body?.cancel();
      } else {
        await response.body?.cancel();
        if (response.ok) return;
      }
    } catch {
      signal.throwIfAborted();
    }
    await delay(100, undefined, { signal });
  }
  throw new Error(`Сервис не ответил вовремя: ${url}`);
}

export async function stopProcessTree(child, { platform = process.platform, run = execute } = {}) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  // taskkill /T завершает также curl.exe сборщика; чужие node/php не затрагиваются.
  if (platform === 'win32') {
    try {
      await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error;
    }
    return;
  }
  const exited = once(child, 'exit');
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  await Promise.race([exited, delay(1000)]);
  // В группе могут остаться дочерние процессы даже после выхода родителя.
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export async function runDevelopment({
  check = preflight, start = launch, ready = waitForReady, stop = stopProcessTree,
  signals = process, log = console.log,
} = {}) {
  const controller = new AbortController();
  const { signal } = controller;
  const children = [];
  let exitCode = 0;
  const fail = (message) => {
    if (signal.aborted) return;
    exitCode = 1;
    log(`[запуск] ${message}`);
    controller.abort();
  };
  const cancel = () => {
    if (!signal.aborted) log('[запуск] Останавливаю сервисы…');
    controller.abort();
  };
  for (const event of ['SIGINT', 'SIGTERM']) signals.on(event, cancel);
  async function add(name, command, args) {
    signal.throwIfAborted();
    const child = start(name, command, args, log);
    children.push(child);
    child.on('error', (error) => fail(`${name}: ${error.message}`));
    child.on('exit', (code, reason) => fail(`${name} завершился (${reason || `код ${code}`}). Останавливаю остальные сервисы.`));
    await once(child, 'spawn', { signal });
  }
  try {
    log('[запуск] Проверяю окружение, порты и блокировку сборщика…');
    await check(signal);
    await add('API', 'php', ['-S', `${host}:8080`, '-t', 'server', 'server/router.php']);
    await ready(apiUrl, signal, { health: true });
    await add('фронт', process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js')]);
    await ready(mapUrl, signal);
    // Не начинаем опрос внешнего API, пока оба локальных сервиса не готовы.
    await add('сборщик', 'php', ['server/collector.php']);
    signal.throwIfAborted();
    log(`[запуск] Карта: ${mapUrl}. Сборщик запущен; первое расписание может появиться не сразу. Остановка: Ctrl+C.`);
    if (!signal.aborted) await new Promise((accept) => signal.addEventListener('abort', accept, { once: true }));
  } catch (error) {
    if (!signal.aborted) fail(error.message);
  } finally {
    controller.abort();
    const results = await Promise.allSettled(children.reverse().map((child) => stop(child)));
    for (const result of results) {
      if (result.status === 'rejected') {
        exitCode = 1;
        log(`[запуск] Ошибка остановки процесса: ${result.reason.message}`);
      }
    }
    for (const event of ['SIGINT', 'SIGTERM']) signals.removeListener(event, cancel);
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDevelopment();
}
