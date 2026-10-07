<?php
declare(strict_types=1);

function readJsonFile(string $path, ?array $fallback = null): array
{
    if (!is_file($path)) {
        if ($fallback !== null) return $fallback;
        throw new RuntimeException('Отсутствует файл ' . basename($path));
    }
    $data = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($data)) throw new RuntimeException('Неверный JSON в ' . basename($path));
    return $data;
}

function writeJsonAtomic(string $path, array $data): void
{
    $temporary = tempnam(dirname($path), '.snapshot-');
    if ($temporary === false) throw new RuntimeException('Не удалось создать временный файл');
    try {
        $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        if (file_put_contents($temporary, $json) === false) throw new RuntimeException('Не удалось сохранить снимок');
        // Короткий повтор возможен при одновременном чтении файла на Windows.
        for ($attempt = 0; $attempt < 5; $attempt++) {
            if (@rename($temporary, $path)) return;
            usleep(20000);
        }
        throw new RuntimeException('Не удалось опубликовать снимок');
    } finally {
        if (is_file($temporary)) unlink($temporary);
    }
}

function isoNow(): string { return gmdate('Y-m-d\TH:i:s\Z'); }

function timestampOf(mixed $value): ?int
{
    if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/', $value)) return null;
    $timestamp = strtotime($value);
    return $timestamp === false ? null : $timestamp;
}

function mergeObservations(array $history, array $trains, array $station, string $seenAt, int $windowSeconds): array
{
    foreach ($trains as $train) {
        $departure = timestampOf($train['departureTime']);
        $runId = null;
        if ($train['trainNo'] !== null && is_bool($train['toMoscow']) && $departure !== null) {
            $runs = [];
            foreach ($history as $old) {
                if ($old['trainNo'] !== $train['trainNo'] || $old['toMoscow'] !== $train['toMoscow'] || !$old['runId']) continue;
                $oldTime = timestampOf($old['departureTime']);
                if ($oldTime === null) continue;
                $id = $old['runId'];
                $runs[$id]['minimum'] = min($runs[$id]['minimum'] ?? $oldTime, $oldTime);
                $runs[$id]['maximum'] = max($runs[$id]['maximum'] ?? $oldTime, $oldTime);
                $runs[$id]['distance'] = min($runs[$id]['distance'] ?? PHP_INT_MAX, abs($departure - $oldTime));
            }
            $candidates = array_filter($runs, static fn($run) => max($run['maximum'], $departure) - min($run['minimum'], $departure) <= $windowSeconds);
            uasort($candidates, static fn($a, $b) => $a['distance'] <=> $b['distance']);
            $runId = array_key_first($candidates);
            if ($runId === null) {
                $date = (new DateTimeImmutable('@' . $departure))->setTimezone(new DateTimeZone('Europe/Moscow'))->format('Y-m-d');
                $runId = $date . ':' . $train['trainNo'] . ':' . ($train['toMoscow'] ? 'to' : 'from') . ':' . $departure;
            }
        }
        // Записи без номера не объединяются между станциями.
        $id = $runId !== null ? $runId . ':' . $station['id']
            : $station['id'] . ':unplaced:' . hash('sha256', json_encode($train, JSON_THROW_ON_ERROR));
        $previous = $history[$id] ?? null;
        $history[$id] = array_merge($train, [
            'id' => $id, 'runId' => $runId, 'stationId' => $station['id'],
            'firstSeenAt' => $previous['firstSeenAt'] ?? $seenAt, 'lastSeenAt' => $seenAt,
        ]);
    }
    return $history;
}
