const legacy = {
  8: 'back', 13: 'ok', 23: 'ok', 27: 'back', 33: 'next', 34: 'previous',
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 164: 'mute', 166: 'back', 173: 'mute',
  403: 'channels', 404: 'favorites', 405: 'guide', 406: 'settings', 427: 'next', 428: 'previous',
  447: 'louder', 448: 'quieter', 449: 'mute', 457: 'info', 458: 'guide', 461: 'back',
  10009: 'back', 10073: 'channels', 10190: 'last'
};
const named = {
  enter: 'ok', select: 'ok', accept: 'ok', ok: 'ok', escape: 'back', back: 'back', browserback: 'back', goback: 'back', backspace: 'back',
  arrowup: 'up', up: 'up', arrowdown: 'down', down: 'down', arrowleft: 'left', left: 'left', arrowright: 'right', right: 'right',
  channelup: 'next', 'ch+': 'next', pageup: 'next', channeldown: 'previous', 'ch-': 'previous', pagedown: 'previous',
  audiovolumemute: 'mute', volumemute: 'mute', mute: 'mute', audiovolumeup: 'louder', volumeup: 'louder', audiovolumedown: 'quieter', volumedown: 'quieter',
  channellist: 'channels', menu: 'channels', contextmenu: 'channels', colorf0red: 'channels', colorf1green: 'favorites',
  colorf2yellow: 'guide', colorf3blue: 'settings', favorite: 'favorites', favorites: 'favorites', info: 'info', guide: 'guide', previouschannel: 'last',
  c: 'channels', f: 'favorites', g: 'guide', i: 'info', m: 'mute', r: 'last', s: 'settings'
};

export function remoteAction(event, registered = new Map()) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return '';
  const key = String(event.key || '').toLowerCase();
  if (/^[0-9]$/.test(key)) return key;
  const code = event.keyCode || event.which;
  if (!key || key === 'unidentified') {
    if (code >= 48 && code <= 57) return String(code - 48);
    if (code >= 96 && code <= 105) return String(code - 96);
  }
  return named[key] || registered.get(code) || legacy[code] || '';
}

export function registerRemote() {
  const codes = new Map();
  const device = globalThis.tizen?.tvinputdevice;
  if (!device) return codes;
  const desired = new Set(['ChannelUp', 'ChannelDown', 'ChannelList', 'PreviousChannel', 'Info', 'Guide', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'VolumeUp', 'VolumeDown', 'VolumeMute', ...'0123456789']);
  try {
    for (const key of device.getSupportedKeys()) {
      if (!desired.has(key.name)) continue;
      try {
        device.registerKey(key.name);
        codes.set(key.code, named[key.name.toLowerCase()] || key.name);
      } catch { /* Browser/packaging can reserve the key. */ }
    }
  } catch { /* Direction and OK are available without registration. */ }
  return codes;
}

export function focusable(scope) {
  return Array.from(scope.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')).filter(element =>
    !element.disabled && element.tabIndex >= 0 && !element.closest('[hidden], [inert]') && element.getClientRects().length);
}

export function moveFocus(scope, from, direction) {
  const list = focusable(scope);
  if (!list.length) return;
  if (!list.includes(from)) { list[0].focus(); return; }
  const rect = from.getBoundingClientRect();
  const horizontal = direction === 'left' || direction === 'right';
  const positive = direction === 'down' || direction === 'right';
  const center = (start, end) => (start + end) / 2;
  const sourceAxis = horizontal ? center(rect.left, rect.right) : center(rect.top, rect.bottom);
  const sourceSide = horizontal ? center(rect.top, rect.bottom) : center(rect.left, rect.right);
  let closest;
  let best = Infinity;
  for (const element of list) {
    if (element === from) continue;
    const target = element.getBoundingClientRect();
    const axis = horizontal ? center(target.left, target.right) : center(target.top, target.bottom);
    const side = horizontal ? center(target.top, target.bottom) : center(target.left, target.right);
    const forward = (axis - sourceAxis) * (positive ? 1 : -1);
    if (forward < 5) continue;
    const sideDist = Math.abs(side - sourceSide);
    const perpendicularOverlap = horizontal
      ? Math.min(rect.bottom, target.bottom) > Math.max(rect.top, target.top) + 4
      : Math.min(rect.right, target.right) > Math.max(rect.left, target.left) + 4;
    const score = forward + sideDist * (perpendicularOverlap ? 0.45 : 2.2) + (perpendicularOverlap ? 0 : 20);
    if (score < best) { best = score; closest = element; }
  }
  closest?.focus();
}
