import { safeUrl } from './catalog.js';

const STORAGE_KEY = 'tv-pro.preferences.v2';
export const sourcePresets = [
  { id: 'iptv-do', name: 'IPTV-org · República Dominicana', url: 'https://iptv-org.github.io/iptv/countries/do.m3u', country: 'DO' },
  { id: 'iptv-es-language', name: 'IPTV-org · En español', url: 'https://iptv-org.github.io/iptv/languages/spa.m3u', language: 'es' },
  { id: 'iptv-americas', name: 'IPTV-org · América', url: 'https://iptv-org.github.io/iptv/regions/amer.m3u' }
];

export function newId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function newProfile(name = 'Principal', id = newId()) {
  return {
    id, name, favorites: [], hidden: [], order: [], favoriteCategories: [],
    last: '', recent: [], pin: null, blockedCategories: [],
    playback: { audioLanguage: 'es', lowPower: false, preferNative: true, muted: false, volume: 0.8, timeout: 10000, resume: true },
    appearance: { position: 'left', scale: 'normal', fit: 'cover' }
  };
}

function initialPreferences() {
  return {
    version: 3, active: 'principal', profiles: [newProfile('Principal', 'principal')],
    sources: sourcePresets.slice(0, 2).map(source => ({ ...source })),
    numbers: Object.create(null), refreshHours: 24, probeTimeout: 6500, probeEnabled: true
  };
}

export function cleanText(value, limit = 120) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, limit) : '';
}

const clamp = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value)
  ? Math.min(max, Math.max(min, value)) : fallback;
const distinctStrings = (values, limit = 20000) => Array.isArray(values)
  ? [...new Set(values.slice(0, limit).map(value => cleanText(value, 4096)).filter(Boolean))] : [];
const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;

export function cleanSource(input) {
  const id = cleanText(input?.id, 64);
  const name = cleanText(input?.name, 80);
  const url = safeUrl(input?.url);
  const local = input?.local === true;
  if (!/^[\w-]+$/.test(id) || !name || (!local && !url)) return null;
  const country = cleanText(input.country, 2).toUpperCase();
  const language = cleanText(input.language, 20).toLowerCase();
  return {
    id, name, local, url: local ? '' : url, epg: safeUrl(input.epg),
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    language: /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language) ? language : ''
  };
}

function cleanProfile(value, upgradeViewport) {
  const id = cleanText(value?.id, 64);
  const name = cleanText(value?.name, 40);
  if (!/^[\w-]+$/.test(id) || !name) return null;
  const defaults = newProfile(name, id);
  const playback = value.playback || {};
  const appearance = value.appearance || {};
  const audioLanguage = cleanText(playback.audioLanguage, 20).toLowerCase();
  const pin = value.pin && /^[0-9a-f]{32}$/.test(value.pin.salt) && /^[0-9a-f]{64}$/.test(value.pin.hash)
    ? { salt: value.pin.salt, hash: value.pin.hash } : null;
  return {
    ...defaults, last: cleanText(value.last, 4096), recent: distinctStrings(value.recent, 20),
    favorites: distinctStrings(value.favorites), hidden: distinctStrings(value.hidden),
    order: distinctStrings(value.order), favoriteCategories: distinctStrings(value.favoriteCategories, 100),
    blockedCategories: distinctStrings(value.blockedCategories, 100), pin,
    playback: {
      audioLanguage: /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(audioLanguage) ? audioLanguage : 'es',
      lowPower: bool(playback.lowPower, false), preferNative: bool(playback.preferNative, true),
      muted: bool(playback.muted, false), volume: clamp(playback.volume, 0, 1, 0.8),
      timeout: clamp(playback.timeout, 4000, 30000, 10000), resume: bool(playback.resume, true)
    },
    appearance: {
      position: appearance.position === 'right' ? 'right' : 'left',
      scale: ['compact', 'large'].includes(appearance.scale) ? appearance.scale : 'normal',
      fit: !upgradeViewport && appearance.fit === 'contain' ? 'contain' : 'cover'
    }
  };
}

function uniqueById(values) {
  return [...new Map(values.filter(Boolean).map(value => [value.id, value])).values()];
}

export function validatePreferences(value) {
  if (!value || ![2, 3].includes(value.version) || !Array.isArray(value.profiles) || !Array.isArray(value.sources)) {
    throw new Error('Este archivo no contiene preferencias compatibles de TV PRO.');
  }
  const profiles = uniqueById(value.profiles.slice(0, 12).map(profile => cleanProfile(profile, value.version === 2)));
  if (!profiles.length) throw new Error('El archivo necesita un perfil válido.');
  const numbers = Object.create(null);
  for (const [key, number] of Object.entries(value.numbers || {}).slice(0, 180000)) {
    if (cleanText(key, 4096) === key && key && Number.isInteger(number) && number >= 0 && number <= 999999) {
      // Aliases may share a number with the canonical channel.
      numbers[key] = number;
    }
  }
  return {
    version: 3, profiles, active: profiles.some(profile => profile.id === value.active) ? value.active : profiles[0].id,
    sources: uniqueById(value.sources.slice(0, 24).map(cleanSource)), numbers,
    refreshHours: [0, 6, 12, 24, 48].includes(value.refreshHours) ? value.refreshHours : 24,
    probeTimeout: clamp(value.probeTimeout, 2500, 15000, 6500), probeEnabled: bool(value.probeEnabled, true)
  };
}

export function readPreferences() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? validatePreferences(JSON.parse(stored)) : initialPreferences();
  } catch {
    return initialPreferences();
  }
}

export function savePreferences(preferences) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function pinAvailable() {
  return Boolean(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues);
}

const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

async function pinDigest(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bytes = Uint8Array.from(salt.match(/../g), pair => Number.parseInt(pair, 16));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes, iterations: 120000 }, key, 256);
  return toHex(new Uint8Array(bits));
}

export async function makePin(pin) {
  if (!pinAvailable()) throw new Error('El PIN requiere HTTPS o localhost.');
  if (!/^\d{4,8}$/.test(pin)) throw new Error('Usa entre 4 y 8 dígitos.');
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await pinDigest(pin, salt) };
}

export async function checkPin(pin, record) {
  if (!pinAvailable()) throw new Error('Abre TV PRO por HTTPS o localhost para desbloquear.');
  if (!/^\d{4,8}$/.test(pin)) return false;
  return (await pinDigest(pin, record.salt)) === record.hash;
}
