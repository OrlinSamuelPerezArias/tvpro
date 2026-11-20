import { Availability, buildCatalogAsync, lineupRank, orderedChannels, safeUrl } from './catalog.js';
import { Guide } from './guide.js';
import { fixedLineup, lineupLabels } from './lineup.js';
import { Player } from './player.js';
import { checkPin, cleanSource, cleanText, makePin, newId, newProfile, readPreferences, savePreferences, sourcePresets, validatePreferences } from './preferences.js';
import { focusable, moveFocus, registerRemote, remoteAction } from './remote.js';
import { renderChannelSettings, renderSettings } from './settings.js';
import { readFile, Sources } from './source-storage.js';

const $ = id => document.getElementById(id);
const video = $('video');
const panel = $('panel');
const hud = $('hud');
const viewport = $('channel-viewport');
const list = $('channel-list');
const channelControls = $('channels-view');
const views = { channels: channelControls, options: $('options-view'), settings: $('settings-view'), manage: $('settings-view'), tracks: $('tracks-view'), guide: $('guide-view'), pin: $('pin-view') };
const titles = { channels: 'Canales', options: 'Más opciones', settings: 'Configuración', manage: 'Opciones del canal', tracks: 'Audio y calidad', guide: 'Guía de programación', pin: 'Canal o acción restringida' };
const countries = displayNames('region');
const languages = displayNames('language');
const registeredKeys = registerRemote();
const sources = new Sources();
const guide = new Guide();
const availability = new Availability({ onChange: () => queueRows() });
const player = new Player(video, { onStatus: renderPlayback, onTracks: renderTracks, onStreamResult: (url, status) => availability.mark(url, status) });
const CHANNEL_LIST_CODE = '1111';

let prefs = readPreferences();
let profile = prefs.profiles.find(item => item.id === prefs.active);
let channels = [];
let channelById = new Map();
let channelByNumber = new Map();
let categories = [];
let rows = [];
let rowsOnScreen = new Map();
let selection = 0;
let current;
let previous = '';
let view = '';
let returnToOptions = false;
let managedChannel;
let returnFocus;
let pinTask;
let pinFailures = 0;
let pinWait = 0;
let guideRevision = 0;
let guideChannel;
let digitBuffer = '';
let digitTimer;
let hudTimer;
let toastTimer;
let probeTimer;
let rowFrame;
let resizeTimer;
let restoring = true;
let startRequested = false;
let storageWarning = false;
let lastAutoAttempt = 0;
let probeBudget = [];
let catalogBuild;
let startupFullscreen;

const statusText = {
  playing: 'Reproducción confirmada', reachable: 'Muestra de señal recibida', manifest: 'Lista HLS sin confirmar',
  down: 'Servidor sin señal', region: 'Restricción legal o regional', restricted: 'Acceso restringido', timeout: 'Sin respuesta',
  network: 'Error de red o CORS', unreachable: 'Red o CORS', format: 'Formato sin confirmar',
  'rate-limited': 'Límite del servidor', unverified: 'No verificada'
};

function displayNames(type) {
  try { return new Intl.DisplayNames(['es'], { type }); } catch { return null; }
}

function labelFor(code, names) {
  try { return names?.of(code) || code; } catch { return code; }
}

function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function refs(channel) { return [channel.id, ...(channel.aliases || [])]; }
function hasChannel(values, channel) { return Boolean(channel && refs(channel).some(id => values.includes(id))); }
function favorite(channel) { return hasChannel(profile.favorites, channel); }
function hidden(channel) { return !channel?.fixed && hasChannel(profile.hidden, channel); }

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 3800);
}

function persist() {
  if (!savePreferences(prefs) && !storageWarning) {
    storageWarning = true;
    toast('El navegador no pudo guardar los ajustes. Se mantienen durante esta sesión.');
  }
}

function applySettings() {
  const { playback, appearance } = profile;
  document.body.dataset.lowPower = String(playback.lowPower);
  document.body.dataset.uiSize = appearance.scale;
  document.body.dataset.panelPosition = appearance.position;
  document.body.dataset.fit = appearance.fit;
  player.configure(playback);
  availability.configure({ timeout: prefs.probeTimeout, concurrency: playback.lowPower ? 1 : 2 });
  if (!prefs.probeEnabled || playback.lowPower) availability.clear();
  updateMute();
  queueRows();
}

function notifyRefresh() {
  renderWelcome();
  if (view === 'channels') updateCount();
  if (view !== 'settings') return;
  for (const label of panel.querySelectorAll('[data-source-status]')) {
    label.textContent = sources.status.get(label.dataset.sourceStatus) || 'Pendiente';
  }
  const refresh = panel.querySelector('[data-source-refresh]');
  if (refresh) {
    refresh.textContent = sources.updating ? 'Actualizando…' : 'Actualizar listas';
    refresh.setAttribute('aria-busy', String(sources.updating));
    refresh.disabled = sources.updating;
  }
}

async function updateSources(force = false) {
  const listBefore = prefs.sources;
  let dirty = false;
  let progressive;
  if (!force) lastAutoAttempt = Date.now();
  await sources.refresh(listBefore, { force, hours: prefs.refreshHours, onUpdate: updated => {
    dirty ||= updated;
    if (updated && !progressive) {
      // Combine nearby responses and make the first useful list available during a slow refresh.
      progressive = setTimeout(() => {
        progressive = undefined;
        if (dirty && prefs.sources === listBefore) {
          dirty = false;
          run(rebuildCatalog);
        }
      }, 140);
    }
    notifyRefresh();
  } });
  clearTimeout(progressive);
  if (dirty && prefs.sources === listBefore) await rebuildCatalog();
  if (prefs.sources === listBefore) {
    if (startRequested && !restoring && !sources.updating) startPlayback(false);
    notifyRefresh();
  }
}

