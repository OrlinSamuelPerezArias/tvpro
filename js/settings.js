import { pinAvailable, sourcePresets } from './preferences.js';

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function control(element, key) {
  element.dataset.settingsFocus = key;
  return element;
}

function button(label, action, key, { kind = 'secondary', disabled = false, submit = false } = {}) {
  const element = control(node('button', `button-${kind}`, label), key);
  element.type = submit ? 'submit' : 'button';
  element.disabled = disabled;
  if (action) element.addEventListener('click', action);
  return element;
}

function input(key, options = {}) {
  const element = control(document.createElement('input'), key);
  Object.assign(element, options);
  return element;
}

function select(key, options, value, onChange) {
  const element = control(document.createElement('select'), key);
  for (const [optionValue, label] of options) {
    const option = node('option', '', label);
    option.value = String(optionValue);
    element.append(option);
  }
  element.value = String(value);
  if (onChange) element.addEventListener('change', () => onChange(element.value));
  return element;
}

function field(label, element, className = 'field') {
  const wrapper = node('label', className);
  wrapper.append(node('span', '', label), element);
  return wrapper;
}

function toggle(label, key, checked, action) {
  const element = input(key, { type: 'checkbox', checked });
  const wrapper = node('label', 'settings-check');
  wrapper.append(element, node('span', '', label));
  element.addEventListener('change', () => action(element.checked));
  return wrapper;
}

function section(title) {
  const element = node('section', 'settings-section');
  element.append(node('h3', '', title));
  return element;
}

function row(className, ...children) {
  const element = node('div', className);
  element.append(...children);
  return element;
}

function form(action, submit) {
  const element = node('form', 'settings-form');
  element.append(submit);
  element.addEventListener('submit', event => {
    event.preventDefault();
    action();
  });
  return element;
}

function withFile(key, accept, action) {
  const element = input(key, { type: 'file', accept });
  element.addEventListener('change', () => {
    const file = element.files[0];
    element.value = '';
    if (file) action(file);
  });
  return element;
}

function numericOptions(values, current, label) {
  return [...new Set([...values, current])].sort((a, b) => a - b).map(value => [value, label(value)]);
}

const asSeconds = value => `${value / 1000} s`;

function profileSettings(prefs, profile, actions) {
  const group = section('Perfil local');
  const choose = select('profile-picker', prefs.profiles.map(item => [item.id, item.name]), profile.id, actions.switchProfile);
  group.append(field('Perfil activo', choose));

  const name = input('profile-name', { required: true, maxLength: 40, value: profile.name, autocomplete: 'off' });
  const save = button('Guardar nombre', null, 'profile-rename', { submit: true });
  const rename = form(() => actions.renameProfile(name.value), row('settings-actions', save));
  rename.prepend(field('Nombre del perfil', name));

  const newName = input('profile-name-new', { required: true, maxLength: 40, autocomplete: 'off', disabled: prefs.profiles.length >= 12 });
  const add = button('Crear perfil', null, 'profile-add', { submit: true, disabled: newName.disabled });
  const create = form(() => actions.addProfile(newName.value), row('settings-actions', add));
  create.prepend(field('Nombre del nuevo perfil', newName));
  group.append(row('settings-grid settings-profile-forms', rename, create));
  if (prefs.profiles.length > 1) group.append(row('settings-actions', button('Eliminar este perfil', actions.deleteProfile, 'profile-delete', { kind: 'danger' })));
  return group;
}

function sourceBadge(source) {
  if (source.local) return 'Archivo M3U';
  return [new URL(source.url).host, source.country, source.language, source.epg ? 'EPG' : ''].filter(Boolean).join(' · ');
}

