import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runDevelopment, stopProcessTree, waitForReady } from './dev.mjs';

// Подменяем процессы и HTTP: тесты не запускают сервисы и не опрашивают расписание.
function harness(overrides = {}) {
  const signals = new EventEmitter();
  const children = [];
  const stopped = [];
  const messages = [];
  const order = [];
  return {
    children, stopped, messages, order, signals,
    options: {
      signals,
      check: async () => { order.push('проверки'); },
      start: (name, command, args) => {
        order.push(`старт:${name}`);
        const child = Object.assign(new EventEmitter(), {
          name, command, args, pid: children.length + 100, exitCode: null, signalCode: null,
        });
        children.push(child);
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      ready: async (url) => { order.push(`готов:${new URL(url).port}`); },
      stop: async (child) => {
        stopped.push(child.name);
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
      },
      log: (message) => {
        messages.push(message);
        if (message.includes('Карта:')) signals.emit('SIGINT');
      },
      ...overrides,
    },
  };
}

test('единый запуск ждёт готовности API и фронта до сборщика; Ctrl+C завершает всех детей', async () => {
  const h = harness();
  assert.equal(await runDevelopment(h.options), 0);
  assert.deepEqual(h.order, ['проверки', 'старт:API', 'готов:8080', 'старт:фронт', 'готов:5173', 'старт:сборщик']);
  assert.deepEqual(h.stopped, ['сборщик', 'фронт', 'API']);
  assert.equal(h.children[0].command, 'php');
  assert.equal(h.children[2].command, 'php');
  assert.equal(h.children[1].command, process.execPath);
  assert.equal(h.signals.listenerCount('SIGINT'), 0);
  assert.equal(h.signals.listenerCount('SIGTERM'), 0);
});

test('занятый порт или блокировка сборщика не допускают частичного запуска', async () => {
  for (const message of ['Порт 8080 занят.', 'Сборщик уже работает.']) {
    const h = harness({ check: async () => { throw new Error(message); } });
    assert.equal(await runDevelopment(h.options), 1);
    assert.equal(h.children.length, 0);
    assert.ok(h.messages.includes(`[запуск] ${message}`));
  }
});

test('неготовый фронт останавливает PHP и Vite, не запуская сборщик', async () => {
  const h = harness({ ready: async (url) => {
    if (new URL(url).port === '5173') throw new Error('Фронт не ответил вовремя.');
  } });
  assert.equal(await runDevelopment(h.options), 1);
  assert.deepEqual(h.children.map((child) => child.name), ['API', 'фронт']);
  assert.deepEqual(h.stopped, ['фронт', 'API']);
});

test('выход второго сборщика с кодом 2 останавливает сервисы без перезапуска сборщика', async () => {
  const h = harness();
  h.options.log = (message) => {
    h.messages.push(message);
    if (message.includes('Карта:')) {
      const child = h.children.find((item) => item.name === 'сборщик');
      child.exitCode = 2;
      child.emit('exit', 2, null);
    }
  };
  assert.equal(await runDevelopment(h.options), 1);
  assert.deepEqual(h.stopped, ['сборщик', 'фронт', 'API']);
  assert.equal(h.children.length, 3);
  assert.ok(h.messages.some((message) => message.includes('код 2')));
});

test('Ctrl+C во время ожидания API не оставляет PHP и не запускает остальные сервисы', async () => {
  const h = harness();
  h.options.ready = async (_url, signal) => {
    h.signals.emit('SIGINT');
    signal.throwIfAborted();
  };
  assert.equal(await runDevelopment(h.options), 0);
  assert.deepEqual(h.stopped, ['API']);
});

test('Windows завершает дерево конкретного PID, но не трогает уже завершившийся процесс', async () => {
  const calls = [];
  const child = { pid: 1234, exitCode: null, signalCode: null };
  const options = { platform: 'win32', run: async (...args) => { calls.push(args); } };
  await stopProcessTree(child, options);
  assert.equal(calls[0][0], 'taskkill');
  assert.deepEqual(calls[0][1], ['/PID', '1234', '/T', '/F']);
  assert.equal(calls[0][2].windowsHide, true);
  child.exitCode = 0;
  await stopProcessTree(child, options);
  assert.equal(calls.length, 1);
});

test('готовность API требует status=ok, а не просто HTTP 200', async () => {
  const responses = [{ status: 'не готов' }, { status: 'ok' }];
  let requests = 0;
  await waitForReady('http://local.test/api/health', new AbortController().signal, {
    health: true, request: async () => {
      requests++;
      return new Response(JSON.stringify(responses.shift()));
    },
  });
  assert.equal(requests, 2);
});

test('отмена ожидания не посылает новый HTTP-запрос', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForReady('http://local.test', controller.signal, {
    request: async () => { assert.fail('Запрос после отмены'); },
  }), { name: 'AbortError' });
});
