// Small JSON boundary for the Series adapter. No ambient application inputs.
export function canonicalSeriesJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((k, i) => k !== String(i))) throw new Error('Dense JSON arrays required');
    return '[' + keys.map(k => canonicalSeriesJSON(dataProperty(value, k))).join(',') + ']';
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalSeriesJSON(dataProperty(value, k))).join(',') + '}';
  }
  throw new Error('Only finite plain JSON data is supported; callbacks are not inputs');
}
function dataProperty(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Mutable accessors are not snapshot inputs');
  return descriptor.value;
}
export const copySeriesJSON = value => JSON.parse(canonicalSeriesJSON(value));
export function freezeSeriesJSON(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeSeriesJSON); Object.freeze(value); }
  return value;
}
export async function hashSeriesJSON(value) {
  const bytes = new TextEncoder().encode(canonicalSeriesJSON(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export function seriesId(value, label = 'ID') {
  if (typeof value !== 'string' || value === 'UNKNOWN' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/.test(value)) throw new Error('Invalid stable ' + label);
  return value;
}
export function seriesRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid series revision');
  return value;
}
export function seriesTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('Explicit valid UTC timestamp required');
  return value;
}
export function seriesPurpose(value) {
  if (!['PRODUCTION', 'TEST'].includes(value)) throw new Error('Explicit Series purpose required');
  return value;
}