async function rebuildCatalog() {
  catalogBuild?.abort();
  const controller = new AbortController();
  catalogBuild = controller;
  const target = prefs;
  const numbers = Object.assign(Object.create(null), prefs.numbers);
  let next;
  try { next = await buildCatalogAsync(sources.cachedEntries(prefs.sources), numbers, { signal: controller.signal, fixedLineup }); }
  catch (error) { if (controller.signal.aborted) return; throw error; }
  if (controller.signal.aborted || target !== prefs) return;
  prefs.numbers = numbers;
  channels = next;
  channelById = new Map();
  for (const channel of channels) for (const id of refs(channel)) channelById.set(id, channel);
  channelByNumber = new Map(channels.map(channel => [channel.number, channel]));
  categories = [...new Set(channels.flatMap(channel => channel.categories))].sort((a, b) => a.localeCompare(b, 'es'));
  persist();
  if (view === 'channels') {
    updateFilters();
    filterRows();
  }
  renderWelcome();
  if (startRequested && !current && !view && channels.length) startPlayback(false);
}

function renderWelcome() {
  $('welcome').hidden = Boolean(current);
  const status = $('welcome-text');
  if (navigator.onLine === false) status.textContent = 'Sin conexión a la red.';
  else if (channels.length) status.textContent = '';
  else if (sources.updating || restoring) status.textContent = 'Cargando canales…';
  else status.textContent = 'Añade una fuente IPTV o importa una lista M3U.';
  status.hidden = !status.textContent;
}

function startPlayback(gesture = true) {
  if (gesture) requestStartupFullscreen();
  const visible = orderedChannels(channels, profile);
  const last = profile.playback.resume && channelById.get(profile.last);
  const first = last && !hidden(last) && !requiresPin(last) ? last : visible.find(channel => !requiresPin(channel)) || visible[0];
  if (first) {
    startRequested = false;
    readyToTune(first, gesture);
  } else if (restoring || sources.updating) startRequested = true;
  else openPanel(channels.length ? 'channels' : 'settings');
}

function changeProfile(id) {
  runProtected(() => {
    const nextProfile = prefs.profiles.find(item => item.id === id);
    if (!nextProfile || nextProfile === profile) return;
    restoring = false;
    current = undefined;
    previous = '';
    player.stop();
    hideHud();
    profile = nextProfile;
    prefs.active = id;
    pinFailures = pinWait = 0;
    applySettings();
    persist();
    closePanel();
    renderWelcome();
    $('welcome-start').focus();
    toast(`Perfil ${profile.name}`);
  });
}

function toggleEntry(key, channel) {
  const present = hasChannel(profile[key], channel);
  const keys = new Set(refs(channel));
  profile[key] = profile[key].filter(id => !keys.has(id));
  if (!present) profile[key].push(channel.id);
  persist();
  return !present;
}

function updateMute() {
  const button = $('action-mute');
  button.textContent = video.muted ? 'Activar sonido' : 'Silenciar';
  button.setAttribute('aria-pressed', String(video.muted));
}

function mute() {
  if (!current) return;
  const muted = player.toggleMute();
  profile.playback.muted = muted;
  persist();
  updateMute();
  toast(muted ? 'Sonido silenciado' : 'Sonido activado');
}

function volume(amount) {
  if (!current) return;
  activatePlayback();
  const before = video.volume;
  const desired = Math.max(0, Math.min(1, Math.round((before + amount) * 100) / 100));
  const result = player.setVolume(desired);
  if (desired !== before && Math.abs(desired - result) > 0.01) {
    toast('Ajusta el volumen en el televisor.');
    return;
  }
  profile.playback.volume = result;
  persist();
  toast(`Volumen ${Math.round(result * 100)} %`);
}

function requiresPin(channel) {
  return Boolean(profile.pin && channel.categories.some(category => profile.blockedCategories.includes(category)));
}

function readyToTune(channel, gesture = true) {
  if (requiresPin(channel)) runProtected(() => tune(channel, true), 'Introduce el PIN para ver este canal.');
  else tune(channel, gesture);
}

function tune(channel, gesture = false) {
  if (!channel) return;
  restoring = false;
  closePanel({ focus: false });
  const changed = !hasChannel(refs(channel), current);
  if (changed && current) previous = current.id;
  current = channel;
  renderWelcome();
  if (changed || ['no-signal', 'ended'].includes(player.status?.state)) {
    player.tune(channel, profile.playback, availability.rank(channel.streams), { gesture });
  } else if (gesture) activatePlayback();
  if (!['autoplay', 'no-signal', 'ended'].includes(player.status?.state) && document.activeElement !== video) video.focus({ preventScroll: true });
  showHud();
}

function jump(step) {
  const ordered = orderedChannels(channels, profile);
  if (!ordered.length) { openPanel('channels'); return; }
  const selected = ordered.findIndex(item => hasChannel(refs(item), current));
  const index = selected < 0 ? (step > 0 ? 0 : ordered.length - 1) : (selected + step + ordered.length) % ordered.length;
  readyToTune(ordered[index]);
}

function jumpBack() {
  const fallback = profile.recent.find(id => id !== current?.id && channelById.has(id));
  const channel = channelById.get(previous) || channelById.get(fallback);
  if (channel && !hidden(channel)) readyToTune(channel);
  else toast('No hay un canal anterior disponible.');
}

function resume() { player.resume({ sound: !profile.playback.muted }); }

function activatePlayback() {
  const status = player.status;
  if (status.state === 'autoplay' || (status.soundBlocked && !profile.playback.muted)) resume();
}

function retryChannel() {
  if (!current) return;
  const latest = channelById.get(current.id);
  const same = latest && latest.streams.length === current.streams.length && latest.streams.every((stream, index) => stream.url === current.streams[index].url);
  if (latest && !same) {
    current = latest;
    player.tune(latest, profile.playback, availability.rank(latest.streams), { gesture: true });
  } else resume();
}

