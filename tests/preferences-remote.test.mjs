import test from 'node:test';
import assert from 'node:assert/strict';
import { xmltvTime } from '../js/guide.js';
import { checkPin, makePin, validatePreferences } from '../js/preferences.js';
import { remoteAction } from '../js/remote.js';

test('mapea teclas estándar, control remoto y dígitos antiguos sin capturar atajos del navegador', () => {
  assert.equal(remoteAction({ key: 'ArrowUp', keyCode: 38 }), 'up');
  assert.equal(remoteAction({ key: 'Unidentified', keyCode: 461 }), 'back');
  assert.equal(remoteAction({ key: 'Unidentified', keyCode: 10009 }), 'back');
  assert.equal(remoteAction({ key: 'Unidentified', keyCode: 10073 }), 'channels');
  assert.equal(remoteAction({ key: 'Unidentified', keyCode: 10190 }), 'last');
  assert.equal(remoteAction({ key: 'Unidentified', keyCode: 404 }), 'favorites');
  assert.equal(remoteAction({ key: 'Unidentified', keyCode: 96 }), '0');
  assert.equal(remoteAction({ key: 'Unidentified', keyCode: 449 }), 'mute');
  assert.equal(remoteAction({ key: 'ChannelUp' }), 'next');
  assert.equal(remoteAction({ key: 'ChannelDown' }), 'previous');
  assert.equal(remoteAction({ key: 'Unidentified', keyCode: 427 }), 'next');
  assert.equal(remoteAction({ key: 'Unidentified', keyCode: 428 }), 'previous');
  assert.equal(remoteAction({ key: 's', ctrlKey: true }), '');
});

test('restaura los ajustes válidos y desecha fuentes y valores inválidos', () => {
  const preferences = validatePreferences(JSON.parse(`{"version":2,"profiles":[{"id":"principal","name":"Mi perfil","playback":{"volume":2}}],"sources":[{"id":"bad","name":"Enlace no válido","url":"javascript:alert(1)"},{"id":"ok","name":"Canales","url":"https://example.test/lista.m3u"}],"numbers":{"tvg:alpha":0,"tvg:beta":-1,"__proto__":1}}`));
  assert.equal(preferences.active, 'principal');
  assert.equal(preferences.profiles[0].playback.volume, 1);
  assert.deepEqual(preferences.sources.map(source => source.id), ['ok']);
  assert.equal(preferences.numbers['tvg:alpha'], 0);
  assert.equal(preferences.numbers['tvg:beta'], undefined);
  assert.equal(Object.getPrototypeOf(preferences.numbers), null);
});

test('actualiza el ajuste de pantalla anterior y respeta la elección guardada en el formato nuevo', () => {
  const legacy = { version: 2, profiles: [{ id: 'principal', name: 'Principal', appearance: { fit: 'contain' } }], sources: [] };
  const migrated = validatePreferences(legacy);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.profiles[0].appearance.fit, 'cover');
  migrated.profiles[0].appearance.fit = 'contain';
  assert.equal(validatePreferences(migrated).profiles[0].appearance.fit, 'contain');
});

test('el PIN usa una sal distinta y solo se valida con sus dígitos', async () => {
  const first = await makePin('4072');
  const second = await makePin('4072');
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(await checkPin('4072', first), true);
  assert.equal(await checkPin('4071', first), false);
  await assert.rejects(() => makePin('12'));
});

test('interpreta la zona horaria de XMLTV y descarta horarios inválidos', () => {
  assert.equal(xmltvTime('20261120230000 -0400'), Date.UTC(2026, 10, 21, 3));
  assert.equal(xmltvTime('20261120230000 +0400'), Date.UTC(2026, 10, 20, 19));
  assert.equal(xmltvTime('20261120230000 UTC'), Date.UTC(2026, 10, 20, 23));
  assert.ok(Number.isNaN(xmltvTime('20260230230000 +0000')));
});
