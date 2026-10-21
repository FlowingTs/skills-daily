export const MS_DAY = 86400000;
export const TZ = 'Asia/Shanghai';

/** 北京时间下的 YYYY-MM-DD */
export function bjToday(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function bjNowISO(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(d)
    .replace(' ', 'T');
}

/** 在 YYYY-MM-DD 上加减天数 */
export function addDays(dateStr, n) {
  const t = Date.parse(`${dateStr}T12:00:00Z`);
  return new Date(t + n * MS_DAY).toISOString().slice(0, 10);
}

export function diffDays(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / MS_DAY);
}

export function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 100000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`;
  return String(n);
}

export function fmtDelta(n) {
  if (n === null || n === undefined) return null;
  return n >= 0 ? `+${fmtNum(n)}` : `-${fmtNum(Math.abs(n))}`;
}

export function cnDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(...args) {
  console.log(`[${bjNowISO()}]`, ...args);
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