function renderPlayback(status) {
  const { state, message, channel, soundBlocked } = status;
  const element = $('playback-state');
  element.dataset.state = state;
  const blockedSound = state === 'playing' && soundBlocked && !profile.playback.muted;
  const focusedAction = element.contains(document.activeElement);
  element.hidden = !current || state === 'idle' || (state === 'playing' && !blockedSound);
  $('playback-message').textContent = blockedSound ? 'El video se inició en silencio.' : message || '';
  const resumeButton = $('playback-resume');
  resumeButton.hidden = state !== 'autoplay' && !blockedSound;
  resumeButton.textContent = blockedSound ? 'Activar sonido' : 'Reproducir';
  $('playback-retry').hidden = state !== 'no-signal' && state !== 'ended';
  if (!view && (focusedAction || ['autoplay', 'no-signal', 'ended'].includes(state))) {
    (resumeButton.hidden ? ($('playback-retry').hidden ? video : $('playback-retry')) : resumeButton).focus({ preventScroll: true });
  }
  if (state === 'playing' && current && channel?.id === current.id && profile.last !== current.id) {
    const keys = new Set(refs(current));
    profile.last = current.id;
    profile.recent = [current.id, ...profile.recent.filter(id => !keys.has(id))].slice(0, 20);
    persist();
  }
  if (!hud.hidden) updateHud();
  updateMute();
  queueRows();
}

function renderTracks(tracks = player.tracks) {
  if (!tracks) return;
  const { qualities, audios, quality, audio } = tracks;
  const active = qualities.find(item => item.index === tracks.activeQuality);
  const auto = active ? `Automática · ${active.label}` : 'Automática';
  const qualitySelect = $('quality-select');
  const audioSelect = $('audio-select');
  fillOptions(qualitySelect, [new Option(auto, '-1'), ...qualities.map(item => new Option(item.label, item.index))], String(quality));
  fillOptions(audioSelect, audios.length ? audios.map(item => new Option(item.label, item.index)) : [new Option('Predeterminada', '-1')], String(audio));
  qualitySelect.disabled = !qualities.length;
  audioSelect.disabled = !audios.length;
}

function updateHud() {
  if (!current) return;
  $('hud-number').textContent = String(current.number);
  $('hud-name').textContent = current.name;
  const status = player.status?.state === 'playing' ? 'Reproduciendo' : player.status?.message;
  $('hud-detail').textContent = [status, navigator.onLine === false ? 'Sin conexión' : '', lineupLabels[current.lineupGroup] || current.categories[0], labelFor(current.country, countries)].filter(Boolean).join(' · ');
  const hudLogo = $('hud-logo');
  if (hudLogo.dataset.url !== current.logo) {
    hudLogo.dataset.url = current.logo || '';
    if (current.logo) hudLogo.src = current.logo;
    else hudLogo.removeAttribute('src');
    hudLogo.hidden = !current.logo;
  }
  const active = guide.forChannel(current, guideUrls(current)).find(item => item.start <= Date.now());
  $('hud-program').hidden = !active;
  $('hud-program').textContent = active?.title || '';
  const star = $('action-star');
  const starred = favorite(current);
  star.textContent = starred ? 'Quitar de favoritos' : 'Añadir a favoritos';
  star.setAttribute('aria-pressed', String(starred));
}

function showHud() {
  if (!current || view) return;
  updateHud();
  hud.hidden = false;
  clearTimeout(hudTimer);
  hudTimer = setTimeout(hideHud, hud.contains(document.activeElement) ? 12000 : 4800);
}

function hideHud() {
  clearTimeout(hudTimer);
  if (hud.contains(document.activeElement)) video.focus({ preventScroll: true });
  hud.hidden = true;
}

function fillOptions(select, options, desired = select.value) {
  select.replaceChildren(...options);
  if (options.some(option => option.value === desired)) select.value = desired;
}

function updateFilters() {
  const favoriteCategories = new Set(profile.favoriteCategories);
  const ordered = [...categories].sort((a, b) => Number(favoriteCategories.has(b)) - Number(favoriteCategories.has(a)) || a.localeCompare(b, 'es'));
  fillOptions($('channel-category'), [new Option('Todas las categorías', ''), ...ordered.map(value => new Option(favoriteCategories.has(value) ? `★ ${value}` : value, value))]);
  for (const [key, aggregate, selector, heading, names] of [
    ['country', 'countries', 'channel-country', 'Todos los países', countries],
    ['language', 'languages', 'channel-language', 'Todos los idiomas', languages]
  ]) {
    const values = [...new Set(channels.flatMap(item => item[aggregate] || [item[key]]).filter(Boolean))];
    const labels = values.map(code => [code, labelFor(code, names)]).sort((a, b) => a[1].localeCompare(b[1], 'es'));
    fillOptions($(selector), [new Option(heading, ''), ...labels.map(([code, label]) => new Option(label, code))]);
  }
}

function filterRows(targetId = rows[selection]?.id) {
  const filter = $('channel-filter').value;
  const search = normalize($('channel-search').value);
  const category = $('channel-category').value;
  const country = $('channel-country').value;
  const language = $('channel-language').value;
  let ordered;
  if (filter === 'recent') ordered = [...new Set(profile.recent.map(id => channelById.get(id)).filter(item => item && !hidden(item)))];
  else if (filter === 'hidden') ordered = orderedChannels(channels, { ...profile, hidden: [] }).filter(hidden);
  else ordered = orderedChannels(channels, profile);
  rows = ordered.filter(channel => (!search || normalize(channel.name).includes(search) || String(channel.number).startsWith(search)) &&
    (!category || channel.categories.includes(category)) && (!country || (channel.countries || [channel.country]).includes(country)) &&
    (!language || (channel.languages || [channel.language]).includes(language)) && (filter !== 'favorites' || favorite(channel)) &&
    (!['fixed', 'rd', 'cable'].includes(filter) || channel.lineupGroup === filter));
  const target = channelById.get(targetId);
  selection = Math.max(0, rows.indexOf(target));
  updateCount();
  if (document.activeElement.closest?.('.channel-row') && !rows.length) $('channel-search').focus();
  revealSelection();
  renderRows(document.activeElement.closest?.('.channel-row') != null);
  planProbes();
}

function updateCount() {
  const count = rows.length;
  $('channel-count').textContent = `${count.toLocaleString('es')} de ${channels.length.toLocaleString('es')} canales${sources.updating ? ' · Actualizando…' : ''}`;
  $('channel-options').disabled = !count;
}

function showExtraFilters(show) {
  $('channel-extra-filters').hidden = !show;
  const toggle = $('channel-filter-toggle');
  const active = ['channel-category', 'channel-country', 'channel-language'].filter(id => $(id).value).length;
  toggle.setAttribute('aria-expanded', String(show));
  toggle.textContent = active ? `Filtros (${active})` : 'Filtros';
}