function sourceSettings(prefs, sources, actions) {
  const group = section('Fuentes IPTV');
  const refresh = button(sources.updating ? 'Actualizando…' : 'Actualizar listas', actions.refresh, 'source-refresh', { disabled: sources.updating });
  refresh.dataset.sourceRefresh = '';
  group.append(row('settings-actions', refresh));

  if (!prefs.sources.length) group.append(node('p', 'settings-note', 'Agrega una URL o importa un archivo M3U autorizado.'));
  else {
    const list = node('ul', 'source-list');
    for (const source of prefs.sources) {
      const item = node('li', 'source-row');
      const status = node('span', 'source-status', sources.status.get(source.id) || 'Pendiente');
      status.dataset.sourceStatus = source.id;
      const caption = row('source-caption', node('strong', '', source.name), node('span', 'source-meta', sourceBadge(source)), status);
      const remove = button('Quitar', () => actions.removeSource(source.id), `source-remove-${source.id}`, { kind: 'danger' });
      remove.setAttribute('aria-label', `Quitar fuente ${source.name}`);
      item.append(caption, remove);
      list.append(item);
    }
    group.append(list);
  }

  const presets = sourcePresets.filter(preset => !prefs.sources.some(source => source.id === preset.id || source.url === preset.url));
  if (presets.length) {
    const preset = select('source-preset', presets.map(item => [item.id, item.name]), presets[0].id);
    const addPreset = button('Agregar directorio', null, 'source-preset-add', { submit: true });
    const suggestion = form(() => actions.addPreset(preset.value), row('settings-actions', addPreset));
    suggestion.prepend(field('Directorios públicos', preset));
    group.append(suggestion);
  }

  const name = input('source-name', { required: true, maxLength: 80, autocomplete: 'off' });
  const url = input('source-url', { type: 'url', required: true, maxLength: 4096, autocomplete: 'off', placeholder: 'https://…/lista.m3u' });
  const country = input('source-country', { maxLength: 2, pattern: '[A-Za-z]{2}', autocomplete: 'off', placeholder: 'DO' });
  const language = input('source-language', { maxLength: 20, pattern: '[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*', autocomplete: 'off', placeholder: 'es' });
  const epg = input('source-epg', { type: 'url', maxLength: 4096, autocomplete: 'off', placeholder: 'https://…/guia.xml' });
  const addSource = button('Agregar fuente', null, 'source-add', { kind: 'primary', submit: true });
  const add = form(() => actions.addSource({ name: name.value, url: url.value, country: country.value, language: language.value, epg: epg.value }), row('settings-actions', addSource));
  add.prepend(row('settings-grid', field('Nombre de la fuente', name), field('URL M3U / M3U8', url), field('País de la lista (opcional)', country), field('Idioma de la lista (opcional)', language)), field('URL de la guía XMLTV (opcional)', epg));
  const local = withFile('source-import', '.m3u,.m3u8,application/x-mpegurl,application/vnd.apple.mpegurl,audio/x-mpegurl', actions.importSource);
  group.append(add, field('Importar archivo M3U / M3U8', local));
  return group;
}

function playbackSettings(profile, actions) {
  const group = section('Reproducción');
  const settings = profile.playback;
  const set = (key, value) => actions.setSetting('playback', key, value);
  const languages = [['es', 'Español'], ['en', 'Inglés'], ['pt', 'Portugués'], ['fr', 'Francés'], ['it', 'Italiano'], ['de', 'Alemán']];
  if (!languages.some(([code]) => code === settings.audioLanguage)) languages.push([settings.audioLanguage, settings.audioLanguage]);
  const audio = select('playback-language', languages, settings.audioLanguage, value => set('audioLanguage', value));
  const timeouts = numericOptions([4000, 6000, 8000, 10000, 15000, 20000, 30000], settings.timeout, asSeconds);
  const timeout = select('playback-timeout', timeouts, settings.timeout, value => set('timeout', Number(value)));
  const volumes = numericOptions([0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1], settings.volume, value => `${Math.round(value * 100)} %`);
  const volume = select('playback-volume', volumes, settings.volume, value => set('volume', Number(value)));
  group.append(row('settings-grid', field('Idioma de audio preferido', audio), field('Tiempo de espera de la señal', timeout), field('Volumen inicial', volume)));
  group.append(row('settings-toggle-grid',
    toggle('Preferir reproducción nativa', 'playback-native', settings.preferNative, value => set('preferNative', value)),
    toggle('Modo de ahorro de recursos', 'playback-economy', settings.lowPower, value => set('lowPower', value)),
    toggle('Iniciar sin sonido', 'playback-muted-setting', settings.muted, value => set('muted', value))));
  return group;
}

