const moscowHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23' });
const moscowDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });

export function automaticNight(now = Date.now()) {
  const hour = Number(moscowHour.format(now));
  return hour >= 19 || hour < 7;
}

export function themePeriod(now = Date.now()) {
  const nightStartedYesterday = Number(moscowHour.format(now)) < 7;
  const day = moscowDay.format(Number(now) - (nightStartedYesterday ? 86400000 : 0));
  return `${day}:${automaticNight(now) ? 'night' : 'day'}`;
}
