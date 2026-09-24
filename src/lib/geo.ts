import type { LatLng } from './types';

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function mapsLink(p: LatLng) {
  return `https://maps.google.com/?q=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

export function directionsLink(p: LatLng) {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

export function formatDistance(m: number) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

export const toKmh = (mps: number) => mps * 3.6;

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatDateTime(t: number) {
  return new Date(t).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatTime(t: number) {
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
