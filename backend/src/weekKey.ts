/**
 * ISO week key (`YYYY-Www`), computed with UTC getters ONLY (N-A2-2).
 *
 * B1-8: this used to live in two places — scheduler.ts (correct) and a
 * local `isoWeekKey` copy in routes/audit.ts that mixed LOCAL date getters
 * into Date.UTC(), producing the wrong week label near midnight in
 * non-UTC timezones. One canonical implementation now; scheduler.ts
 * re-exports it so existing imports keep working. Side-effect-free by
 * design: route modules import this (never scheduler.ts itself, whose
 * module-level leader election eagerly creates a Redis client).
 */
export function isoWeek(d = new Date()): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
