const PLAYLIST_LIMIT = 12 * 1024 * 1024;
const ENTRY_LIMIT = 30000;
const MANIFEST_LIMIT = 256 * 1024;
const SAMPLE_SIZE = 1024;
const SOURCE_PROTOCOLS = new Set(['https:', 'http:']);

export function safeUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const url = new URL(value.trim(), base || undefined);
    if (!SOURCE_PROTOCOLS.has(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function clean(value, max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max);
}

function fold(value) {
  return clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const COUNTRY_NAMES = new Map(Object.entries({
  'republica dominicana': 'DO', 'dominican republic': 'DO', 'dominicana': 'DO', rd: 'DO',
  espana: 'ES', spain: 'ES', mexico: 'MX', colombia: 'CO', argentina: 'AR',
  chile: 'CL', peru: 'PE', ecuador: 'EC', bolivia: 'BO', venezuela: 'VE', uruguay: 'UY',
  paraguay: 'PY', 'costa rica': 'CR', panama: 'PA', cuba: 'CU', 'puerto rico': 'PR',
  honduras: 'HN', nicaragua: 'NI', guatemala: 'GT', 'el salvador': 'SV', 'estados unidos': 'US',
  'united states': 'US', brasil: 'BR', brazil: 'BR', portugal: 'PT', france: 'FR', francia: 'FR',
  'united kingdom': 'GB', 'reino unido': 'GB', uk: 'GB', canada: 'CA', haiti: 'HT'
}));

const LANGUAGE_NAMES = new Map(Object.entries({
  spa: 'es', esp: 'es', espanol: 'es', spanish: 'es', castellano: 'es', eng: 'en', english: 'en',
  ingles: 'en', por: 'pt', portuguese: 'pt', portugues: 'pt', fra: 'fr', fre: 'fr', french: 'fr',
  frances: 'fr', deu: 'de', ger: 'de', german: 'de', aleman: 'de', ita: 'it', italian: 'it',
  italiano: 'it', cat: 'ca', catalan: 'ca', jpn: 'ja', japanese: 'ja', zho: 'zh', chi: 'zh',
  arabic: 'ar', ara: 'ar', rus: 'ru', russian: 'ru'
}));

function distinct(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitMetadata(value) {
  return clean(value, 320).split(/[;,|]/).map(item => item.trim()).filter(Boolean).slice(0, 12);
}

function countryCodes(value) {
  return distinct(splitMetadata(value).map(item => {
    const code = fold(item);
    return COUNTRY_NAMES.get(code) || (/^[a-z]{2}$/.test(code) ? code.toUpperCase() : '');
  }));
}

function languageCodes(value) {
  return distinct(splitMetadata(value).map(item => {
    const tag = fold(item).split(/[-_]/, 1)[0];
    return LANGUAGE_NAMES.get(tag) || (/^[a-z]{2,3}$/.test(tag) ? tag : '');
  }));
}

function countryFromId(id) {
  const match = id.match(/\.([a-z]{2})(?:@|$)/i);
  return match && match[1].toLowerCase() !== 'tv' ? countryCodes(match[1]) : [];
}

function readAttributes(line) {
  const attributes = Object.create(null);
  for (const match of line.matchAll(/([a-z][a-z0-9-]*)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,]+))/gi)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  }
  return attributes;
}

function extInfo(line) {
  let quote = '';
  let index = 0;
  for (; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      let before = index - 1;
      while (before >= 0 && /\s/.test(line[before])) before -= 1;
      if (line[before] === '=') quote = character;
    } else if (character === ',') {
      break;
    }
  }
  return { attributes: readAttributes(line.slice(0, index)), name: line.slice(index + 1) };
}

function getHeader(text) {
  return text.replace(/^\uFEFF/, '').trimStart().split(/\r\n|\n|\r/, 1)[0].trim();
}

