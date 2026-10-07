<?php
declare(strict_types=1);

function fetchStation(int $stationId, array $options): array
{
    $url = $options['baseUrl'] . '/api/v2?' . http_build_query(['station' => $stationId, 'build' => $options['build']]);
    $timeout = (int) $options['requestTimeoutSeconds'];
    if (function_exists('curl_init')) {
        $handle = curl_init($url);
        curl_setopt_array($handle, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => $timeout,
            CURLOPT_USERAGENT => 'nata-map/0.1 local timetable collector', CURLOPT_HTTPHEADER => ['Accept: application/json']]);
        $body = curl_exec($handle);
        $status = curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $error = curl_error($handle);
        curl_close($handle);
        if ($body === false) throw new RuntimeException('Сетевая ошибка: ' . $error);
    } else {
        // PHP в локальной Windows-среде без curl/openssl. Системный curl.exe проверяет TLS через Schannel.
        $command = [PHP_OS_FAMILY === 'Windows' ? 'curl.exe' : 'curl', '--silent', '--show-error',
            '--connect-timeout', '10', '--max-time', (string) $timeout,
            '--user-agent', 'nata-map/0.1 local timetable collector', '--header', 'Accept: application/json',
            '--write-out', "\n%{http_code}", $url];
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, null, ['bypass_shell' => true]);
        if (!is_resource($process)) throw new RuntimeException('Не удалось запустить системный curl');
        fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]); fclose($pipes[1]);
        $error = trim((string) stream_get_contents($pipes[2])); fclose($pipes[2]);
        $exit = proc_close($process);
        if ($exit !== 0) throw new RuntimeException('Сетевая ошибка curl: ' . $error);
        $split = strrpos($output, "\n");
        $status = (int) substr($output, $split + 1);
        $body = substr($output, 0, $split);
    }
    if ($status !== 200) throw new RuntimeException('API вернул HTTP ' . $status);
    if (strlen($body) > 2 * 1024 * 1024) throw new RuntimeException('Ответ API слишком большой');
    $response = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    return normalizeStation($response, $stationId);
}

function normalizeStation(mixed $response, int $stationId): array
{
    if (!is_array($response) || !isset($response['trains']) || !is_array($response['trains'])
        || !array_is_list($response['trains']) || ($response['stationId'] ?? null) !== $stationId) {
        throw new RuntimeException('Неверная структура ответа станции');
    }
    $trains = [];
    $text = static fn($value) => is_string($value) ? $value : null;
    foreach ($response['trains'] as $train) {
        if (!is_array($train)) throw new RuntimeException('Неверная структура записи поезда');
        $ru = $train['i18n']['ru'] ?? [];
        $class = $ru['trainClass'] ?? [];
        $trains[] = [
            'trainNo' => is_int($train['trainNo'] ?? null) || is_string($train['trainNo'] ?? null) ? (string) $train['trainNo'] : null,
            'toMoscow' => is_bool($train['toMoscow'] ?? null) ? $train['toMoscow'] : null,
            'departureTime' => $text($train['departureTime'] ?? null),
            'scheduleTime' => $text($train['scheduleTime'] ?? null),
            'delaySeconds' => is_numeric($train['delaySeconds'] ?? null) ? (int) $train['delaySeconds'] : null,
            'trainLength' => $text($train['trainLength'] ?? null),
            'destination' => $text($ru['destination'] ?? null),
            'trainClass' => $text($class['name'] ?? null),
            'stops' => $text($ru['stops'] ?? null),
        ];
    }
    return ['trains' => $trains, 'needReload' => ($response['needReload'] ?? false) === true];
}
