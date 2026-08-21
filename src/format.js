const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s));

export const dim = c('2');
export const bold = c('1');
export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const cyan = c('36');

export function age(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

export function table(headers, rows) {
  if (!rows.length) return '';
  const all = [headers, ...rows];
  const w = headers.map((_, i) =>
    Math.max(...all.map((r) => String(r[i] ?? '').length))
  );
  const line = (r, f = (x) => x) =>
    r.map((v, i) => f(String(v ?? '').padEnd(w[i]))).join('  ').trimEnd();
  return [line(headers, dim), ...rows.map((r) => line(r))].join('\n');
}
