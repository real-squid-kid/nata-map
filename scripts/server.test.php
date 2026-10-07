<?php
declare(strict_types=1);
require dirname(__DIR__) . '/server/store.php';
require dirname(__DIR__) . '/server/adapter.php';

function check(bool $value, string $message): void { if (!$value) throw new RuntimeException($message); }
$stationA = ['id' => 'a']; $stationB = ['id' => 'b'];
$record = ['trainNo' => '6420', 'toMoscow' => true, 'departureTime' => '2026-10-07T23:59:30+03:00'];
$history = mergeObservations([], [$record], $stationA, '2026-10-07T23:58:00+03:00', 1800);
$recordB = array_merge($record, ['departureTime' => '2026-10-08T00:01:30+03:00']);
$history = mergeObservations($history, [$recordB], $stationB, '2026-10-08T00:00:00+03:00', 1800);
check(count($history) === 2, 'Две станции одного рейса');
check(count(array_unique(array_column($history, 'runId'))) === 1, 'Рейс через полночь не дублируется');
$oldId = array_key_first($history);
$history = mergeObservations($history, [array_merge($record, ['departureTime' => '2026-10-08T00:00:30+03:00'])], $stationA, '2026-10-07T23:59:00+03:00', 1800);
check(count($history) === 2 && isset($history[$oldId]), 'Уточнение времени заменяет якорь');
$history = mergeObservations($history, [], $stationA, '2026-10-08T00:03:00+03:00', 1800);
check(count($history) === 2, 'Исчезновение из табло не удаляет историю');
$history = mergeObservations($history, [array_merge($record, ['departureTime' => '2026-10-08T23:59:30+03:00'])], $stationA, '2026-10-08T23:58:00+03:00', 1800);
check(count(array_unique(array_column($history, 'runId'))) === 2, 'Повтор номера на следующие сутки — новый рейс');
$missing = array_merge($record, ['trainNo' => null]);
$history = mergeObservations($history, [$missing], $stationA, isoNow(), 1800);
$history = mergeObservations($history, [$missing], $stationB, isoNow(), 1800);
check(count(array_filter($history, static fn($o) => $o['runId'] === null)) === 2, 'Без номера нет объединения станций');
check(timestampOf('2026-10-07T12:34:30') === null, 'Часовой пояс обязателен');
$normalized = normalizeStation(['stationId' => 4127, 'trains' => [[
    'trainNo' => null, 'toMoscow' => true, 'departureTime' => 'bad', 'equipment' => 'private',
    'i18n' => ['ru' => ['destination' => '<b>Текст</b>', 'trainClass' => ['name' => 'Новый тип'], 'stops' => 'Исходный текст']],
]], 'from' => 'private'], 4127);
check(!isset($normalized['trains'][0]['equipment']) && !isset($normalized['from']), 'Служебные поля не публикуются');
check($normalized['trains'][0]['trainNo'] === null, 'Отсутствующие данные не выдумываются');
check($normalized['trains'][0]['destination'] === '<b>Текст</b>', 'Строки сохраняются как текст');
try { normalizeStation(['stationId' => 4128, 'trains' => []], 4127); throw new LogicException('Ожидалась ошибка схемы'); }
catch (RuntimeException $error) {}
$temp = tempnam(sys_get_temp_dir(), 'nata-map-test-');
try {
    writeJsonAtomic($temp, ['version' => 1]); writeJsonAtomic($temp, ['version' => 2]);
    check(readJsonFile($temp)['version'] === 2, 'Атомарная замена снимка работает на текущей ОС');
} finally { unlink($temp); }
echo "PHP: нормализация, история, полночь, повтор номера и атомарная публикация проверены.\n";
