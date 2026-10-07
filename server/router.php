<?php
declare(strict_types=1);

// Подготовительный сервер: сборщик и выдача снимка будут добавлены после статичной карты.
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if ($path === '/api/health') {
    echo json_encode(['status' => 'ok'], JSON_UNESCAPED_UNICODE);
    return;
}

http_response_code(404);
echo json_encode(['error' => 'Маршрут не найден'], JSON_UNESCAPED_UNICODE);