export function playlistEPGUrls(text, baseUrl) {
  if (typeof text !== 'string') return [];
  const header = getHeader(text);
  if (!/^#EXTM3U(?:\s|$)/i.test(header)) return [];
  const attributes = readAttributes(header);
  return distinct([attributes['x-tvg-url'], attributes['url-tvg'], attributes['tvg-url']]
    .filter(Boolean).flatMap(value => value.split(',')).map(url => safeUrl(url, baseUrl))).slice(0, 8);
}

function nameFromUrl(url) {
  const address = new URL(url);
  const sections = address.pathname.split('/').filter(Boolean);
  const resource = (sections.pop() || '').replace(/\.(?:m3u8?|mp4|webm|ts|mpd|aac|mp3)$/i, '');
  const slug = /^(?:index|master|playlist|stream|live|manifest)$/i.test(resource) ? sections.pop() : resource;
  try {
    return clean(decodeURIComponent(slug || address.hostname));
  } catch {
    return clean(slug || address.hostname);
  }
}

function makeEntry(url, info, options) {
  const attributes = info?.attributes || {};
  const tvgId = clean(attributes['tvg-id'] || attributes['channel-id']);
  const countries = countryCodes(attributes['tvg-country'] || attributes.country);
  const languages = languageCodes(attributes['tvg-language'] || attributes.language);
  const logo = safeUrl(attributes['tvg-logo'], options.baseUrl);
  return {
    name: clean(info?.name || attributes['tvg-name']) || nameFromUrl(url),
    tvgId,
    url,
    logo,
    countries: countries.length ? countries : distinct([...countryFromId(tvgId), ...countryCodes(options.country)]),
    languages: languages.length ? languages : languageCodes(options.language),
    categories: splitMetadata(attributes['group-title'] || info?.group),
    sourceId: options.sourceId || '',
    type: options.type || (/\.m3u8?$/i.test(new URL(url).pathname) ? 'hls' : '')
  };
}

export function parseM3U(text, options = {}) {
  if (typeof text !== 'string' || text.length > PLAYLIST_LIMIT) throw new Error('La lista excede el tamaño permitido.');
  if (!/^#EXTM3U(?:\s|$)/i.test(getHeader(text))) throw new Error('El archivo no empieza con una cabecera M3U válida.');

  if (/^\s*#EXT-X-(?:STREAM-INF|I-FRAME-STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|PART|MAP|ENDLIST)(?::|\s*$)/im.test(text)) {
    const url = safeUrl(options.baseUrl);
    if (!url) throw new Error('La lista contiene una sola señal HLS. Agrega su URL como fuente.');
    return [makeEntry(url, { name: options.name }, { ...options, type: 'hls' })];
  }

  const entries = [];
  let info;
  let group = '';
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#EXTINF:/i.test(line)) {
      info = extInfo(line.slice(8));
      continue;
    }
    if (/^#EXTGRP:/i.test(line)) {
      group = clean(line.slice(8), 320);
      if (info) info.group = group;
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = safeUrl(line, options.baseUrl);
    if (url) {
      const entry = makeEntry(url, info || { group }, options);
      if (entry.name) entries.push(entry);
      if (entries.length > ENTRY_LIMIT) throw new Error('La lista supera 30 000 entradas.');
    }
    info = undefined;
    group = '';
  }
  if (!entries.length) throw new Error('La lista no contiene direcciones de transmisión HTTP o HTTPS utilizables.');
  return entries;
}

function abortError(signal) {
  return signal?.reason || new DOMException('Operación cancelada.', 'AbortError');
}

function inCatalogWorker(message, signal, fallback) {
  const local = () => Promise.resolve().then(() => {
    if (signal?.aborted) throw abortError(signal);
    return fallback();
  });
  if (signal?.aborted || typeof Worker !== 'function') return local();
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL(import.meta.url), { type: 'module' });
    } catch {
      resolve(local());
      return;
    }
    const cleanUp = () => {
      clearTimeout(timer);
      worker.terminate();
      signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      cleanUp();
      reject(abortError(signal));
    };
    const useFallback = event => {
      event?.preventDefault();
      cleanUp();
      resolve(local());
    };
    const timer = setTimeout(useFallback, 10000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }) => {
      cleanUp();
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.onerror = useFallback;
    worker.onmessageerror = useFallback;
    try {
      worker.postMessage(message);
    } catch {
      useFallback();
    }
  });
}

export async function parseM3UAsync(text, options = {}, { signal } = {}) {
  if (signal?.aborted) throw abortError(signal);
  if (typeof text !== 'string' || text.length < 256 * 1024) return parseM3U(text, options);
  return inCatalogWorker({ operation: 'parse', text, options }, signal, () => parseM3U(text, options));
}

function cancelBody(body) {
  if (body && typeof body.cancel === 'function') body.cancel().catch(() => {});
}

export async function readTextLimited(response, maxBytes = PLAYLIST_LIMIT) {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) {
    cancelBody(response.body);
    throw new RangeError('El archivo excede el tamaño permitido.');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new RangeError('El archivo excede el tamaño permitido.');
    return text;
  }
  const reader = response.body.getReader();
  const charset = (response.headers.get('content-type') || '').match(/\bcharset\s*=\s*["']?([\w-]+)/i)?.[1];
  let decoder;
  try {
    decoder = new TextDecoder(charset || 'utf-8');
  } catch {
    decoder = new TextDecoder();
  }
  const parts = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new RangeError('El archivo excede el tamaño permitido.');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function fetchSource(source, { signal, timeout = 15000 } = {}) {
  const url = safeUrl(source.url);
  if (!url) throw new Error('La dirección de la fuente no es válida.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeout);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, {
      credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal, cache: 'no-cache'
    });
    if (!response.ok) {
      cancelBody(response.body);
      throw new Error(`La fuente respondió con HTTP ${response.status}.`);
    }
    const baseUrl = safeUrl(response.url || url);
    if (!baseUrl) throw new Error('La fuente redirigió a una dirección incompatible.');
    const text = await readTextLimited(response);
    const entries = await parseM3UAsync(text, { ...source, baseUrl, sourceId: source.id }, { signal: controller.signal });
    // Available to the refresh coordinator without changing the entries list contract.
    Object.defineProperty(entries, 'epgUrls', { value: playlistEPGUrls(text, baseUrl) });
    return entries;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('La fuente superó el tiempo de espera.');
    if (error instanceof TypeError) throw new Error('El navegador no pudo leer la fuente. Comprueba la red y los permisos CORS.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function hashUrl(url) {
  let left = 2166136261;
  let right = 5381;
  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right, 33) ^ code;
  }
  return `${(left >>> 0).toString(36)}-${(right >>> 0).toString(36)}`;
}

