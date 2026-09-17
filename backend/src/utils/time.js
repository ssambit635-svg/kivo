/** Time helpers. All timestamps in the system are ISO-8601 UTC strings. */

export function nowIso() {
  return new Date().toISOString();
}

export function plusSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

export function isPast(iso) {
  if (!iso) return false;
  return new Date(iso).getTime() <= Date.now();
}

export function ageFromDob(dobIso, at = new Date()) {
  const dob = new Date(dobIso);
  const atDate = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(dob.getTime()) || Number.isNaN(atDate.getTime())) return null;
  let age = atDate.getUTCFullYear() - dob.getUTCFullYear();
  const m = atDate.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && atDate.getUTCDate() < dob.getUTCDate())) age -= 1;
  // A future or absurd DOB is corrupt input, not a real age — callers treat
  // null as \"missing\" instead of feeding a wild z-score into the models.
  if (!Number.isFinite(age) || age < 0 || age > 150) return null;
  return age;
}

export function daysBetween(isoA, isoB) {
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  // Invalid timestamps must never propagate a NaN into span/progress math.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const ms = Math.abs(b - a);
  return ms / (24 * 3600 * 1000);
}

/** Safe ISO day slice — returns null instead of throwing on bad input. */
export function asDaySafe(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Safe short-date for narration — never throws on bad input. */
export function shortDateSafe(iso, fallback = 'unknown date') {
  const day = asDaySafe(iso);
  return day || fallback;
}