function height() { return Number.parseFloat(getComputedStyle(list).getPropertyValue('--row-height')) || 76; }

function revealSelection() {
  const top = selection * height();
  if (top < viewport.scrollTop) viewport.scrollTop = top;
  else if (top + height() > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + height() - viewport.clientHeight;
}

function queueRows() {
  if (view !== 'channels' || rowFrame) return;
  rowFrame = requestAnimationFrame(() => { rowFrame = undefined; renderRows(); });
}

function channelStatus(channel) {
  if (hasChannel(refs(channel), current) && player.status?.state) {
    const status = player.status.state;
    if (status === 'playing') return ['Reproduciendo', status];
    if (status === 'no-signal') return ['Sin señal', status];
    if (status === 'reconnecting') return ['Reconectando', 'loading'];
    if (status === 'loading') return ['Cargando', status];
  }
  if (!channel.streams.length) return ['Sin señal en las fuentes', 'down'];
  const bestUrl = availability.rank(channel.streams)[0]?.url;
  const state = bestUrl && availability.get(bestUrl)?.state;
  return [statusText[state] || 'No verificada', state || 'unverified'];
}

function makeRow(channel, index) {
  const row = document.createElement('button');
  row.className = 'channel-row';
  row.type = 'button';
  const add = (className, text = '') => {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    row.append(span);
    return span;
  };
  add('channel-number', channel.number);
  const logo = add('channel-logo');
  const fallback = channel.name.split(/\s+/).slice(0, 2).map(part => part.charAt(0).toUpperCase()).join('');
  logo.setAttribute('aria-hidden', 'true');
  logo.textContent = fallback;
  if (channel.logo && !profile.playback.lowPower) {
    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => { logo.textContent = ''; logo.append(image); }, { once: true });
    image.src = channel.logo;
  }
  const text = add('channel-copy');
  text.append(add('channel-name', channel.name), add('channel-meta', [lineupLabels[channel.lineupGroup] || channel.categories[0], labelFor(channel.country, countries)].filter(Boolean).join(' · ')));
  const state = add('channel-state');
  const star = add('channel-star');
  row.addEventListener('focus', () => { if (view === 'channels') { selection = index; queueRows(); } });
  row.addEventListener('click', () => {
    selection = index;
    if (hidden(channel)) openManage(channel);
    else readyToTune(channel);
  });
  row.addEventListener('contextmenu', event => { event.preventDefault(); openManage(channel); });
  return { row, state, star, channel };
}

function renderRows(focusSelected = false) {
  if (view !== 'channels') return;
  const rowHeight = height();
  list.style.height = `${rows.length * rowHeight}px`;
  if (!rows.length) {
    for (const item of rowsOnScreen.values()) item.row.remove();
    rowsOnScreen.clear();
    if (!list.firstElementChild) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      list.append(empty);
    }
    list.firstElementChild.textContent = channels.length ? 'No hay canales para estos filtros.' : 'El catálogo todavía está vacío.';
    return;
  }
  list.querySelector('.empty-state')?.remove();
  const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 2);
  const end = Math.min(rows.length, Math.ceil((viewport.scrollTop + viewport.clientHeight) / rowHeight) + 3);
  const keep = new Set();
  for (let index = start; index < end; index++) keep.add(index);
  if (document.activeElement.closest?.('.channel-row')) keep.add(selection);
  for (const [index, item] of rowsOnScreen) {
    if (keep.has(index) && rows[index] === item.channel) continue;
    item.row.remove();
    rowsOnScreen.delete(index);
  }
  let anchor = list.firstElementChild;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (!rows[index]) continue;
    const channel = rows[index];
    const item = rowsOnScreen.get(index) || makeRow(channel, index);
    rowsOnScreen.set(index, item);
    if (item.row !== anchor) list.insertBefore(item.row, anchor);
    anchor = item.row.nextElementSibling;
    item.row.style.top = `${index * rowHeight}px`;
    item.row.tabIndex = index === selection || (selection < start || selection >= end) && index === start ? 0 : -1;
    item.row.setAttribute('aria-current', hasChannel(refs(channel), current) ? 'true' : 'false');
    const [label, state] = channelStatus(channel);
    item.state.textContent = requiresPin(channel) ? 'Con PIN' : label;
    item.state.dataset.state = state;
    item.star.textContent = favorite(channel) ? '★' : '';
    item.star.setAttribute('aria-label', favorite(channel) ? 'Favorito' : '');
  }
  if (focusSelected) rowsOnScreen.get(selection)?.row.focus({ preventScroll: true });
}

function moveSelection(step, focus = true) {
  if (!rows.length) return;
  selection = Math.max(0, Math.min(rows.length - 1, selection + step));
  revealSelection();
  renderRows(focus);
  planProbes();
}

function planProbes() {
  clearTimeout(probeTimer);
  if (view !== 'channels' || !prefs.probeEnabled || profile.playback.lowPower || navigator.onLine === false || document.hidden) return;
  probeTimer = setTimeout(() => {
    const now = Date.now();
    probeBudget = probeBudget.filter(time => now - time < 60000);
    let left = 12 - probeBudget.length;
    if (left <= 0) return;
    const first = Math.floor(viewport.scrollTop / height());
    const end = Math.ceil((viewport.scrollTop + viewport.clientHeight) / height());
    const candidates = [...new Set([rows[selection], ...rows.slice(first, end).filter(favorite), ...rows.slice(first, end), ...profile.favorites.slice(0, 4).map(id => channelById.get(id))])];
    for (const channel of candidates) {
      if (!channel || hidden(channel) || requiresPin(channel) || hasChannel(refs(channel), current)) continue;
      const url = availability.rank(channel.streams)[0]?.url;
      if (!url || availability.get(url)) continue;
      availability.probe(url, favorite(channel) ? 8 : channel === rows[selection] ? 6 : 2);
      probeBudget.push(now);
      if (--left === 0) break;
    }
  }, 650);
}