function appearanceSettings(profile, actions) {
  const group = section('Apariencia');
  const set = (key, value) => actions.setSetting('appearance', key, value);
  const position = select('appearance-position', [['left', 'Izquierda'], ['right', 'Derecha']], profile.appearance.position, value => set('position', value));
  const scale = select('appearance-scale', [['compact', 'Compacto'], ['normal', 'Normal'], ['large', 'Grande']], profile.appearance.scale, value => set('scale', value));
  const fit = select('appearance-fit', [['contain', 'Mostrar la imagen completa'], ['cover', 'Llenar la pantalla']], profile.appearance.fit, value => set('fit', value));
  group.append(row('settings-grid', field('Posición del panel', position), field('Tamaño de la interfaz', scale), field('Ajuste del video', fit)));
  return group;
}

function categorySettings(title, key, profile, categories, actions, disabled = false) {
  const group = section(title);
  const chosen = profile[key];
  const options = Array.from(new Set(categories)).filter(value => typeof value === 'string' && value && !chosen.includes(value)).sort((a, b) => a.localeCompare(b, 'es'));
  if (chosen.length) {
    const list = node('ul', 'source-list');
    for (const value of chosen) {
      const item = node('li', 'source-row');
      const remove = button('Quitar', () => actions.removeCategory(key, value), `${key}-remove-${value}`);
      remove.setAttribute('aria-label', `Quitar categoría ${value}`);
      item.append(node('span', '', value), remove);
      list.append(item);
    }
    group.append(list);
  }
  if (options.length) {
    const picker = select(`${key}-picker`, options.map(name => [name, name]), options[0]);
    picker.disabled = disabled;
    const add = button('Agregar categoría', null, `${key}-add`, { submit: true, disabled });
    const choose = form(() => actions.addCategory(key, picker.value), row('settings-actions', add));
    choose.prepend(field('Categoría disponible', picker));
    group.append(choose);
  } else if (!chosen.length) group.append(node('p', 'settings-note', 'El catálogo aún no tiene categorías disponibles.'));
  return group;
}

function restrictionSettings(profile, actions) {
  const group = section('PIN del perfil');
  const available = pinAvailable();
  const pin = input('profile-pin', { type: 'password', required: true, maxLength: 8, inputMode: 'numeric', pattern: '[0-9]{4,8}', autocomplete: 'off', disabled: !available });
  const add = button(profile.pin ? 'Cambiar PIN' : 'Activar PIN', null, 'pin-save', { submit: true, disabled: !available });
  const edit = form(() => {
    const value = pin.value;
    pin.value = '';
    actions.setPin(value);
  }, row('settings-actions', add));
  edit.prepend(field('PIN de 4 a 8 dígitos', pin));
  group.append(node('p', 'settings-note', available ? 'El bloqueo de categorías se aplica a este perfil en este navegador.' : 'El PIN requiere HTTPS o localhost.'), edit);
  if (profile.pin) group.append(row('settings-actions', button('Quitar PIN', actions.removePin, 'pin-remove', { kind: 'danger', disabled: !available })));
  return group;
}