function identity(entry) {
  return clean(entry.tvgId || entry.id).toLowerCase().split('@', 1)[0];
}

function normalizeName(name) {
  return fold(name).replace(/[\[(]\s*(?:hd|sd|fhd|uhd|4k|1080p|720p)\s*[\])]/g, '')
    .replace(/\s+(?:hd|sd|fhd|uhd|4k|1080p|720p)$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

const RD_NETWORKS = [
  /^(?:teleantillas(?:canal2)?|canal2(?:rd)?)$/,
  /^(?:telemicro(?:canal5)?|canal5(?:rd)?)$/,
  /^(?:antena7|canal7(?:rd)?)$/,
  /^(?:colorvision(?:canal9)?|canal9(?:rd)?)$/,
  /^(?:telesistema(?:11)?|canal11(?:rd)?)$/,
  /^(?:digital15|canal15(?:rd)?)$/,
  /^(?:rtvd|certv|canal4(?:rd|rtvd)?|canal17rtvd|rtvdcanal4|certvcanal4)$/,
  /^(?:telecentro(?:canal13)?|canal13(?:rd)?)$/,
  /^(?:cdn(?:canal)?37|cdn|canal37(?:rd)?)$/,
  /^(?:rnn(?:canal27)?|rednacionaldenoticias|noticiassin|noticias16)$/,
  /^(?:coral39|supercanal(?:33)?|teleuniverso(?:29)?|teleunion|telefuturo(?:23)?|telecanal(?:12|28))$/
];

const CABLE_SUFFIX = '(?:(?:latinamerica|latinoamerica|latam|panregional|panamericano|internacional|international|north|south|norte|sur|central|andina|andino|caribe|mexico|argentina|colombia|brasil|brazil|chile|ecuador|peru|venezuela|uruguay|paraguay|espana|spain|usa|feed|este|oeste|east|west|fhd|uhd|hd|sd|1080p|720p|4k))*';
const CABLE_NETWORKS = [
  'disney(?:channel|junior|jr|xd)?',
  'warner(?:channel|bros)?|wbchannel|cartoonnetwork|cartoonito|adultswim|boomerang|tntextreme|tnt(?:series|sports|novelas|comedia)?\\d*|hbo(?:signature|family|plus|xtreme|extreme|pop|mundi|max|hits|\\d+)?|cinemax|discovery(?:channel|kids|turbo|theater|science|world|homeandhealth)?|investigationdiscovery|animalplanet|tlc',
  'fox(?:channel|sports(?:premium)?\\d*|news(?:channel)?|business(?:network)?|life|premium|movies|action|family|cinema|series)|fox(?=latinamerica|latinoamerica|latam)|fx(?:m|movies|now)?|fxx|star(?:channel|life|premiere|action|series|hits|comedy|fun|cinema|plus)|nickelodeon(?:junior|jr|teen|toons)?|nick(?:jr|junior|toons|teen)|teennick|espn(?:deportes|premium|extra|news|u|plus)?\\d*|ae(?:network)?|history(?:channel|2|enespanyol)?|h2|nationalgeographic(?:wild)?|natgeo(?:wild)?|universal(?:channel|tv|cinema|comedy|crime|premiere|studio)?|studiouniversal|sony(?:channel|movies|cine)|axn(?:white|black|movies)?|amc|tcm|cinecanal|space|paramount(?:channel|network)?|comedycentral|foodnetwork|filmarts|golden(?:edge|plus)?|nbatv|golfchannel|dreamworks(?:channel)?|eurosport\\d*|mtv(?:hits|live|80s|90s|00s)?|trutv|eentertainment'
].map(brands => new RegExp(`^(?:${brands})${CABLE_SUFFIX}$`));

function channelIdentifiers(channel) {
  const ids = [channel.tvgId, ...(channel.tvgIds || []), channel.id];
  return distinct(ids.map(id => identity({ tvgId: clean(id).replace(/^tvg:/, '') })));
}

function importantDRRank(channel) {
  const ids = channelIdentifiers(channel);
  const localIdKeys = ids.filter(id => id.endsWith('.do')).map(id => normalizeName(id.slice(0, -3)));
  const countries = channel.countries?.length ? channel.countries : countryCodes(channel.country);
  const local = countries.includes('DO') || localIdKeys.length > 0;
  const foreign = countries.length > 0 || ids.some(id => countryFromId(id).length);
  const name = normalizeName(channel.name);
  return RD_NETWORKS.findIndex(network => localIdKeys.some(id => network.test(id)) ||
    (local || !foreign && !/^canal\d+$/.test(name)) && network.test(name));
}

function cableBrandRank(channel) {
  const ids = channelIdentifiers(channel).map(id => normalizeName(id.replace(/\.[a-z]{2}$/i, '')));
  const keys = distinct([normalizeName(channel.name), ...ids]);
  const named = CABLE_NETWORKS.findIndex(network => keys.some(key => network.test(key)));
  if (named >= 0) return named;
  return (channel.categories || []).some(category => /^(?:cable(?:tv)?|tv(?:porcable|depago)|pago|paytv|paidtv|subscriptiontv)$/.test(normalizeName(category)))
    ? CABLE_NETWORKS.length : -1;
}

export function isImportantDR(channel) { return importantDRRank(channel) >= 0; }
export function isCableChannel(channel) { return cableBrandRank(channel) >= 0; }

export function lineupRank(channel) {
  if (channel.fixed || channel.lineupGroup === 'fixed') return 0;
  if (channel.lineupGroup === 'rd') return 1;
  if (channel.lineupGroup === 'cable') return 2;
  return channel.country === 'DO' ? 3 : 4;
}

function prepareFixedLineup(items) {
  const stations = new Map();
  const byId = new Map();
  const byName = new Map();
  const byUrl = new Map();
  const seeds = [];
  for (const item of items) {
    const { number } = item;
    const name = clean(item.name);
    if (!name || !Number.isSafeInteger(number) || number < 0 || stations.has(number)) continue;
    const tvgIds = distinct((item.tvgIds || []).map(id => clean(id)));
    const nameKeys = distinct([name, ...(item.names || [])].map(normalizeName));
    const idKeys = distinct(tvgIds.map(tvgId => identity({ tvgId })));
    const streams = (item.streams || []).flatMap(stream => {
      const url = safeUrl(stream.url);
      return url && !byUrl.has(url) ? [{ ...stream, url }] : [];
    });
    const aliases = [`fixed:${number}`, ...idKeys.map(id => `tvg:${id}`),
      ...nameKeys.flatMap(key => [`name:DO:${key}`, `name:-:${key}`]), ...streams.map(({ url }) => `url:${hashUrl(url)}`)];
    stations.set(number, { number, aliases, tvgIds });
    for (const id of idKeys) if (!byId.has(id)) byId.set(id, number);
    for (const key of nameKeys) if (!byName.has(key)) byName.set(key, number);
    const seed = { ...item, name, tvgId: tvgIds[0] || '', countries: ['DO'], languages: ['es'], fixedSeed: true, fixedNumber: number };
    seeds.push(seed);
    for (const stream of streams) {
      byUrl.set(stream.url, number);
      seeds.push({ ...seed, ...stream, type: stream.type || (/\.m3u8?$/i.test(new URL(stream.url).pathname) ? 'hls' : '') });
    }
  }
  return { stations, byId, byName, byUrl, seeds };
}

function validNumber(number) {
  return Number.isSafeInteger(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER - 100000;
}

function migrateFixedNumbers(channels, numbers) {
  const fixed = channels.filter(channel => channel.fixed);
  const reserved = new Set(fixed.map(channel => channel.number));
  const currentOwner = new Map();
  for (const channel of channels) for (const alias of channel.aliases) currentOwner.set(alias, channel);
  const oldOwners = new Map();
  for (const channel of fixed) {
    for (const alias of channel.aliases) {
      const number = numbers[alias];
      if (!validNumber(number)) continue;
      if (!oldOwners.has(number)) oldOwners.set(number, channel);
      else if (oldOwners.get(number) !== channel) oldOwners.set(number, null);
    }
  }
  const previous = Object.entries(numbers).filter(([, number]) => validNumber(number));
  let next = Math.max(...reserved) + 1;
  for (const [, number] of previous) next = Math.max(next, number + 1);
  const relocated = new Map();
  for (const [alias, number] of previous) {
    const active = currentOwner.get(alias);
    const owner = active || oldOwners.get(number);
    if (owner?.fixed) {
      if (!active) owner.aliases.push(alias);
      numbers[alias] = owner.number;
    } else if (reserved.has(number)) {
      if (!relocated.has(number)) relocated.set(number, next++);
      numbers[alias] = relocated.get(number);
    }
  }
  for (const channel of fixed) for (const alias of channel.aliases) numbers[alias] = channel.number;
}

function compareLineup(a, b) {
  return lineupRank(a) - lineupRank(b) || (a.brandPriority ?? 0) - (b.brandPriority ?? 0);
}

function addToIndex(index, key, value, merge) {
  if (!key) return;
  if (index.has(key)) merge(index.get(key), value);
  else index.set(key, value);
}

function compareDefault(a, b) {
  return Number(b.country === 'DO') - Number(a.country === 'DO');
}

export function buildCatalog(entries, numbers = Object.create(null), { fixedLineup = [] } = {}) {
  const fixed = prepareFixedLineup(fixedLineup);
  const rows = [...fixed.seeds, ...entries].flatMap(entry => {
    const url = safeUrl(entry.url);
    const name = clean(entry.name);
    const identityKey = identity(entry);
    const countries = distinct([...(entry.countries || countryCodes(entry.country)).map(code => clean(code).toUpperCase()),
      ...countryFromId(identityKey)]);
    const languages = entry.languages || languageCodes(entry.language);
    const nameKey = normalizeName(name);
    const fixedNumber = entry.fixedNumber ?? fixed.byId.get(identityKey) ?? fixed.byUrl.get(url) ??
      (!countries.length || countries.includes('DO') ? fixed.byName.get(nameKey) : undefined);
    return (url || entry.fixedSeed) && name ? [{ ...entry, name, identityKey, countries, languages, url, nameKey, fixedNumber }] : [];
  });
  const parents = rows.map((_, position) => position);
  const sizes = rows.map(() => 1);
  const pinned = rows.map(row => row.fixedNumber);
  const find = position => {
    while (position !== parents[position]) {
      parents[position] = parents[parents[position]];
      position = parents[position];
    }
    return position;
  };
  const merge = (first, second) => {
    const a = find(first);
    const b = find(second);
    if (a === b) return;
    if (pinned[a] !== undefined && pinned[b] !== undefined && pinned[a] !== pinned[b]) return;
    const [larger, smaller] = sizes[a] >= sizes[b] ? [a, b] : [b, a];
    parents[smaller] = larger;
    sizes[larger] += sizes[smaller];
    pinned[larger] ??= pinned[smaller];
  };

  const ids = new Map();
  const urls = new Map();
  const names = new Map();
  const fixedPositions = new Map();
  rows.forEach((entry, position) => {
    if (entry.fixedNumber !== undefined) addToIndex(fixedPositions, String(entry.fixedNumber), position, merge);
    addToIndex(ids, entry.identityKey, position, merge);
    addToIndex(urls, entry.url, position, merge);
    if (!entry.nameKey) return;
    if (!names.has(entry.nameKey)) names.set(entry.nameKey, []);
    names.get(entry.nameKey).push(position);
  });
  for (const positions of names.values()) {
    const byCountry = new Map();
    const unknown = [];
    for (const position of positions) {
      const country = rows[position].countries[0];
      if (country) addToIndex(byCountry, country, position, merge);
      else unknown.push(position);
    }
    // An unclassified name is ambiguous when it exists in several countries.
    if (unknown.length) {
      const target = byCountry.size === 1 ? byCountry.values().next().value : unknown[0];
      for (const position of unknown) merge(target, position);
    }
  }

  const groups = new Map();
  rows.forEach((entry, position) => {
    const root = find(position);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry);
  });
  const channels = [...groups.values()].map(group => {
    const selected = group.find(entry => entry.fixedSeed) || group.find(entry => entry.countries.includes('DO')) || group[0];
    const station = fixed.stations.get(selected.fixedNumber);
    const countries = distinct([selected, ...group].flatMap(entry => entry.countries));
    const languages = distinct(group.flatMap(entry => entry.languages));
    const tvgId = clean(selected.tvgId || selected.id);
    const tvgIds = distinct([tvgId, ...(station?.tvgIds || []), ...group.flatMap(entry => {
      const id = clean(entry.tvgId || entry.id);
      return [id, id.split('@', 1)[0]];
    })]);
    const aliases = distinct([
      ...(station?.aliases || []),
      ...group.map(entry => entry.identityKey ? `tvg:${entry.identityKey}` : ''),
      ...group.map(entry => entry.nameKey ? `name:${entry.countries[0] || '-'}:${entry.nameKey}` : ''),
      ...group.map(entry => entry.url ? `url:${hashUrl(entry.url)}` : '')
    ]);
    const streams = new Map();
    for (const entry of group) {
      if (!entry.url) continue;
      const stream = streams.get(entry.url);
      if (!stream) streams.set(entry.url, { url: entry.url, type: clean(entry.type), sourceId: clean(entry.sourceId) });
      else if (!stream.sourceId && entry.sourceId) stream.sourceId = clean(entry.sourceId);
    }
    const channel = {
      id: aliases[0], aliases,
      name: selected.name,
      logo: group.map(entry => safeUrl(entry.logo)).find(Boolean) || '',
      country: countries.includes('DO') ? 'DO' : countries[0] || '', countries,
      language: languages[0] || '', languages,
      categories: distinct(group.flatMap(entry => (entry.categories || []).map(category => clean(category, 80)))),
      tvgId, tvgIds,
      streams: [...streams.values()]
    };
    if (station) Object.assign(channel, { fixed: true, lineupGroup: 'fixed', number: station.number });
    else if (fixed.stations.size) {
      const national = importantDRRank(channel);
      const cable = national < 0 ? cableBrandRank(channel) : -1;
      Object.assign(channel, { fixed: false, lineupGroup: national >= 0 ? 'rd' : cable >= 0 ? 'cable' : '', brandPriority: Math.max(national, cable, 0) });
    }
    return channel;
  });
  if (fixed.stations.size) migrateFixedNumbers(channels, numbers);
  const history = new Map();
  const historicalAliases = new Map();
  let next = 0;
  for (const alias of Object.keys(numbers)) {
    const number = numbers[alias];
    if (!validNumber(number)) continue;
    history.set(alias, history.size);
    if (!historicalAliases.has(number)) historicalAliases.set(number, []);
    historicalAliases.get(number).push(alias);
    next = Math.max(next, number + 1);
  }
  const byHistory = (a, b) => (history.get(a) ?? Infinity) - (history.get(b) ?? Infinity);
  for (const channel of channels) {
    channel.aliases.sort(byHistory);
    if (!channel.fixed) channel.id = channel.aliases[0];
  }
  const comparePriority = fixed.stations.size ? compareLineup : compareDefault;
  channels.sort((a, b) => byHistory(a.id, b.id) || comparePriority(a, b));
  const currentAliases = new Set(channels.flatMap(channel => channel.aliases));
  const assigned = new Map(channels.filter(channel => channel.fixed).map(channel => [channel.number, channel]));
  for (const channel of channels) {
    if (channel.fixed) continue;
    const identity = channel.aliases.find(alias => history.has(alias) && !assigned.has(numbers[alias]));
    channel.number = identity ? numbers[identity] : next++;
    assigned.set(channel.number, channel);
    for (const alias of channel.aliases) {
      if (!history.has(alias) || assigned.has(numbers[alias]) && assigned.get(numbers[alias]) !== channel) {
        numbers[alias] = channel.number;
      }
    }
  }
  for (const channel of channels) {
    const previouslyAssigned = new Set(channel.aliases.map(alias => numbers[alias]));
    for (const number of previouslyAssigned) {
      if (assigned.has(number) && assigned.get(number) !== channel) continue;
      for (const alias of historicalAliases.get(number) || []) {
        if (!currentAliases.has(alias)) {
          channel.aliases.push(alias);
          currentAliases.add(alias);
        }
      }
    }
    channel.aliases.sort(byHistory);
    if (!channel.fixed) channel.id = channel.aliases[0];
  }
  return channels.sort((a, b) => a.number - b.number);
}

export async function buildCatalogAsync(entries, numbers = Object.create(null), { signal, fixedLineup = [] } = {}) {
  if (signal?.aborted) throw abortError(signal);
  const snapshot = { ...numbers };
  const build = () => ({ channels: buildCatalog(entries, snapshot, { fixedLineup }), numbers: snapshot });
  const result = entries.length < 2000 ? build() :
    await inCatalogWorker({ operation: 'build', entries, numbers: snapshot, options: { fixedLineup } }, signal, build);
  if (signal?.aborted) throw abortError(signal);
  Object.assign(numbers, result.numbers);
  return result.channels;
}

export function orderedChannels(channels, profile = {}, { includeHidden = false } = {}) {
  const hidden = new Set(profile.hidden || []);
  const positions = new Map((profile.order || []).map((id, index) => [id, index]));
  const matches = channel => channel.aliases || [channel.id];
  const position = channel => matches(channel).reduce((rank, id) => Math.min(rank, positions.get(id) ?? Infinity), Infinity);
  const hasLineup = channels.some(channel => typeof channel.lineupGroup === 'string');
  return channels.filter(channel => includeHidden || channel.fixed || !matches(channel).some(id => hidden.has(id)))
    .map(channel => ({ channel, position: position(channel) }))
    .sort((a, b) => {
      const left = a.channel;
      const right = b.channel;
      if (left.fixed && right.fixed) return left.number - right.number;
      if (hasLineup) {
        return lineupRank(left) - lineupRank(right) || a.position - b.position || compareLineup(left, right) || left.number - right.number;
      }
      return a.position - b.position || compareDefault(left, right) || left.number - right.number;
    })
    .map(item => item.channel);
}

const CACHE_KEY = 'tv-pro:availability:v1';
const CACHE_LIMIT = 360;
const QUEUE_LIMIT = 96;
const MEDIUM_EXTENSION = /\.(?:mp4|m4v|webm|mp3|m4a|aac|ts|ogg|ogv|opus)$/i;
const TTL = {
  playing: 6 * 60 * 60 * 1000,
  reachable: 45 * 60 * 1000,
  manifest: 20 * 60 * 1000,
  down: 8 * 60 * 1000,
  format: 15 * 60 * 1000,
  region: 45 * 60 * 1000,
  restricted: 15 * 60 * 1000,
  timeout: 3 * 60 * 1000,
  network: 60 * 1000,
  unverified: 2 * 60 * 1000,
  unreachable: 4 * 60 * 1000,
  'rate-limited': 5 * 60 * 1000
};
const SCORE = {
  playing: 4, reachable: 3, manifest: 2, unverified: 1, network: 0,
  timeout: 0, unreachable: 0, 'rate-limited': 0, down: -1, format: -2, restricted: -2, region: -2
};

const isAvailabilityState = state => Object.prototype.hasOwnProperty.call(TTL, state);

function getHlsTargets(text, baseUrl) {
  if (!/^#EXTM3U(?:\s|$)/.test(getHeader(text))) return null;
  const variants = [];
  let pendingVariant;
  let pendingMedia = false;
  let lastSegment = '';
  let partialSegment = '';
  let initialization = '';
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = Number(readAttributes(line.slice(18)).bandwidth) || Infinity;
      continue;
    }
    if (line.startsWith('#EXTINF:')) pendingMedia = true;
    if (line.startsWith('#EXT-X-PART:')) partialSegment = safeUrl(readAttributes(line.slice(12)).uri, baseUrl);
    if (line.startsWith('#EXT-X-MAP:')) initialization = safeUrl(readAttributes(line.slice(11)).uri, baseUrl);
    if (line.startsWith('#')) continue;
    const url = safeUrl(line, baseUrl);
    if (url && pendingVariant !== undefined) variants.push({ url, bandwidth: pendingVariant });
    if (url && pendingMedia) lastSegment = url;
    pendingVariant = undefined;
    pendingMedia = false;
  }
  variants.sort((a, b) => a.bandwidth - b.bandwidth);
  return { variants, segment: lastSegment || partialSegment, initialization };
}

function isMedia(bytes) {
  const starts = (...magic) => magic.every((byte, index) => bytes[index] === byte);
  if (starts(0x47) && (bytes[188] === 0x47 || bytes[192] === 0x47 || bytes[204] === 0x47)) return true;
  if (starts(0x1a, 0x45, 0xdf, 0xa3) || starts(0x4f, 0x67, 0x67, 0x53) || starts(0x49, 0x44, 0x33)) return true;
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;
  const box = String.fromCharCode(...bytes.subarray(4, 8));
  return /^(?:ftyp|styp|moof|moov|sidx|emsg)$/.test(box);
}

async function readSample(response) {
  if (!response.body?.getReader) {
    const size = Number(response.headers.get('content-length'));
    if (!(size > 0 && size <= SAMPLE_SIZE)) return new Uint8Array();
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const sample = new Uint8Array(SAMPLE_SIZE);
  let received = 0;
  try {
    while (received < sample.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, sample.length - received);
      sample.set(chunk, received);
      received += chunk.length;
      if (received >= 208 && isMedia(sample.subarray(0, received))) break;
    }
    return sample.subarray(0, received);
  } finally {
    reader.cancel().catch(() => {});
  }
}

function responseState(response) {
  if (response.status === 451) return { state: 'region' };
  if (response.status === 401 || response.status === 403) return { state: 'restricted' };
  if (response.status === 429) {
    const value = response.headers.get('retry-after');
    const seconds = Number(value);
    const duration = value && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    return { state: 'rate-limited', retryIn: duration > 0 ? Math.min(duration, 60 * 60 * 1000) : TTL['rate-limited'] };
  }
  return { state: 'down', status: response.status };
}

async function testStream(url, signal, hostCooldowns) {
  async function request(address, range) {
    const host = new URL(address).host;
    const cooldown = (hostCooldowns.get(host) || 0) - Date.now();
    if (cooldown > 0) return { failure: { state: 'rate-limited', retryIn: cooldown } };
    const response = await fetch(address, {
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
      headers: range ? { Range: `bytes=0-${SAMPLE_SIZE - 1}` } : undefined
    });
    if (response.ok) return { response };
    cancelBody(response.body);
    const failure = responseState(response);
    if (failure.retryIn) hostCooldowns.set(host, Date.now() + failure.retryIn);
    return { failure };
  }

  if (globalThis.navigator?.onLine === false) return { state: 'network' };
  const direct = MEDIUM_EXTENSION.test(new URL(url).pathname);
  let address = url;
  for (let depth = 0; depth < 3; depth += 1) {
    const { response, failure } = await request(address, direct);
    if (failure) return failure;
    const mime = (response.headers.get('content-type') || '').toLowerCase();
    if (direct || /^(?:audio|video)\//.test(mime) && !mime.includes('mpegurl')) {
      const media = isMedia(await readSample(response));
      return { state: media ? 'reachable' : 'format' };
    }
    if (!response.body?.getReader && !Number(response.headers.get('content-length'))) return { state: 'unverified' };
    const targets = getHlsTargets(await readTextLimited(response, MANIFEST_LIMIT), safeUrl(response.url || address));
    if (!targets) return { state: 'format' };
    if (targets.variants.length) {
      address = targets.variants[0].url;
      continue;
    }
    if (!targets.segment) return { state: targets.initialization ? 'manifest' : 'format' };
    const sample = await request(targets.segment, true);
    if (sample.failure) return sample.failure;
    const bytes = await readSample(sample.response);
    if (isMedia(bytes)) return { state: 'reachable' };
    const prefix = new TextDecoder().decode(bytes.subarray(0, 128)).trimStart();
    return { state: /^(?:<!doctype\s+html|<html|<\?xml)/i.test(prefix) ? 'format' : 'manifest' };
  }
  return { state: 'manifest' };
}

function loadAvailability() {
  try {
    const values = JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) || '[]');
    if (!Array.isArray(values)) return new Map();
    return new Map(values.slice(-CACHE_LIMIT).filter(item => Array.isArray(item) &&
      typeof item[0] === 'string' && isAvailabilityState(item[1]?.state) && Number.isFinite(item[1]?.expires) &&
      item[1].expires > Date.now()));
  } catch {
    return new Map();
  }
}

