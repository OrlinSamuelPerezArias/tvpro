import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../js/player.js';

class Video extends EventTarget {
  src = '';
  readyState = 0;
  paused = true;
  muted = true;
  volume = 1;
  error = null;
  native = false;
  plays = [];

  get currentSrc() { return this.src; }
  canPlayType() { return this.native ? 'maybe' : ''; }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
  load() { this.readyState = 0; this.error = null; }
  play() {
    const next = this.plays.shift();
    return next ? next() : Promise.resolve();
  }
  startPlaying() {
    this.readyState = 3;
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
  }
}

function engineClass() {
  const eventNames = ['MEDIA_ATTACHED', 'MANIFEST_PARSED', 'AUDIO_TRACKS_UPDATED', 'AUDIO_TRACK_SWITCHED', 'LEVEL_SWITCHED', 'ERROR'];
  return class Engine {
    static Events = Object.fromEntries(eventNames.map(name => [name, name]));
    static ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network', KEY_SYSTEM_ERROR: 'key' };
    static instances = [];
    static isSupported() { return true; }
    listeners = new Map();
    levels = [{ height: 480, bitrate: 500000 }, { height: 1080, bitrate: 2000000 }];
    audioTracks = [{ lang: 'eng', name: 'Inglés' }, { lang: 'spa', name: 'Español' }];
    audioTrack = 0;
    currentLevel = 0;
    loadLevel = -1;
    recoveries = 0;

    constructor(config) {
      this.config = config;
      this.constructor.instances.push(this);
    }
    get autoLevelEnabled() { return this.loadLevel < 0; }
    on(name, listener) { this.listeners.set(name, listener); }
    emit(name, data) { this.listeners.get(name)?.(name, data); }
    loadSource(url) { this.url = url; }
    attachMedia(video) { this.video = video; this.emit('MEDIA_ATTACHED'); }
    recoverMediaError() {
      this.recoveries += 1;
      this.video.error = null;
      this.video.pause();
      this.emit('MEDIA_ATTACHED');
    }
    stopLoad() { this.loadingStopped = true; }
    startLoad() { this.loadingStopped = false; }
    destroy() { this.destroyed = true; }
  };
}

function fixture(t) {
  const video = new Video();
  const Hls = engineClass();
  const statuses = [];
  const results = [];
  const player = new Player(video, {
    Hls,
    onStatus: status => statuses.push(status),
    onStreamResult: (...result) => results.push(result)
  });
  t.after(() => player.stop());
  return { player, video, Hls, statuses, results };
}

function channel(id, extensions = ['m3u8']) {
  return { id, name: id, streams: extensions.map((extension, index) => ({ url: `https://fixture.example/${id}-${index}.${extension}` })) };
}

test('el manifiesto no acredita reproducción y las variantes y el audio se pueden seleccionar', t => {
  const { player, video, Hls, results } = fixture(t);
  const first = channel('uno');
  player.tune(first, { lowPower: true });
  const [engine] = Hls.instances;
  engine.emit('MANIFEST_PARSED');
  assert.equal(player.status.state, 'loading');
  assert.equal(engine.audioTrack, 1);
  assert.equal(engine.autoLevelCapping, 0);
  assert.equal(engine.config.maxBufferLength, 8);
  assert.equal(player.tracks.qualities.length, 2);
  assert.equal(player.setQuality(1), true);
  assert.equal(player.tracks.quality, 1);
  assert.equal(player.setQuality(-1), true);
  assert.equal(player.tracks.quality, -1);
  assert.equal(player.setAudio(0), true);
  assert.equal(player.tracks.audio, 0);
  player.configure({ audioLanguage: 'en' });
  player.configure({ audioLanguage: 'es' });
  assert.equal(player.tracks.audio, 1);
  video.startPlaying();
  assert.equal(player.status.state, 'playing');
  assert.deepEqual(results, [[first.streams[0].url, 'playing']]);
});

