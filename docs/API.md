# API МЦД

Основа: неофициальное исследование пользователя от 2026-10-06. Оригинальный отдельный документ не присутствует в проекте; переданные сведения сохранены в архиве. Реальная выдача 4127/4128/4129 проверена PHP-сборщиком 2026-10-07: по 19–20 записей, оба направления, `needReload=false` при `build=84`. Это наблюдение, не гарантия неизменности контракта.

Base URL: `https://mcd.nata-info.ru`.

```http
GET /api/v2?station=4127&build=84
GET /api/v2?station=4128&build=84
GET /api/v2?station=4129&build=84
```

Сборщик запрашивает обе стороны без `direction`. Наблюдались `direction=1` → `toMoscow=false`, `direction=2` → `toMoscow=true`. Без фильтра в исследовании было 20 записей, с фильтром 10. `trains=10` не считать рабочим LIMIT. `/api/stations` для подготовленного участка в цикле не нужен. `skip`, `index`, `sos`, `pid` не нужны.

Минимальные поля ответа:

```typescript
interface StationResponse {
  stationId: number;
  stationName: string;
  trains: Train[];
  needReload?: boolean;
}
interface Train {
  trainNo: number | null;
  toMoscow: boolean;
  departureTime: string;
  scheduleTime: string;
  delaySeconds: number;
  trainLength: string;
  i18n: {
    ru: {
      destination: string;
      trainClass: { name: string; img?: string; abbr?: string; style?: string };
      stops: string;
    };
  };
}
```

- Время — абсолютные ISO datetime с часовым поясом; пример: `2026-10-06T15:12:30.000Z`. Вывод — Europe/Moscow; секунды не округлять.
- Для движения выбран `departureTime`. Отличие от `scheduleTime` при задержках пока не подтверждено. Не прибавлять `delaySeconds` повторно; отдельное arrival не обнаружено.
- `trainNo=null` возможен: запись в списке с причиной отсутствия маркера, без объединения между станциями.
- Типы `trainClass` и `trainLength` не считать закрытыми enum. Конечная — `i18n.ru.destination`; не брать `softBreakDestination` с мягкими переносами.
- `stops` показывать как текст, не извлекать из него остановки. Отсутствующее значение — «неизвестно».
- `build=84` — наблюдавшаяся версия клиента. `needReload=true` диагностировать; не перезагружать приложение в цикле.
- HTTP-ошибки, таймауты, неверный JSON и изменения схемы сохранять как ошибку последней попытки. Последние успешные поезда не стирать.
- Внутренние адреса оборудования, `from/to/ggs`, SOS не запрашивать и не публиковать. Строки API выводить как текст.
- PHP-сборщик делает upstream-запросы; браузер читает локальный снимок. Доступность API из текущей среды проверена, нормализуются только нужные поля.
- В живом примере №6420 `departureTime=18:15:30Z`, `scheduleTime=18:17:00Z`, `delaySeconds=-90`: departureTime уже отличается от плана на указанное значение. Для остальных записей наблюдалось и нулевое отклонение. Это поддерживает решение не прибавлять задержку повторно, но полного исследования семантики ещё нет.
