/**
 * Local-first app store. Everything lives on the device in AsyncStorage so the
 * app keeps working on highways with no signal. The store is a plain module
 * (not React context) so the ride session and crash handler can use it too.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type {
  CrashEvent,
  EmergencyContact,
  InjuryReport,
  Ride,
  Settings,
  UserProfile,
} from './types';

export type AppData = {
  loaded: boolean;
  onboarded: boolean;
  profile: UserProfile;
  contacts: EmergencyContact[];
  settings: Settings;
  rides: Ride[];
  crashes: CrashEvent[];
  reports: InjuryReport[];
};

type PersistedKey = Exclude<keyof AppData, 'loaded'>;

const PREFIX = 'rbb:v1:';
const PERSISTED: PersistedKey[] = [
  'onboarded',
  'profile',
  'contacts',
  'settings',
  'rides',
  'crashes',
  'reports',
];

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 'medium',
  countdownSeconds: 30,
  liveLocation: true,
  includeMedicalInfo: true,
  emergencyNumber: '112',
};

const DEFAULTS: AppData = {
  loaded: false,
  onboarded: false,
  profile: { name: '', phone: '', medical: { bloodGroup: '', allergies: '', conditions: '' } },
  contacts: [],
  settings: DEFAULT_SETTINGS,
  rides: [],
  crashes: [],
  reports: [],
};

let state: AppData = DEFAULTS;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState() {
  return state;
}

function setState(patch: Partial<AppData>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  for (const key of Object.keys(patch) as (keyof AppData)[]) {
    if (key === 'loaded') continue;
    AsyncStorage.setItem(PREFIX + key, JSON.stringify(state[key])).catch((e) =>
      console.warn('Failed to persist', key, e),
    );
  }
}

/** Subscribe a component to a slice of the store. Selectors should return existing references. */
export function useApp<T>(selector: (s: AppData) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const actions = {
  async load() {
    const entries = await AsyncStorage.multiGet(PERSISTED.map((k) => PREFIX + k));
    const loaded: Partial<AppData> = {};
    for (const [fullKey, raw] of entries) {
      if (raw == null) continue;
      const key = fullKey.slice(PREFIX.length) as PersistedKey;
      try {
        (loaded as Record<string, unknown>)[key] = JSON.parse(raw);
      } catch {
        // Corrupt value: fall back to the default for this key.
      }
    }
    state = {
      ...DEFAULTS,
      ...loaded,
      settings: { ...DEFAULT_SETTINGS, ...loaded.settings },
      loaded: true,
    };
    listeners.forEach((l) => l());
  },

  completeOnboarding() {
    setState({ onboarded: true });
  },

  updateProfile(profile: Partial<UserProfile>) {
    setState({ profile: { ...state.profile, ...profile } });
  },

  upsertContact(contact: EmergencyContact) {
    const exists = state.contacts.some((c) => c.id === contact.id);
    setState({
      contacts: exists
        ? state.contacts.map((c) => (c.id === contact.id ? contact : c))
        : [...state.contacts, contact],
    });
  },

  removeContact(id: string) {
    setState({ contacts: state.contacts.filter((c) => c.id !== id) });
  },

  updateSettings(settings: Partial<Settings>) {
    setState({ settings: { ...state.settings, ...settings } });
  },

  addRide(ride: Ride) {
    setState({ rides: [ride, ...state.rides] });
  },

  deleteRide(id: string) {
    setState({ rides: state.rides.filter((r) => r.id !== id) });
  },

  addCrash(crash: CrashEvent) {
    setState({ crashes: [crash, ...state.crashes] });
  },

  updateCrash(id: string, patch: Partial<CrashEvent>) {
    setState({ crashes: state.crashes.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  },

  addReport(report: InjuryReport) {
    setState({ reports: [report, ...state.reports] });
  },

  updateReport(id: string, patch: Partial<InjuryReport>) {
    setState({ reports: state.reports.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  },

  async clearAll() {
    await AsyncStorage.multiRemove(PERSISTED.map((k) => PREFIX + k));
    state = { ...DEFAULTS, loaded: true };
    listeners.forEach((l) => l());
  },
};
