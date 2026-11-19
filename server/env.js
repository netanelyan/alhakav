import { existsSync, readFileSync } from 'node:fs';

// Settings come from the environment, then from private/.env (never in the repo), the way openfrequency's servers read
// theirs. A value already in the environment wins, so systemd or a test can override the file.

export function loadEnv(file, base = process.env) {
  const out = { ...base };
  if (!file || !existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (out[m[1]] === undefined || out[m[1]] === '') out[m[1]] = value;
  }
  return out;
}

/** A number setting, or the default when it is unset or not a number. */
export const num = (value, fallback) => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value));
