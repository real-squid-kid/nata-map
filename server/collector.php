<?php
declare(strict_types=1);
require __DIR__ . '/store.php';
require __DIR__ . '/adapter.php';

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$root = dirname(__DIR__);
$options = readJsonFile($root . '/config/app.json')['collector'];
$config = readJsonFile($root . '/config/stations.json');
$directory = $root . '/var';
if (!is_dir($directory)) mkdir($directory, 0775, true);
$lock = fopen($directory . '/collector.lock', 'c+');
if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, "Сборщик уже запущен.\n"); exit(2);
}
ftruncate($lock, 0); fwrite($lock, (string) getmypid()); fflush($lock);
$statePath = $directory . '/state.json';
$state = readJsonFile($statePath, ['schemaVersion' => 1, 'stations' => [], 'observations' => [], 'collector' => []]);
$history = [];
foreach ($state['observations'] as $observation) $history[$observation['id']] = $observation;
$once = in_array('--once', $argv, true);

function publishState(string $path, array &$state, array $history): void
{
    $state['publishedAt'] = isoNow();
    $state['observations'] = array_values($history);
    writeJsonAtomic($path, $state);
}

// Сохраняем межзапросный интервал и паузу цикла даже при быстром перезапуске процесса.
$nextCycle = timestampOf($state['collector']['nextCycleAt'] ?? null) ?? 0;
while (true) {
    $wait = $nextCycle - time();
    if ($wait > 0) { sleep(min($wait, 5)); continue; }
    $state['collector']['status'] = 'collecting';
    $state['collector']['cycleStartedAt'] = isoNow();
    foreach ($config['pollStationApiIds'] as $apiId) {
        $station = array_values(array_filter($config['stations'], static fn($s) => $s['apiStationId'] === $apiId))[0];
        $lastStart = (float) ($state['collector']['lastRequestStartedUnix'] ?? 0);
        $remaining = max(0, $options['minRequestIntervalMs'] / 1000 - (microtime(true) - $lastStart));
        if ($remaining > 0) usleep((int) ceil($remaining * 1000000));
        $state['collector']['lastRequestStartedUnix'] = microtime(true);
        $seenAt = isoNow();
        $old = $state['stations'][$station['id']] ?? ['trains' => [], 'lastSuccessfulAt' => null];
        $snapshot = array_merge($old, ['stationId' => $station['id'], 'apiStationId' => $apiId, 'fetchedAt' => $seenAt]);
        publishState($statePath, $state, $history);
        try {
            $result = fetchStation($apiId, $options);
            $snapshot = array_merge($snapshot, $result, ['lastSuccessfulAt' => isoNow(), 'error' => null]);
            $history = mergeObservations($history, $result['trains'], $station, $seenAt, $options['tripMatchWindowSeconds']);
            echo $seenAt . ' ' . $station['name'] . ': ' . count($result['trains']) . ' поездов' . ($result['needReload'] ? ' (needReload)' : '') . "\n";
        } catch (Throwable $error) {
            $snapshot['error'] = $error->getMessage();
            fwrite(STDERR, $seenAt . ' ' . $station['name'] . ': ' . $snapshot['error'] . "\n");
        }
        $state['stations'][$station['id']] = $snapshot;
        publishState($statePath, $state, $history);
    }
    $cutoff = time() - $options['historyRetentionHours'] * 3600;
    $history = array_filter($history, static fn($o) => (timestampOf($o['departureTime']) ?? timestampOf($o['lastSeenAt']) ?? 0) >= $cutoff);
    $state['collector']['status'] = 'waiting';
    $state['collector']['cycleCompletedAt'] = isoNow();
    $nextCycle = time() + $options['cyclePauseSeconds'];
    $state['collector']['nextCycleAt'] = gmdate('Y-m-d\TH:i:s\Z', $nextCycle);
    publishState($statePath, $state, $history);
    writeJsonAtomic($directory . '/observations.json', ['schemaVersion' => 1, 'observations' => array_values($history)]);
    if ($once) break;
}
flock($lock, LOCK_UN); fclose($lock);