function refreshSettings(prefs, actions) {
  const group = section('Actualización y disponibilidad');
  const set = (key, value) => actions.setSetting('global', key, value);
  const intervals = [[0, 'Solo manual'], [6, 'Cada 6 horas'], [12, 'Cada 12 horas'], [24, 'Cada 24 horas'], [48, 'Cada 48 horas']];
  const refresh = select('refresh-hours', intervals, prefs.refreshHours, value => set('refreshHours', Number(value)));
  const timeouts = numericOptions([2500, 4500, 6500, 9000, 12000, 15000], prefs.probeTimeout, asSeconds);
  const probe = select('probe-timeout', timeouts, prefs.probeTimeout, value => set('probeTimeout', Number(value)));
  group.append(row('settings-grid', field('Actualizar listas', refresh), field('Tiempo de verificación', probe)));
  group.append(row('settings-toggle-grid', toggle('Verificar señales visibles y favoritas', 'probe-enabled', prefs.probeEnabled, value => set('probeEnabled', value))));
  return group;
}

function backupSettings(actions) {
  const group = section('Copia de preferencias');
  const file = withFile('preferences-import', '.json,application/json', actions.importPreferences);
  group.append(row('settings-actions', button('Exportar preferencias', actions.exportPreferences, 'preferences-export')));
  group.append(field('Importar preferencias', file));
  return group;
}

function replaceSettings(container, content) {
  const active = document.activeElement;
  const key = container.contains(active) ? active.dataset.settingsFocus : '';
  const view = container.parentElement;
  const scrollTop = view?.scrollTop || 0;
  container.replaceChildren(...content);
  if (view) view.scrollTop = scrollTop;
  if (!key) return;
  const replacement = Array.from(container.querySelectorAll('[data-settings-focus]')).find(element => element.dataset.settingsFocus === key);
  if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
}

export function renderSettings(container, { prefs, profile, sources, categories, actions }) {
  replaceSettings(container, [
    sourceSettings(prefs, sources, actions),
    profileSettings(prefs, profile, actions),
    playbackSettings(profile, actions),
    appearanceSettings(profile, actions),
    categorySettings('Categorías favoritas', 'favoriteCategories', profile, categories, actions),
    restrictionSettings(profile, actions),
    categorySettings('Categorías bloqueadas', 'blockedCategories', profile, categories, actions, !profile.pin),
    refreshSettings(prefs, actions),
    backupSettings(actions)
  ]);
}

export function renderChannelSettings(container, { channel, profile, channelHidden, channelFavorite, actions }) {
  const details = section(channel.name);
  const metadata = [`Canal ${channel.number}`, profile.name, ...channel.categories].join(' · ');
  details.append(node('p', 'settings-note', metadata));
  const favorite = button(channelFavorite ? 'Quitar de favoritos' : 'Añadir a favoritos', actions.favorite, 'channel-favorite', { kind: channelFavorite ? 'secondary' : 'primary' });
  const channelActions = [favorite];
  if (channel.officialPage) channelActions.push(button('Ver señal oficial', actions.official, 'channel-official'));
  if (!channel.fixed) channelActions.push(button(channelHidden ? 'Mostrar canal' : 'Ocultar canal', actions.hide, 'channel-hide'));
  details.append(row('settings-actions', ...channelActions));

  const back = row('settings-actions', button('Volver al catálogo', actions.back, 'channel-back'));
  if (channel.fixed) {
    replaceSettings(container, [details, back]);
    return;
  }

  const order = section('Orden de la lista');
  order.append(node('p', 'settings-note', channelHidden ? 'Muestra el canal para cambiar su posición.' : 'El orden cambia dentro del grupo y el canal conserva su número.'));
  order.append(row('settings-actions',
    button('Subir', () => actions.move(-1), 'channel-move-up', { disabled: channelHidden }),
    button('Bajar', () => actions.move(1), 'channel-move-down', { disabled: channelHidden }),
    button('Mover al inicio del grupo', actions.moveFirst, 'channel-move-first', { disabled: channelHidden })));
  replaceSettings(container, [details, order, back]);
}
