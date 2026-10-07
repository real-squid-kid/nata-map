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
$north = ['id' => 'north', 'apiToMoscowDirectionStep' => 1];
$south = ['id' => 'south', 'apiToMoscowDirectionStep' => -1];
$crossing = mergeObservations([], [$record], $north, isoNow(), 10800);
$crossing = mergeObservations($crossing, [array_merge($record, ['toMoscow' => false, 'departureTime' => '2026-10-08T01:00:30+03:00'])], $south, isoNow(), 10800);
check(count(array_unique(array_column($crossing, 'runId'))) === 1, 'Смена toMoscow через Курскую сохраняет рейс');
check(array_unique(array_column($crossing, 'travelDirection')) === [1], 'Направление вдоль геометрии устойчиво');
$crossing = mergeObservations($crossing, [array_merge($record, ['toMoscow' => true, 'departureTime' => '2026-10-08T01:00:30+03:00'])], $south, isoNow(), 10800);
check(count(array_unique(array_column($crossing, 'runId'))) === 2, 'Встречный рейс на юге не объединяется');
$repeated = mergeObservations([], [$record], $north, isoNow(), 10800);
$repeated = mergeObservations($repeated, [array_merge($record, ['departureTime' => '2026-10-08T01:00:30+03:00'])], $north, isoNow(), 10800);
check(count(array_unique(array_column($repeated, 'runId'))) === 2, 'Повтор номера на той же станции не склеивается в трёхчасовом окне');
$delayed = array_merge($record, ['scheduleTime' => $record['departureTime']]);
$same = mergeObservations([], [$delayed], $north, isoNow(), 10800);
$same = mergeObservations($same, [array_merge($delayed, ['departureTime' => '2026-10-08T01:00:30+03:00'])], $north, isoNow(), 10800);
check(count($same) === 1, 'Уточнение задержки сохраняет идентичность по плановому времени');
$d2 = readJsonFile(dirname(__DIR__) . '/config/stations.json');
$d2Stations = array_column($d2['stations'], null, 'id');
$destinationDirections = $d2['section']['destinationDirections'];
foreach (['Серпухов', 'Львовская', ' серпухов '] as $destination) {
    foreach ([true, false] as $toMoscow) {
        check(travelDirection(['destination' => $destination, 'toMoscow' => $toMoscow, 'travelDirection' => -1], $d2Stations['rizhskaya'], $d2['stations'], $destinationDirections) === 1,
            'Внешние южные конечные имеют приоритет над флагами источника');
    }
}
check(travelDirection(['destination' => 'Курский Вокзал', 'toMoscow' => false], $d2Stations['rizhskaya'], $d2['stations']) === 1, 'Алиас Курской задаёт юг от Рижской');
check(travelDirection(['destination' => 'Курский Вокзал', 'toMoscow' => false], $d2Stations['pererva'], $d2['stations']) === -1, 'Курская с южной стороны находится на севере');
foreach (['Подольск' => 1, 'Нахабино' => -1] as $destination => $expected) {
    foreach ([true, false] as $toMoscow) {
        foreach (['rizhskaya', 'dmitrovskaya', 'pererva', 'podolsk', 'nakhabino'] as $stationId) {
            check(travelDirection(['destination' => $destination, 'toMoscow' => $toMoscow, 'travelDirection' => -$expected], $d2Stations[$stationId], $d2['stations']) === $expected,
                'Конечная D2 определяет север/юг независимо от ошибочного флага и сохранённого направления');
        }
    }
}
$southbound = array_merge($record, ['trainNo' => '7392', 'destination' => 'Подольск', 'travelDirection' => 1]);
$wrongHistory = mergeObservations([], [$southbound], $d2Stations['dmitrovskaya'], '2026-10-07T23:58:00+03:00', 10800);
$wrongHistory = mergeObservations($wrongHistory, [array_merge($southbound, ['toMoscow' => false, 'travelDirection' => -1, 'departureTime' => '2026-10-08T00:06:30+03:00'])], $d2Stations['rizhskaya'], '2026-10-08T00:00:00+03:00', 10800);
check(count(array_unique(array_column($wrongHistory, 'runId'))) === 2, 'Воспроизведён дубль №7392 из ошибочного направления Рижской');
$repaired = rebuildObservationHistory(array_values($wrongHistory), $d2['stations'], 10800);
check(count($repaired) === 2 && count(array_unique(array_column($repaired, 'runId'))) === 1, 'Миграция объединяет оба якоря №7392 в один рейс');
check(array_unique(array_column($repaired, 'travelDirection')) === [1], '№7392 следует на юг');
check(array_column(array_values($repaired), 'departureTime') === array_column(array_values($wrongHistory), 'departureTime'), 'Миграция не сдвигает времена движения');
check(array_column(array_values($repaired), 'toMoscow') === [true, false], 'Исходные флаги сохраняются');
check(rebuildObservationHistory(array_values($repaired), $d2['stations'], 10800) === $repaired, 'Повторная миграция не меняет историю');
$serpukhovHistory = array_map(static fn($o) => array_merge($o, ['destination' => 'Серпухов']), $wrongHistory);
$serpukhovRepaired = rebuildObservationHistory(array_values($serpukhovHistory), $d2['stations'], 10800, $destinationDirections);
check(count(array_unique(array_column($serpukhovRepaired, 'runId'))) === 1 && array_unique(array_column($serpukhovRepaired, 'travelDirection')) === [1], 'Миграция объединяет ошибочный дубль поезда в Серпухов');
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