function openPanel(next, { filter, keepSelection = false, focus = true } = {}) {
  startRequested = false;
  clearDigits();
  if (!view) returnFocus = document.activeElement;
  if (view === 'guide' && next !== 'guide') { guideRevision++; guide.cancel(); }
  view = next;
  panel.hidden = false;
  panel.dataset.view = next;
  $('panel-title').textContent = titles[next];
  for (const element of new Set(Object.values(views))) element.hidden = element !== views[next];
  if (next === 'channels') {
    if (filter) $('channel-filter').value = filter;
    if (!keepSelection) {
      managedChannel = undefined;
      for (const id of ['channel-search', 'channel-category', 'channel-country', 'channel-language']) $(id).value = '';
      showExtraFilters(false);
    }
    updateFilters();
    const selected = keepSelection ? (managedChannel?.id || rows[selection]?.id) : current?.id;
    filterRows(selected || '');
    if (focus) {
      if (rows.length) renderRows(true);
      else $('channel-search').focus();
    }
  } else if (next === 'options') {
    for (const id of ['action-star', 'action-tracks', 'action-guide', 'action-mute']) $(id).disabled = !current;
    $('action-previous').disabled = !current || !(previous || profile.recent.length > 1);
    updateHud();
    updateMute();
    updateFullscreenButton();
    if (focus) (focusable(views.options)[0] || $('panel-close')).focus();
  } else if (next === 'settings') {
    showSettings();
    if (focus) (focusable(views.settings)[0] || $('panel-close')).focus();
  } else if (next === 'manage') {
    renderManage();
    if (focus) (focusable(views.manage)[0] || $('panel-close')).focus();
  } else if (next === 'tracks') {
    renderTracks();
    if (focus) (focusable(views.tracks)[0] || $('panel-close')).focus();
  } else if (next === 'guide') {
    loadGuide();
    if (focus) $('panel-close').focus();
  } else if (next === 'pin' && focus) $('pin-input').focus();
  hideHud();
  for (const element of [$('welcome'), $('playback-state'), hud]) element.inert = true;
  panel.setAttribute('aria-modal', 'true');
}

function closePanel({ focus = true } = {}) {
  if (!view) return;
  if (view === 'guide') { guideRevision++; guide.cancel(); }
  view = '';
  returnToOptions = false;
  pinTask = undefined;
  panel.hidden = true;
  clearTimeout(probeTimer);
  availability.clear();
  for (const element of [$('welcome'), $('playback-state'), hud]) element.inert = false;
  if (focus) {
    if (!current) (returnFocus && $('welcome').contains(returnFocus) ? returnFocus : $('welcome-start')).focus({ preventScroll: true });
    else if (!$('playback-resume').hidden && !$('playback-state').hidden) $('playback-resume').focus({ preventScroll: true });
    else if (!$('playback-retry').hidden && !$('playback-state').hidden) $('playback-retry').focus({ preventScroll: true });
    else video.focus({ preventScroll: true });
  }
  returnFocus = undefined;
}

function back() {
  if (view === 'pin') cancelPin();
  else if (view === 'manage' || view === 'options') {
    if (view === 'options') managedChannel = undefined;
    openPanel('channels', { keepSelection: true });
  } else if (returnToOptions && view) {
    returnToOptions = false;
    openPanel('options');
  } else if (view) closePanel();
  else if (digitBuffer) clearDigits();
  else if (!hud.hidden) hideHud();
  else startRequested = false;
}

function runProtected(action, message = 'Introduce el PIN del perfil para continuar.') {
  if (!profile.pin) { run(action); return; }
  pinTask = { action, previousView: view, profile };
  $('pin-input').value = '';
  $('pin-message').textContent = message;
  openPanel('pin');
}

function cancelPin() {
  const previousView = pinTask?.previousView;
  pinTask = undefined;
  if (previousView) openPanel(previousView, { keepSelection: true });
  else closePanel();
}

async function submitPin(event) {
  event.preventDefault();
  const task = pinTask;
  if (!task) return;
  if (Date.now() < pinWait) {
    $('pin-message').textContent = `Espera ${Math.ceil((pinWait - Date.now()) / 1000)} segundos.`;
    return;
  }
  const form = $('pin-form');
  const submit = form.querySelector('[type=submit]');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    const correct = await checkPin($('pin-input').value, task.profile.pin);
    if (pinTask !== task || profile !== task.profile) return;
    if (!correct) {
      pinFailures++;
      if (pinFailures >= 5) { pinWait = Date.now() + 30000; pinFailures = 0; }
      $('pin-message').textContent = 'PIN incorrecto.';
      $('pin-input').value = '';
      $('pin-input').focus();
      return;
    }
    pinFailures = pinWait = 0;
    cancelPin();
    await task.action();
  } catch (error) {
    if (view === 'pin') $('pin-message').textContent = error.message;
    else toast(error.message);
  } finally { submit.disabled = false; }
}

function run(action) {
  try { Promise.resolve(action()).catch(error => toast(error.message || 'No se pudo completar la acción.')); }
  catch (error) { toast(error.message || 'No se pudo completar la acción.'); }
}

function guideUrls(channel) { return sources.guideUrls(prefs.sources, (channel?.streams || []).map(stream => stream.sourceId)); }

function guideNote(message) {
  const note = document.createElement('p');
  note.className = 'empty-state';
  note.textContent = message;
  $('guide-content').replaceChildren(note);
}

