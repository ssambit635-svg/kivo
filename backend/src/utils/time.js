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
  if (Number.isNaN(dob.getTime())) return null;
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export function daysBetween(isoA, isoB) {
  const ms = Math.abs(new Date(isoB).getTime() - new Date(isoA).getTime());
  return ms / (24 * 3600 * 1000);
}
