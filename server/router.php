<?php
declare(strict_types=1);

require __DIR__ . '/store.php';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if ($path === '/api/health') {
    echo json_encode(['status' => 'ok'], JSON_UNESCAPED_UNICODE);
    return;
}

if ($path === '/api/state') {
    try {
        $state = readJsonFile(dirname(__DIR__) . '/var/state.json', [
            'schemaVersion' => 1, 'publishedAt' => null, 'stations' => new stdClass(),
            'observations' => [], 'collector' => ['status' => 'not-started'],
        ]);
        // Отдаём только нормализованный снимок. var/, исходники PHP и .env не публикуются.
        echo json_encode($state, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        http_response_code(503);
        echo json_encode(['error' => 'Снимок расписания временно недоступен'], JSON_UNESCAPED_UNICODE);
    }
    return;
}

http_response_code(404);
echo json_encode(['error' => 'Маршрут не найден'], JSON_UNESCAPED_UNICODE);