async function loadGuide() {
  const revision = ++guideRevision;
  const channel = guideChannel || current;
  if (!channel) { guideNote('Elige un canal para consultar su programación.'); return; }
  const urls = guideUrls(channel);
  if (!urls.length) { guideNote('Configura una URL XMLTV en las fuentes para ver la programación.'); return; }
  guideNote('Cargando programación…');
  const loaded = await guide.load(urls);
  if (view !== 'guide' || revision !== guideRevision) return;
  if (!loaded) { guideNote('No se pudo leer la guía XMLTV. Comprueba su URL y sus permisos de acceso.'); return; }
  const programmes = guide.forChannel(channel, urls);
  if (!programmes.length) { guideNote(`No hay programación vigente para ${channel.name}.`); return; }
  const heading = document.createElement('h3');
  heading.textContent = `${channel.number} · ${channel.name}`;
  const date = new Intl.DateTimeFormat('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const now = Date.now();
  const items = programmes.map(programme => {
    const item = document.createElement('article');
    item.className = 'guide-item';
    const time = document.createElement('time');
    time.dateTime = new Date(programme.start).toISOString();
    time.textContent = programme.start <= now ? 'Ahora' : date.format(programme.start);
    const title = document.createElement('strong');
    title.textContent = programme.title;
    item.append(time, title);
    return item;
  });
  $('guide-content').replaceChildren(heading, ...items);
}

function openGuide(channel = current) {
  guideChannel = channel;
  openPanel('guide');
}

function openFromOptions(next) {
  returnToOptions = view === 'options';
  if (next === 'guide') openGuide();
  else openPanel(next);
}

function openManage(channel = rows[selection]) {
  if (!channel) return;
  managedChannel = channel;
  openPanel('manage');
}

function orderChannel(channel, step) {
  if (channel.fixed) return;
  const all = orderedChannels(channels, { ...profile, hidden: [] });
  const index = all.findIndex(item => hasChannel(refs(item), channel));
  if (index < 0) return;
  const group = lineupRank(channel);
  const start = all.findIndex(item => lineupRank(item) === group);
  const end = all.findIndex((item, position) => position > index && lineupRank(item) !== group);
  const last = (end < 0 ? all.length : end) - 1;
  const destination = step === -Infinity ? start : Math.max(start, Math.min(last, index + step));
  if (destination === index) { toast('El canal ya está en ese extremo.'); return; }
  all.splice(destination, 0, all.splice(index, 1)[0]);
  profile.order = all.map(item => item.id);
  persist();
  toast(`Canal ${channel.number} · posición ${destination + 1}`);
}

function renderManage() {
  const channel = managedChannel;
  if (!channel) return;
  renderChannelSettings($('settings-content'), {
    channel, profile, channelHidden: hidden(channel), channelFavorite: favorite(channel), actions: {
      favorite: () => {
        const added = toggleEntry('favorites', channel);
        renderManage();
        focusable(views.manage)[0]?.focus();
        toast(added ? 'Añadido a favoritos.' : 'Quitado de favoritos.');
      },
      hide: () => {
        if (channel.fixed) return;
        const nowHidden = toggleEntry('hidden', channel);
        openPanel('channels', { keepSelection: true });
        toast(nowHidden ? 'Canal oculto.' : 'Canal visible.');
      },
      move: step => orderChannel(channel, step), moveFirst: () => orderChannel(channel, -Infinity),
      back: () => openPanel('channels', { keepSelection: true })
    }
  });
}

function showSettings() {
  renderSettings($('settings-content'), { prefs, profile, sources, categories, actions: settingsActions });
  notifyRefresh();
}

function settingsChanged() {
  persist();
  if (view === 'settings') showSettings();
}

function addSource(source) {
  if (!source) throw new Error('Escribe un nombre y una URL HTTP o HTTPS válidos.');
  if (prefs.sources.length >= 24) throw new Error('Límite de 24 fuentes por instalación.');
  if (prefs.sources.some(item => item.id === source.id || (!source.local && item.url === source.url))) throw new Error('Esa fuente ya está añadida.');
  sources.cancel();
  prefs.sources = [...prefs.sources, source];
  settingsChanged();
}

async function importSettings(file) {
  const text = await readFile(file, 16 * 1024 * 1024, 'El respaldo JSON');
  let imported;
  try { imported = validatePreferences(JSON.parse(text)); }
  catch { throw new Error('El archivo no es un respaldo compatible de TV PRO.'); }
  runProtected(async () => {
    if (!window.confirm('¿Reemplazar los ajustes y perfiles actuales con este respaldo?')) return;
    sources.cancel();
    player.stop();
    current = undefined;
    previous = '';
    prefs = imported;
    profile = prefs.profiles.find(item => item.id === prefs.active);
    pinFailures = pinWait = 0;
    applySettings();
    const activeSources = prefs.sources;
    await sources.restore(activeSources);
    if (activeSources !== prefs.sources) return;
    restoring = true;
    await rebuildCatalog();
    settingsChanged();
    await updateSources();
    restoring = false;
    renderWelcome();
    toast('Respaldo importado.');
  });
}

const settingsActions = {
  switchProfile: id => { if (id !== profile.id) changeProfile(id); },
  addProfile: name => runProtected(() => {
    const cleaned = cleanText(name, 40);
    if (!cleaned) throw new Error('Escribe el nombre del perfil.');
    if (prefs.profiles.length >= 12) throw new Error('Límite de 12 perfiles locales.');
    const added = newProfile(cleaned);
    prefs.profiles.push(added);
    settingsChanged();
    toast(`Perfil ${added.name} creado.`);
  }),
  renameProfile: name => run(() => {
    const cleaned = cleanText(name, 40);
    if (!cleaned) throw new Error('Escribe el nombre del perfil.');
    profile.name = cleaned;
    settingsChanged();
  }),
  deleteProfile: () => runProtected(() => {
    if (prefs.profiles.length < 2 || !window.confirm(`¿Eliminar el perfil ${profile.name} y sus preferencias?`)) return;
    const removed = profile;
    const next = prefs.profiles.find(item => item !== removed);
    removed.pin = null; // The current PIN was already checked by runProtected.
    prefs.profiles = prefs.profiles.filter(item => item !== removed);
    changeProfile(next.id);
  }),
  setSetting: (group, key, value) => {
    const record = group === 'global' ? prefs : profile[group];
    record[key] = value;
    applySettings();
    persist();
  },
  addSource: input => run(() => {
    if (input.epg && !safeUrl(input.epg)) throw new Error('La guía XMLTV necesita una URL HTTP o HTTPS válida.');
    addSource(cleanSource({ ...input, id: newId() }));
    return updateSources();
  }),
  addPreset: id => run(() => { addSource(cleanSource(sourcePresets.find(item => item.id === id))); return updateSources(); }),
  importSource: file => run(async () => {
    if (prefs.sources.length >= 24) throw new Error('Límite de 24 fuentes por instalación.');
    const source = cleanSource({ id: newId(), local: true, name: file.name });
    if (!source) throw new Error('No se pudo identificar el archivo.');
    const saved = await sources.importFile(source, file);
    addSource(source);
    await rebuildCatalog();
    run(updateSources);
    toast(saved ? 'Lista M3U importada.' : 'Lista importada para esta sesión.');
  }),
  removeSource: id => run(async () => {
    sources.cancel();
    prefs.sources = prefs.sources.filter(item => item.id !== id);
    const removal = sources.remove(id);
    await rebuildCatalog();
    settingsChanged();
    await removal;
    run(updateSources);
  }),
  refresh: () => run(async () => { if (!sources.updating) { await updateSources(true); toast('Actualización terminada.'); } }),
  exportPreferences: () => run(() => {
    const blob = new Blob([JSON.stringify(prefs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'tv-pro-preferencias.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }),
  importPreferences: file => run(() => importSettings(file)),
  setPin: pin => runProtected(async () => {
    const owner = profile;
    const encoded = await makePin(pin);
    if (profile !== owner) return;
    owner.pin = encoded;
    settingsChanged();
    toast('PIN guardado.');
  }),
  removePin: () => runProtected(() => {
    profile.pin = null;
    settingsChanged();
    toast('PIN desactivado.');
  }),
  addCategory: (group, category) => {
    const apply = () => {
      if (!category || profile[group].includes(category)) return;
      profile[group].push(category);
      settingsChanged();
    };
    if (group === 'blockedCategories') runProtected(apply);
    else apply();
  },
  removeCategory: (group, category) => {
    const apply = () => {
      profile[group] = profile[group].filter(item => item !== category);
      settingsChanged();
    };
    if (group === 'blockedCategories') runProtected(apply);
    else apply();
  }
};

function clearDigits() {
  clearTimeout(digitTimer);
  digitBuffer = '';
  $('number-entry').hidden = true;
}

function confirmDigits(gesture = false) {
  if (!digitBuffer) return;
  const number = Number(digitBuffer);
  clearDigits();
  const channel = channelByNumber.get(number);
  if (channel && !hidden(channel)) readyToTune(channel, gesture);
  else toast(`El canal ${number} no está disponible.`);
}

function enterDigit(digit, { inList = false, preview = true } = {}) {
  if (inList && digit !== CHANNEL_LIST_CODE[digitBuffer.length]) {
    clearDigits();
    return false;
  }
  if (!digitBuffer && current && !inList) activatePlayback();
  digitBuffer = (digitBuffer + digit).slice(0, 6);
  if (digitBuffer === CHANNEL_LIST_CODE) {
    clearDigits();
    if (inList) closePanel();
    else openPanel('channels', { filter: 'all' });
    return true;
  }
  if (preview) {
    $('number-entry').textContent = digitBuffer;
    $('number-entry').hidden = false;
  }
  clearTimeout(digitTimer);
  const delay = CHANNEL_LIST_CODE.startsWith(digitBuffer) ? 1900 : 1250;
  digitTimer = setTimeout(inList ? clearDigits : confirmDigits, delay);
  return false;
}

function handlePanelKey(event, key, target) {
  const editable = target.matches('input:not([type=checkbox]):not([type=file]),textarea');
  if (view === 'channels' && /^[0-9]$/.test(key)) {
    if (event.repeat) return !editable;
    return enterDigit(key, { inList: true, preview: !editable }) || !editable;
  }
  if (digitBuffer) clearDigits();
  if (view === 'channels' && (key === 'next' || key === 'previous')) {
    if (!event.repeat) moveSelection(key === 'next' ? 1 : -1);
    return true;
  }
  if (key === 'back') {
    if (event.key === 'Backspace' && target.matches('input:not([type=checkbox]):not([type=file]),textarea')) return false;
    back();
    return true;
  }
  if (key === 'ok' && target.id === 'channel-search') { if (rows.length) renderRows(true); return true; }
  if (editable && (key === 'left' || key === 'right' || (key !== 'up' && key !== 'down' && key !== 'ok'))) return false;
  if (key === 'ok') {
    if (editable) {
      if (event.key === 'Enter' || !target.form) return false;
      if (target.form.requestSubmit) target.form.requestSubmit();
      else target.form.querySelector('[type=submit]')?.click();
    } else if (target.tagName === 'SELECT') {
      try { target.showPicker?.(); } catch { /* Use left/right when the platform reserves the picker. */ }
    } else if (target.tagName === 'BUTTON' || target.tagName === 'INPUT') target.click();
    else focusable(panel)[0]?.focus();
    return true;
  }
  if (!['up', 'down', 'left', 'right'].includes(key)) return false;
  if (view === 'channels' && target.closest('.channel-row')) {
    if ((key === 'up' && selection === 0) || key === 'left') $('channel-options').focus();
    else if (key === 'right') openManage();
    else moveSelection(key === 'up' ? -1 : 1);
    return true;
  }
  if (key === 'down' && view === 'channels' && ['channel-options', 'channel-more'].includes(target.id) && rows.length) {
    renderRows(true);
  } else if (target.tagName === 'SELECT' && (key === 'left' || key === 'right') && target.options.length > 1) {
    const index = Math.min(target.options.length - 1, Math.max(0, target.selectedIndex + (key === 'right' ? 1 : -1)));
    if (index !== target.selectedIndex) {
      target.selectedIndex = index;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else moveFocus(panel, target, key);
  } else if (view === 'guide' && (key === 'up' || key === 'down')) {
    views.guide.scrollTop += key === 'up' ? -100 : 100;
  } else moveFocus(panel, target, key);
  return true;
}

function handlePlaybackKey(key, target) {
  if (key === 'back') { back(); return true; }
  if (/^[0-9]$/.test(key)) { enterDigit(key); return true; }
  if (key === 'ok' && digitBuffer) { confirmDigits(true); return true; }
  if (key === 'channels') { openPanel('channels', { filter: 'all' }); return true; }
  if (key === 'favorites') { openPanel('channels', { filter: 'favorites' }); return true; }
  if (key === 'settings') { openPanel('settings'); return true; }
  if (key === 'guide') { openGuide(); return true; }
  if (key === 'last') { clearDigits(); jumpBack(); return true; }
  if (key === 'mute') { mute(); return true; }
  if (key === 'quieter' || key === 'louder') { volume(key === 'louder' ? 0.05 : -0.05); return true; }
  if (key === 'info') {
    if (current) { activatePlayback(); showHud(); }
    else openPanel('channels');
    return true;
  }
  if (key === 'ok') {
    if (target.matches('button') && !$('panel').contains(target)) target.click();
    else if (!current) startPlayback();
    else if (['no-signal', 'ended'].includes(player.status?.state)) retryChannel();
    else {
      activatePlayback();
      showHud();
    }
    return true;
  }
  if (key === 'next' || key === 'previous') { clearDigits(); jump(key === 'next' ? 1 : -1); return true; }
  if (['up', 'down', 'left', 'right'].includes(key)) {
    clearDigits();
    if (!current) moveFocus($('welcome'), target, key);
    else if (key === 'up' || key === 'down') jump(key === 'up' ? 1 : -1);
    else volume(key === 'right' ? 0.05 : -0.05);
    return true;
  }
  return false;
}

document.addEventListener('keydown', event => {
  const target = event.target instanceof Element ? event.target : document.body;
  if (event.key === 'Tab' && view) {
    const focusableItems = focusable(panel);
    if (!focusableItems.length) return;
    if ((event.shiftKey && target === focusableItems[0]) || (!event.shiftKey && target === focusableItems.at(-1)) || !panel.contains(target)) {
      event.preventDefault();
      (event.shiftKey ? focusableItems.at(-1) : focusableItems[0]).focus();
    }
    return;
  }
  const key = remoteAction(event, registeredKeys);
  if (!key) return;
  if (event.repeat && !target.matches('input:not([type=checkbox]):not([type=file]), textarea')) { event.preventDefault(); return; }
  if (view ? handlePanelKey(event, key, target) : handlePlaybackKey(key, target)) event.preventDefault();
});

document.addEventListener('tizenhwkey', event => {
  if (event.keyName === 'back' && (view || current || digitBuffer)) { event.preventDefault(); back(); }
});

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement;
}

async function setFullscreen(enter) {
  const root = document.documentElement;
  if (enter) {
    const request = root.requestFullscreen || root.webkitRequestFullscreen || root.webkitRequestFullScreen;
    if (request) { await request.call(root); return; }
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
    if (exit) { await exit.call(document); return; }
  }
  throw new Error('El navegador controla la pantalla completa.');
}

function requestStartupFullscreen() {
  if (startupFullscreen || fullscreenElement()) return;
  // Request it in the OK handler, while the browser's user activation is still available.
  startupFullscreen = setFullscreen(true).catch(() => {}).finally(() => { startupFullscreen = undefined; });
}

function updateFullscreenButton() {
  $('action-fullscreen').textContent = fullscreenElement() ? 'Salir de pantalla completa' : 'Pantalla completa';
}

function fullscreen() {
  if (!startupFullscreen) run(() => setFullscreen(!fullscreenElement()));
}

for (const [id, action] of Object.entries({
  'welcome-start': () => startPlayback(), 'welcome-sources': () => openPanel('settings'),
  'action-channels': () => openPanel('channels', { filter: 'all' }), 'action-favorites': () => openPanel('channels', { filter: 'favorites' }),
  'action-previous': jumpBack, 'action-tracks': () => openFromOptions('tracks'), 'action-guide': () => openFromOptions('guide'),
  'action-settings': () => openFromOptions('settings'), 'action-mute': mute, 'action-fullscreen': fullscreen,
  'action-star': () => { if (current) { toast(toggleEntry('favorites', current) ? 'Añadido a favoritos.' : 'Quitado de favoritos.'); updateHud(); } },
  'channel-more': () => openPanel('options'), 'channel-filter-toggle': () => showExtraFilters($('channel-extra-filters').hidden),
  'panel-close': back, 'channel-options': () => openManage(), 'pin-cancel': cancelPin,
  'playback-resume': resume, 'playback-retry': retryChannel
})) $(id).addEventListener('click', action);

$('pin-form').addEventListener('submit', submitPin);
$('quality-select').addEventListener('change', event => player.setQuality(Number(event.target.value)));
$('audio-select').addEventListener('change', event => player.setAudio(Number(event.target.value)));
for (const id of ['channel-filter', 'channel-category', 'channel-country', 'channel-language']) $(id).addEventListener('change', () => {
  filterRows('');
  showExtraFilters(!$('channel-extra-filters').hidden);
});
$('channel-search').addEventListener('input', () => filterRows(''));
$('hud-logo').addEventListener('error', event => { event.target.hidden = true; });
video.addEventListener('click', () => {
  if (view) closePanel();
  else if (current) { activatePlayback(); showHud(); }
});
video.addEventListener('volumechange', updateMute);
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
hud.addEventListener('focusin', () => { if (!hud.hidden) showHud(); });
hud.addEventListener('focusout', () => { if (!hud.hidden) setTimeout(() => { if (!hud.hidden) showHud(); }, 0); });
viewport.addEventListener('scroll', () => { queueRows(); planProbes(); }, { passive: true });
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (view === 'channels') { revealSelection(); renderRows(); } }, 120);
});

function connectionChanged() {
  renderWelcome();
  updateHud();
  if (navigator.onLine === false) {
    availability.clear();
    toast('Sin conexión a la red.');
  } else {
    toast('Conexión recuperada.');
    if (prefs.refreshHours) run(updateSources);
    planProbes();
  }
}

window.addEventListener('online', connectionChanged);
window.addEventListener('offline', connectionChanged);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(probeTimer); availability.clear(); }
  else planProbes();
});
window.addEventListener('pagehide', event => {
  if (!event.persisted) { availability.clear(); guide.cancel(); sources.cancel(); catalogBuild?.abort(); player.stop(); }
});
setInterval(() => {
  if (prefs.refreshHours && !document.hidden && navigator.onLine !== false && Date.now() - lastAutoAttempt >= prefs.refreshHours * 3600000) run(updateSources);
}, 300000);

async function start() {
  applySettings();
  renderWelcome();
  $('welcome-start').focus({ preventScroll: true });
  const initialSources = prefs.sources;
  await sources.restore(initialSources);
  if (initialSources === prefs.sources) await rebuildCatalog();
  await updateSources();
  restoring = false;
  if (startRequested) startPlayback(false);
  renderWelcome();
}

run(start);