export class Availability {
  constructor({ timeout = 7000, concurrency = 3, onChange } = {}) {
    this.onChange = onChange;
    this.cache = loadAvailability();
    this.jobs = new Map();
    this.activeHosts = new Set();
    this.hostCooldowns = new Map();
    this.queue = [];
    this.configure({ timeout, concurrency });
  }

  configure({ timeout = this.timeout, concurrency = this.concurrency } = {}) {
    this.timeout = Math.min(30000, Math.max(1000, Number(timeout) || 7000));
    this.concurrency = Math.floor(Math.min(6, Math.max(1, Number(concurrency) || 3)));
    this.schedule();
  }

  get(url) {
    const safe = safeUrl(url);
    if (!safe) return undefined;
    const cached = this.cache.get(hashUrl(safe));
    return cached?.expires > Date.now() ? cached : undefined;
  }

  remember(url, result) {
    const previous = this.get(url);
    const time = Date.now();
    const value = {
      ...result, time, expires: time + (result.retryIn || TTL[result.state]),
      successes: Math.min(20, (previous?.successes || 0) + Number(result.state === 'playing' || result.state === 'reachable'))
    };
    const key = hashUrl(url);
    this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify([...this.cache]));
      } catch {
        // Private browsing and storage limits can prevent persistence.
      }
    }, 500);
    this.onChange?.(url, value);
    return value;
  }

  mark(url, state) {
    const safe = safeUrl(url);
    if (!safe || !isAvailabilityState(state)) return undefined;
    const value = this.remember(safe, { state });
    const job = this.jobs.get(safe);
    if (job) {
      job.resolve(value);
      job.controller?.abort();
      this.jobs.delete(safe);
      this.queue = this.queue.filter(queued => queued !== job);
    }
    return value;
  }

  rank(streams) {
    return streams.map(stream => ({ stream, result: this.get(stream.url) })).sort((a, b) =>
      (SCORE[b.result?.state || 'unverified'] ?? 1) - (SCORE[a.result?.state || 'unverified'] ?? 1) ||
      (b.result?.successes || 0) - (a.result?.successes || 0)).map(({ stream }) => stream);
  }

  probe(url, priority = 0) {
    const safe = safeUrl(url);
    if (!safe) return Promise.resolve({ state: 'format' });
    const cached = this.get(safe);
    if (cached) return Promise.resolve(cached);
    const previous = this.jobs.get(safe);
    if (previous) {
      previous.priority = Math.max(previous.priority, priority);
      return previous.promise;
    }
    if (this.queue.length >= QUEUE_LIMIT) {
      const lowest = this.queue.reduce((first, job) => job.priority <= first.priority ? job : first);
      if (lowest.priority >= priority) return Promise.resolve({ state: 'canceled' });
      this.queue.splice(this.queue.indexOf(lowest), 1);
      this.jobs.delete(lowest.url);
      lowest.resolve({ state: 'canceled' });
    }
    const job = { url: safe, host: new URL(safe).host, priority };
    job.promise = new Promise(resolve => { job.resolve = resolve; });
    this.jobs.set(safe, job);
    this.queue.push(job);
    this.schedule();
    return job.promise;
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    Promise.resolve().then(() => {
      this.scheduled = false;
      this.queue.sort((a, b) => b.priority - a.priority);
      while (this.activeHosts.size < this.concurrency) {
        const available = this.queue.findIndex(job => !this.activeHosts.has(job.host));
        if (available < 0) break;
        const [job] = this.queue.splice(available, 1);
        this.run(job);
      }
    });
  }

  async run(job) {
    this.activeHosts.add(job.host);
    job.controller = new AbortController();
    const timer = setTimeout(() => job.controller.abort(), this.timeout);
    let result;
    try {
      result = await testStream(job.url, job.controller.signal, this.hostCooldowns);
    } catch (error) {
      if (job.controller.signal.aborted) result = { state: 'timeout' };
      else if (globalThis.navigator?.onLine === false) result = { state: 'network' };
      else if (error instanceof RangeError) result = { state: 'format' };
      else result = { state: 'unreachable' };
    } finally {
      clearTimeout(timer);
      this.activeHosts.delete(job.host);
      if (this.jobs.get(job.url) === job) {
        this.jobs.delete(job.url);
        job.resolve(this.remember(job.url, result));
      }
      this.schedule();
    }
  }

  clear() {
    for (const job of this.jobs.values()) {
      job.controller?.abort();
      job.resolve({ state: 'canceled' });
    }
    this.jobs.clear();
    this.queue.length = 0;
  }
}

if (typeof document === 'undefined' && typeof globalThis.postMessage === 'function') {
  globalThis.addEventListener('message', ({ data }) => {
    try {
      const { operation, entries, numbers } = data;
      const result = operation === 'parse' ? parseM3U(data.text, data.options) :
        { channels: buildCatalog(entries, numbers, data.options), numbers };
      globalThis.postMessage({ result });
    } catch (error) {
      globalThis.postMessage({ error: error.message });
    }
  });
}