test('el cambio rápido invalida promesas y eventos de un reproductor anterior', async t => {
  const { player, video, Hls, results } = fixture(t);
  let resolveOld;
  video.plays.push(() => new Promise(resolve => { resolveOld = resolve; }));
  player.tune(channel('anterior'), {});
  const [previous] = Hls.instances;
  previous.emit('MANIFEST_PARSED');
  const next = channel('siguiente');
  player.tune(next, {});
  assert.equal(previous.destroyed, true);
  previous.emit('ERROR', { fatal: true, type: 'network' });
  resolveOld();
  await Promise.resolve();
  assert.equal(player.status.state, 'loading');
  assert.deepEqual(results, []);
  Hls.instances[1].emit('MANIFEST_PARSED');
  video.startPlaying();
  assert.equal(player.status.channel, next);
  assert.deepEqual(results, [[next.streams[0].url, 'playing']]);
});

test('recupera una sola vez el decodificador y después cambia a otra URL', async t => {
  const { player, video, Hls, results } = fixture(t);
  const live = channel('uno', ['m3u8', 'mp4']);
  player.tune(live, {});
  const [engine] = Hls.instances;
  engine.emit('MANIFEST_PARSED');
  video.startPlaying();
  video.error = { code: 3 };
  video.dispatchEvent(new Event('error'));
  assert.equal(engine.recoveries, 1);
  assert.equal(player.status.state, 'reconnecting');
  video.startPlaying();
  video.error = { code: 3 };
  video.dispatchEvent(new Event('error'));
  assert.equal(engine.recoveries, 1);
  assert.equal(engine.destroyed, true);
  await wait(290);
  assert.equal(video.src, live.streams[1].url);
  video.startPlaying();
  assert.equal(player.status.state, 'playing');
  assert.deepEqual(results.map(result => result[1]), ['playing', 'format', 'playing']);
});

test('la reproducción nativa conserva la preferencia de sonido al activar reproducción silenciada', async t => {
  const { player, video, Hls } = fixture(t);
  video.native = true;
  video.plays.push(() => Promise.reject(Object.assign(new Error('Policy'), { name: 'NotAllowedError' })));
  player.tune(channel('nativo'), { muted: false });
  await Promise.resolve();
  assert.equal(Hls.instances.length, 0);
  assert.equal(video.muted, true);
  video.startPlaying();
  assert.equal(player.status.soundBlocked, true);
  player.resume();
  assert.equal(video.muted, false);
  assert.equal(player.status.soundBlocked, false);
});

test('si incluso la reproducción silenciada requiere permiso, espera una acción y reactiva la carga', async t => {
  const { player, video, Hls } = fixture(t);
  const denied = () => Promise.reject(Object.assign(new Error('Policy'), { name: 'NotAllowedError' }));
  video.plays.push(denied, denied);
  player.tune(channel('restringido'), {});
  const [engine] = Hls.instances;
  engine.emit('MANIFEST_PARSED');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(player.status.state, 'autoplay');
  assert.equal(engine.loadingStopped, true);
  assert.equal(player.resume(), true);
  video.startPlaying();
  assert.equal(player.status.state, 'playing');
  assert.equal(engine.loadingStopped, false);
});

test('una señal con errores transitorios se reconecta un máximo de dos veces', async t => {
  const { player, Hls, results } = fixture(t);
  const live = channel('limitado');
  player.tune(live, {});
  const fail = engine => engine.emit('ERROR', { fatal: true, type: 'network' });
  fail(Hls.instances[0]);
  await wait(480);
  assert.equal(Hls.instances.length, 2);
  fail(Hls.instances[1]);
  await wait(930);
  assert.equal(Hls.instances.length, 3);
  fail(Hls.instances[2]);
  assert.equal(player.status.state, 'no-signal');
  assert.equal(Hls.instances.every(engine => engine.destroyed), true);
  assert.deepEqual(results, Array.from({ length: 3 }, () => [live.streams[0].url, 'network']));
});

test('respeta el límite HTTP 429 y distingue la señal con restricción regional explícita', t => {
  const { player, Hls, results } = fixture(t);
  player.tune(channel('limite'), {});
  Hls.instances[0].emit('ERROR', { fatal: true, type: 'network', response: { code: 429 } });
  assert.equal(player.status.state, 'no-signal');
  assert.equal(results[0][1], 'rate-limited');
  player.tune(channel('region'), {});
  Hls.instances[1].emit('ERROR', { fatal: true, type: 'network', response: { code: 403, text: 'geo restricted' } });
  assert.equal(player.status.state, 'no-signal');
  assert.equal(results[1][1], 'region');
});
