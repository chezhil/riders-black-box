/**
 * Nearby hospital / clinic lookup from OpenStreetMap (no API key; OSM coverage
 * of Indian hospitals is good).
 *
 *  - Primary: Overpass API. It rejects requests without an identifying
 *    User-Agent (React Native's default "okhttp/…" gets HTTP 406) and is
 *    sometimes overloaded (504), so we identify ourselves and retry once.
 *  - Fallback: Nominatim search, requested in parallel so it adds no delay.
 *  - Cache: during a ride we prefetch facilities around the rider every ~5 km,
 *    so right after a crash the list shows instantly even on a weak signal.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

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

export type NearbyResult = {
  facilities: Facility[];
  /** Where the search was centred and when; set for results served from the ride cache. */
  cachedFrom?: { center: LatLng; fetchedAt: number };
};

const HEADERS = {
  'User-Agent': "RidersBlackBox/1.0 (two-wheeler crash assistance; +https://github.com/chezhil/riders-black-box)",
  Accept: 'application/json',
};
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESULTS = 25;

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('/')[2]}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Overpass ---------------------------------------------------------------

type OsmElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

function overpassQuery(center: LatLng, radiusM: number) {
  const around = `(around:${radiusM},${center.lat},${center.lng})`;
  return `[out:json][timeout:15];
(
  nwr["amenity"~"^(hospital|clinic|doctors)$"]${around};
  nwr["healthcare"~"^(hospital|clinic)$"]${around};
);
out center tags 60;`;
}

async function overpass(center: LatLng, radiusM: number): Promise<Facility[]> {
  const url = `${OVERPASS_URL}?data=${encodeURIComponent(overpassQuery(center, radiusM))}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await fetchJson<{ elements?: OsmElement[] }>(url);
      return (json.elements ?? []).map((el) => fromOsm(el, center)).filter((f): f is Facility => f != null);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function fromOsm(el: OsmElement, from: LatLng): Facility | null {
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

// ---- Nominatim (fallback) ---------------------------------------------------

type NominatimPlace = {
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  name?: string;
  type?: string;
  display_name?: string;
  extratags?: Record<string, string> | null;
};

async function nominatim(center: LatLng, kind: 'hospital' | 'clinic', spanDeg: number): Promise<Facility[]> {
  const viewbox = [center.lng - spanDeg, center.lat + spanDeg, center.lng + spanDeg, center.lat - spanDeg].join(',');
  const url =
    `${NOMINATIM_URL}?amenity=${kind}&format=jsonv2&limit=20&bounded=1&extratags=1` +
    `&viewbox=${encodeURIComponent(viewbox)}`;
  const places = await fetchJson<NominatimPlace[]>(url);
  return places.map((p) => {
    const location = { lat: Number(p.lat), lng: Number(p.lon) };
    const tags = p.extratags ?? {};
    return {
      id: `${p.osm_type}/${p.osm_id}`,
      name: p.name || (kind === 'hospital' ? 'Unnamed hospital' : 'Unnamed clinic'),
      kind,
      location,
      distanceM: distanceM(center, location),
      phone: tags.phone ?? tags['contact:phone'] ?? null,
      emergency: tags.emergency === 'yes',
      address: p.display_name?.split(', ').slice(1, 4).join(', ') || null,
    };
  });
}

async function nominatimNearby(center: LatLng): Promise<Facility[]> {
  // ~11 km box first, widen to ~33 km if that finds almost nothing.
  for (const span of [0.1, 0.3]) {
    const [hospitals, clinics] = await Promise.all([
      nominatim(center, 'hospital', span),
      nominatim(center, 'clinic', span).catch(() => []),
    ]);
    const all = [...hospitals, ...clinics];
    if (all.length >= 3 || span === 0.3) return all;
  }
  return [];
}

// ---- Search -----------------------------------------------------------------

function tidy(facilities: Facility[]) {
  const seen = new Set<string>();
  return facilities
    .filter((f) => {
      const key = f.name.toLowerCase() + Math.round(f.location.lat * 1000);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_RESULTS);
}

async function searchLive(center: LatLng): Promise<Facility[]> {
  // Start the fallback straight away so a slow/overloaded Overpass costs nothing.
  const fallback = nominatimNearby(center).catch(() => null);
  try {
    let found = await overpass(center, 8000);
    if (found.length < 3) found = await overpass(center, 30000);
    if (found.length > 0) return tidy(found);
  } catch (e) {
    console.warn('Overpass failed, using Nominatim', e);
  }
  const alt = await fallback;
  if (alt && alt.length > 0) return tidy(alt);
  if (alt) return [];
  throw new Error('Hospital search is unavailable right now.');
}

// ---- Ride cache -------------------------------------------------------------

const CACHE_KEY = 'rbb:v1:hospitalCache';
/** Serve cached results if the rider is within this distance of where they were fetched. */
const CACHE_RADIUS_M = 15_000;
const PREFETCH_EVERY_M = 5_000;
const PREFETCH_RETRY_MS = 2 * 60_000;

type Cache = { center: LatLng; fetchedAt: number; facilities: Facility[] };
let cache: Cache | null = null;
let cacheLoaded = false;
let prefetching = false;
let lastPrefetchAttempt = 0;

async function loadCache() {
  if (cacheLoaded) return cache;
  cacheLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (raw && !cache) cache = JSON.parse(raw) as Cache;
  } catch {
    // Ignore a corrupt cache.
  }
  return cache;
}

function saveCache(center: LatLng, facilities: Facility[]) {
  cache = { center, fetchedAt: Date.now(), facilities };
  AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache)).catch(() => {});
}

/** Cached facilities near `location`, with distances recomputed from there. */
export async function cachedNearby(location: LatLng): Promise<NearbyResult | null> {
  const c = await loadCache();
  if (!c || distanceM(c.center, location) > CACHE_RADIUS_M || c.facilities.length === 0) return null;
  return {
    facilities: tidy(c.facilities.map((f) => ({ ...f, distanceM: distanceM(location, f.location) }))),
    cachedFrom: { center: c.center, fetchedAt: c.fetchedAt },
  };
}

/**
 * Called with the rider's position during a ride; refreshes the cache at the
 * start and every ~5 km so hospitals are ready before anything happens.
 */
export function prefetchNearby(location: LatLng) {
  const now = Date.now();
  if (prefetching || now - lastPrefetchAttempt < PREFETCH_RETRY_MS) return;
  if (cache && distanceM(cache.center, location) < PREFETCH_EVERY_M) return;
  prefetching = true;
  lastPrefetchAttempt = now;
  loadCache()
    .then((c) => (c && distanceM(c.center, location) < PREFETCH_EVERY_M ? null : searchLive(location)))
    .then((facilities) => {
      if (facilities && facilities.length) saveCache(location, facilities);
    })
    .catch((e) => console.warn('Hospital prefetch failed', e))
    .finally(() => {
      prefetching = false;
    });
}

/** Live search around `center`; results also refresh the ride cache. */
export async function findNearbyFacilities(center: LatLng): Promise<Facility[]> {
  const facilities = await searchLive(center);
  if (facilities.length) saveCache(center, facilities);
  return facilities;
}
