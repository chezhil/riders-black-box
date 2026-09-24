/**
 * Nearby hospital / clinic lookup via OpenStreetMap's Overpass API.
 * No API key needed, and OSM coverage of Indian hospitals is good.
 */
import { distanceM } from './geo';
import type { LatLng } from './types';

export type Facility = {
  id: string;
  name: string;
  kind: 'hospital' | 'clinic' | 'doctors';
  location: LatLng;
  distanceM: number;
  phone: string | null;
  emergency: boolean;
  address: string | null;
};

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

type OsmElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

function query(center: LatLng, radiusM: number) {
  const around = `(around:${radiusM},${center.lat},${center.lng})`;
  return `[out:json][timeout:20];
(
  nwr["amenity"~"^(hospital|clinic|doctors)$"]${around};
  nwr["healthcare"~"^(hospital|clinic)$"]${around};
);
out center tags 60;`;
}

async function fetchOverpass(q: string): Promise<OsmElement[]> {
  let lastError: unknown;
  for (const url of ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = (await res.json()) as { elements: OsmElement[] };
      return json.elements ?? [];
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function toFacility(el: OsmElement, from: LatLng): Facility | null {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const tags = el.tags ?? {};
  if (lat == null || lon == null) return null;
  const rawKind = tags.amenity ?? tags.healthcare;
  const kind: Facility['kind'] =
    rawKind === 'hospital' ? 'hospital' : rawKind === 'doctors' ? 'doctors' : 'clinic';
  const name =
    tags.name ?? tags['name:en'] ?? (kind === 'hospital' ? 'Unnamed hospital' : 'Unnamed clinic');
  const location = { lat, lng: lon };
  const address =
    [tags['addr:housename'], tags['addr:street'], tags['addr:suburb'] ?? tags['addr:city']]
      .filter(Boolean)
      .join(', ') || null;
  return {
    id: `${el.type}/${el.id}`,
    name,
    kind,
    location,
    distanceM: distanceM(from, location),
    phone: tags.phone ?? tags['contact:phone'] ?? tags['phone:mobile'] ?? null,
    emergency: tags.emergency === 'yes',
    address,
  };
}

/** Nearest facilities first. */
export async function findNearbyFacilities(center: LatLng): Promise<Facility[]> {
  for (const radius of [5000, 15000, 40000]) {
    const elements = await fetchOverpass(query(center, radius));
    const seen = new Set<string>();
    const facilities = elements
      .map((el) => toFacility(el, center))
      .filter((f): f is Facility => {
        if (!f) return false;
        const key = f.name.toLowerCase() + Math.round(f.location.lat * 1000);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.distanceM - b.distanceM);
    if (facilities.length >= 3 || radius === 40000) return facilities.slice(0, 25);
  }
  return [];
}
