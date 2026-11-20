import { safeUrl } from './catalog.js';

const defaults = { audioLanguage: 'es', lowPower: false, muted: false, volume: 0.8, preferNative: true, timeout: 10000 };
const emptyTracks = { qualities: [], audios: [], quality: -1, audio: -1, activeQuality: -1 };
const maxCandidates = 4;
const maxRetries = 2;
const directExtension = /\.(?:mp4|m4v|m4a|webm|ogv|ogg|oga|mp3|aac|wav|mov|ts|m2ts|mkv|mpd)$/i;
const hlsExtension = /\.m3u8?$/i;
const transient = new Set(['network', 'timeout']);
const unavailable = {
  down: 'La señal no está disponible en el servidor.',
  format: 'El dispositivo no pudo reproducir el formato de la señal.',
  'mixed-content': 'Señal HTTP bloqueada por el navegador. Se necesita una señal HTTPS.',
  network: 'No se pudo conectar. Puede ser un problema de red o de permisos del origen.',
  'rate-limited': 'El servidor limitó las solicitudes. Vuelve a intentar más tarde.',
  region: 'La fuente indica que la señal está restringida en esta región.',
  restricted: 'La fuente denegó el acceso a la señal.',
  timeout: 'La señal tardó demasiado en responder.'
};

export function isHttpBlocked(url, pageProtocol = globalThis.location?.protocol) {
  return pageProtocol === 'https:' && typeof url === 'string' && /^http:/i.test(url.trim());
}

function candidateUrls(streams) {
  return [...new Set((streams || []).map(stream => safeUrl(stream?.url)).filter(Boolean))];
}

function routeFor(url, video, Engine, preferNative) {
  const pathname = new URL(url).pathname;
  if (directExtension.test(pathname)) return 'direct';
  const native = Boolean(video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL'));
  if (native && preferNative) return 'direct';
  if (Engine?.isSupported()) return 'hls';
  return native || !hlsExtension.test(pathname) ? 'direct' : 'unsupported';
}

function languageKey(language) {
  const key = String(language || '').toLowerCase().split(/[-_]/, 1)[0];
  return ({ spa: 'es', eng: 'en', fre: 'fr', fra: 'fr', por: 'pt', deu: 'de', ger: 'de', ita: 'it' })[key] || key;
}

function trackLanguage(track) {
  const language = languageKey(track.lang || track.language);
  if (language && language !== 'und') return language;
  const label = track.name || track.label || '';
  if (/espa[nñ]ol|castellano|spanish/i.test(label)) return 'es';
  if (/ingl[eé]s|english/i.test(label)) return 'en';
  return '';
}

function trackLabel(track, index) {
  return track.name || track.label || track.lang || track.language || `Pista ${index + 1}`;
}

function qualityLabel(level, index) {
  const bitrate = level.bitrate ? `${Math.round(level.bitrate / 1000)} kb/s` : '';
  return [level.height && `${level.height}p`, bitrate].filter(Boolean).join(' · ') || `Nivel ${index + 1}`;
}

function hlsFailure(Engine, data) {
  const responseCode = Number(data.response?.code || data.networkDetails?.status);
  const statusText = data.response?.text || data.networkDetails?.statusText || '';
  if (responseCode === 429) return 'rate-limited';
  if (/geo.?block|geo.?restrict|region(?:ally)? restricted/i.test(statusText)) return 'region';
  if ([401, 403, 451].includes(responseCode) || data.type === Engine.ErrorTypes.KEY_SYSTEM_ERROR) return 'restricted';
  if (responseCode === 404 || responseCode === 410 || responseCode >= 500) return 'down';
  if (/timeout/i.test(data.details || '')) return 'timeout';
  if (/parsing|incompatible.codec|manifest.*codec/i.test(data.details || '') || data.type === Engine.ErrorTypes.MEDIA_ERROR) return 'format';
  return 'network';
}

function hlsConfig(settings) {
  const timeout = settings.timeout;
  const lowPower = settings.lowPower;
  const retry = () => ({ maxNumRetry: 1, retryDelayMs: 350, maxRetryDelayMs: 1200 });
  const requestPolicy = () => ({ default: {
    maxTimeToFirstByteMs: timeout,
    maxLoadTimeMs: timeout,
    timeoutRetry: retry(),
    errorRetry: retry()
  } });
  return {
    enableWorker: true,
    lowLatencyMode: !lowPower,
    capLevelToPlayerSize: true,
    capLevelOnFPSDrop: true,
    backBufferLength: lowPower ? 3 : 12,
    maxBufferLength: lowPower ? 8 : 18,
    maxMaxBufferLength: lowPower ? 12 : 28,
    maxBufferSize: lowPower ? 8e6 : 24e6,
    liveMaxUnchangedPlaylistRefresh: 5,
    nudgeMaxRetry: 2,
    manifestLoadPolicy: requestPolicy(),
    playlistLoadPolicy: requestPolicy(),
    fragLoadPolicy: requestPolicy(),
    keyLoadPolicy: requestPolicy(),
    startLevel: lowPower ? 0 : -1,
    testBandwidth: !lowPower
  };
}

export class Player {
  constructor(video, { onStatus, onTracks, onStreamResult, Hls, pageProtocol = globalThis.location?.protocol } = {}) {
    this.video = video;
    this.engine = Hls;
    this.pageProtocol = pageProtocol;
    this.onStatus = onStatus;
    this.onTracks = onTracks;
    this.onStreamResult = onStreamResult;
    this.settings = { ...defaults };
    this.session = null;
    this.attempt = null;
    this.retryTimer = null;
    this.soundBlocked = false;
    this.tracks = { ...emptyTracks };
    this.playback = { state: 'idle', message: '', channel: null, url: '', cause: null };
  }

  get status() {
    return { ...this.playback, muted: this.video.muted, soundBlocked: this.soundBlocked };
  }

  configure(settings = {}) {
    const previous = this.settings;
    const combined = { ...previous, ...settings };
    combined.timeout = Number.isFinite(combined.timeout) ? Math.max(1000, Math.min(60000, combined.timeout)) : defaults.timeout;
    this.settings = combined;
    if ('volume' in settings) this.setVolume(combined.volume);
    if (combined.muted !== previous.muted) {
      this.soundBlocked = false;
      this.video.muted = Boolean(combined.muted);
    }
    if (this.attempt && combined.audioLanguage !== previous.audioLanguage) {
      this.session.manualAudio = null;
      this.attempt.preferredAudioApplied = false;
      this.updateTracks(this.attempt, true);
    }
  }

  tune(channel, settings, streams = channel.streams, { gesture = false } = {}) {
    const urls = candidateUrls(streams);
    const playable = urls.filter(url => !isHttpBlocked(url, this.pageProtocol));
    const cause = urls.length && !playable.length ? 'mixed-content' : null;
    return this.start(channel, settings, playable, gesture, cause);
  }

  start(channel, settings, urls, gesture, cause = null) {
    this.release();
    this.session = null;
    this.configure(settings);
    this.session = { channel, urls, index: 0, retries: 0, recoveries: 0, manualAudio: null, manualQuality: null };
    this.video.muted = Boolean(this.settings.muted || (this.soundBlocked && !gesture));
    if (gesture) this.soundBlocked = false;
    if (!urls.length) {
      this.report('no-signal', unavailable[cause] || 'El canal no tiene una URL de reproducción válida.', cause);
      return false;
    }
    this.openAttempt();
    return true;
  }

  stop() {
    this.release();
    this.session = null;
    this.report('idle', '');
  }

  resume({ sound = true } = {}) {
    if (!this.session || this.playback.cause === 'mixed-content') return false;
    const wasSoundBlocked = this.soundBlocked;
    if (sound) {
      this.settings.muted = false;
      this.soundBlocked = false;
      this.video.muted = false;
    }
    if (this.playback.state === 'no-signal') {
      const { channel, urls, index } = this.session;
      const remaining = index >= maxCandidates - 1 ? urls.slice(index + 1) : [];
      const next = remaining.length ? [...remaining, ...urls.slice(0, index + 1)] : urls;
      return this.start(channel, this.settings, next, true);
    }
    const attempt = this.attempt;
    if (!attempt) return false;
    if (attempt.autoplayBlocked) {
      attempt.autoplayBlocked = false;
      attempt.hls?.startLoad();
      this.watch(attempt, this.settings.timeout);
      this.report('loading', 'Cargando señal…');
    } else if (wasSoundBlocked && !this.soundBlocked) {
      this.onStatus?.(this.status);
    }
    // Retry inside the user gesture even if a previous play promise is pending.
    this.tryPlay(attempt, true);
    return true;
  }

  setVolume(value) {
    if (!Number.isFinite(value)) return this.video.volume;
    this.settings.volume = Math.max(0, Math.min(1, value));
    try {
      this.video.volume = this.settings.volume;
    } catch {
      // Some Smart TV platforms delegate volume to the device.
    }
    return this.video.volume;
  }

  toggleMute() {
    this.settings.muted = !this.video.muted;
    this.soundBlocked = false;
    this.video.muted = this.settings.muted;
    if (!this.video.muted && this.attempt) this.resume();
    return this.video.muted;
  }

  setQuality(index) {
    const attempt = this.attempt;
    if (!attempt?.hls || !Number.isInteger(index) || (index !== -1 && !attempt.hls.levels[index])) return false;
    this.session.manualQuality = index < 0 ? null : qualityLabel(attempt.hls.levels[index], index);
    attempt.hls.loadLevel = index;
    this.updateTracks(attempt);
    return true;
  }

  setAudio(index) {
    const attempt = this.attempt;
    if (!attempt || !Number.isInteger(index)) return false;
    const list = this.audioTracks(attempt);
    if (!list[index]) return false;
    this.session.manualAudio = { language: trackLanguage(list[index]), label: trackLabel(list[index], index) };
    attempt.preferredAudioApplied = true;
    this.selectAudio(attempt, list, index);
    this.updateTracks(attempt);
    return true;
  }

  report(state, message, cause = null) {
    const channel = this.session?.channel || null;
    const url = this.attempt?.url || this.session?.urls[this.session.index] || '';
    this.playback = { state, message, channel, url, cause };
    this.onStatus?.(this.status);
  }

  emitTracks(tracks) {
    if (JSON.stringify(this.tracks) === JSON.stringify(tracks)) return;
    this.tracks = tracks;
    this.onTracks?.(tracks);
  }

  release() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const attempt = this.attempt;
    this.attempt = null;
    if (attempt) {
      clearTimeout(attempt.watchdog);
      for (const unbind of attempt.unbind) unbind();
      attempt.hls?.destroy();
      this.video.pause();
      this.video.removeAttribute('src');
      if (this.video.srcObject) this.video.srcObject = null;
      this.video.load();
    }
    this.emitTracks({ ...emptyTracks });
  }

  current(attempt) {
    return this.attempt === attempt && this.session === attempt.session;
  }

  listen(attempt, target, event, callback) {
    if (!target?.addEventListener) return;
    const handler = event => { if (this.current(attempt)) callback(event); };
    target.addEventListener(event, handler);
    attempt.unbind.push(() => target.removeEventListener(event, handler));
  }

  watch(attempt, timeout) {
    clearTimeout(attempt.watchdog);
    attempt.watchdog = setTimeout(() => {
      if (this.current(attempt) && !attempt.autoplayBlocked) this.fail(attempt, 'timeout');
    }, timeout);
  }

  openAttempt(forceDirect = false, reconnecting = false) {
    const session = this.session;
    const video = this.video;
    const Engine = this.engine || globalThis.Hls;
    const url = session.urls[session.index];
    const mode = forceDirect ? 'direct' : routeFor(url, video, Engine, this.settings.preferNative);
    const attempt = { session, url, mode, hls: null, attached: false, manifestReady: false,
      unbind: [], played: false, preferredAudioApplied: false, playRequest: 0, playPending: false,
      triedMuted: false, autoplayBlocked: false, recoveringDecoder: false };
    this.attempt = attempt;
    this.report(reconnecting ? 'reconnecting' : 'loading', reconnecting ? 'Reconectando…' : 'Cargando señal…');
    if (mode === 'unsupported') {
      this.fail(attempt, 'format');
      return;
    }
    this.bindVideo(attempt);
    this.watch(attempt, this.settings.timeout);
    if (mode === 'direct') {
      attempt.attached = true;
      video.src = url;
      this.tryPlay(attempt);
      return;
    }
    try {
      this.openHls(attempt, Engine);
    } catch {
      this.fail(attempt, 'format');
    }
  }

  bindVideo(attempt) {
    const video = this.video;
    this.listen(attempt, video, 'loadedmetadata', () => this.updateTracks(attempt, true));
    this.listen(attempt, video, 'playing', () => this.confirmPlaying(attempt));
    const resumeProgress = () => {
      if (attempt.played && this.playback.state === 'reconnecting' && video.readyState >= 3) this.confirmPlaying(attempt);
    };
    this.listen(attempt, video, 'timeupdate', resumeProgress);
    const buffering = () => {
      if (!attempt.played || video.paused || video.readyState >= 3 || this.playback.state !== 'playing') return;
      this.report('reconnecting', 'Recuperando la señal…');
      this.watch(attempt, this.settings.timeout);
    };
    this.listen(attempt, video, 'waiting', buffering);
    this.listen(attempt, video, 'stalled', buffering);
    this.listen(attempt, video, 'error', () => {
      if (!attempt.attached || !video.error) return;
      if (attempt.mode === 'direct' && video.currentSrc && video.currentSrc !== attempt.url) return;
      if (video.error.code === 3 && this.recoverDecoder(attempt)) return;
      if (video.error.code !== 1) this.fail(attempt, video.error.code === 2 ? 'network' : 'format');
    });
    this.listen(attempt, video, 'ended', () => {
      if (!attempt.attached || !attempt.played || !video.ended) return;
      if (attempt.hls?.latestLevelDetails?.live === false || directExtension.test(new URL(attempt.url).pathname)) {
        clearTimeout(attempt.watchdog);
        this.report('ended', 'La reproducción ha terminado.');
      } else {
        this.fail(attempt, 'down');
      }
    });
    if (attempt.mode === 'direct') {
      this.listen(attempt, video.audioTracks, 'addtrack', () => this.updateTracks(attempt, true));
      this.listen(attempt, video.audioTracks, 'change', () => this.updateTracks(attempt));
    }
  }

  openHls(attempt, Engine) {
    const hls = new Engine(hlsConfig(this.settings));
    attempt.hls = hls;
    const listen = (event, callback) => hls.on(event, (_event, data) => {
      if (this.current(attempt)) callback(data);
    });
    listen(Engine.Events.MEDIA_ATTACHED, () => {
      attempt.attached = true;
      attempt.recoveringDecoder = false;
      if (attempt.manifestReady) this.tryPlay(attempt);
    });
    listen(Engine.Events.MANIFEST_PARSED, () => {
      attempt.manifestReady = true;
      const levels = hls.levels;
      if (this.settings.lowPower && levels.length) {
        const cap = levels.reduce((index, level, next) => level.height <= 720 ? next : index, 0);
        hls.autoLevelCapping = cap;
      }
      if (attempt.session.manualQuality) {
        const index = levels.findIndex((level, index) => qualityLabel(level, index) === attempt.session.manualQuality);
        if (index >= 0) hls.loadLevel = index;
      }
      this.updateTracks(attempt, true);
      if (attempt.attached) this.tryPlay(attempt);
    });
    listen(Engine.Events.AUDIO_TRACKS_UPDATED, () => {
      attempt.preferredAudioApplied = false;
      this.updateTracks(attempt, true);
    });
    listen(Engine.Events.AUDIO_TRACK_SWITCHED, () => this.updateTracks(attempt));
    listen(Engine.Events.LEVEL_SWITCHED, () => this.updateTracks(attempt));
    listen(Engine.Events.ERROR, data => {
      if (!data.fatal) return;
      if (data.type === Engine.ErrorTypes.MEDIA_ERROR && (attempt.recoveringDecoder || this.recoverDecoder(attempt))) return;
      this.fail(attempt, hlsFailure(Engine, data));
    });
    hls.loadSource(attempt.url);
    if (this.current(attempt)) hls.attachMedia(this.video);
  }

  tryPlay(attempt, force = false) {
    if (!this.current(attempt) || !attempt.attached || attempt.autoplayBlocked || (attempt.playPending && !force)) return;
    const request = ++attempt.playRequest;
    attempt.playPending = true;
    const settle = error => {
      if (!this.current(attempt) || request !== attempt.playRequest) return;
      attempt.playPending = false;
      if (!error) {
        this.confirmPlaying(attempt);
        return;
      }
      if (error.name === 'AbortError') return;
      if (attempt.recoveringDecoder) return;
      if (error.name === 'NotAllowedError') {
        if (!this.video.muted && !attempt.triedMuted) {
          attempt.triedMuted = true;
          this.soundBlocked = true;
          this.video.muted = true;
          this.tryPlay(attempt);
          return;
        }
        attempt.autoplayBlocked = true;
        clearTimeout(attempt.watchdog);
        attempt.hls?.stopLoad();
        this.report('autoplay', 'Pulsa OK o Reproducir para iniciar la señal.');
        return;
      }
      // Recover a decoding error via the media error event when one is available.
      if (this.video.error?.code === 3 && this.recoverDecoder(attempt)) return;
      this.fail(attempt, error.name === 'NotSupportedError' ? 'format' : 'network');
    };
    try {
      const pending = this.video.play();
      if (pending?.then) pending.then(() => settle(), settle);
      else attempt.playPending = false;
    } catch (error) {
      settle(error);
    }
  }

  confirmPlaying(attempt) {
    const video = this.video;
    if (!this.current(attempt) || !attempt.attached || video.paused || video.readyState < 2 || video.error) return;
    if (attempt.mode === 'direct' && video.currentSrc && video.currentSrc !== attempt.url) return;
    clearTimeout(attempt.watchdog);
    if (!attempt.played) {
      attempt.played = true;
      this.onStreamResult?.(attempt.url, 'playing');
    }
    if (this.playback.state !== 'playing' || this.playback.url !== attempt.url) this.report('playing', 'Reproduciendo');
  }

  recoverDecoder(attempt) {
    const session = attempt.session;
    if (!this.current(attempt) || !attempt.hls || this.video.error?.code !== 3 || session.recoveries >= 1) return false;
    session.recoveries += 1;
    attempt.recoveringDecoder = true;
    attempt.attached = false;
    attempt.playPending = false;
    attempt.playRequest += 1;
    this.report('reconnecting', 'Recuperando el decodificador…');
    this.watch(attempt, this.settings.timeout);
    try {
      attempt.hls.recoverMediaError();
      return true;
    } catch {
      return false;
    }
  }

  fail(attempt, state) {
    if (!this.current(attempt)) return;
    const session = attempt.session;
    const nextCandidate = session.index + 1 < Math.min(session.urls.length, maxCandidates);
    const fallbackDirect = attempt.mode === 'hls' && state === 'format' && !hlsExtension.test(new URL(attempt.url).pathname);
    const retry = transient.has(state) && session.retries < maxRetries && (attempt.played || !nextCandidate);
    console.debug('[TV PRO] Estado de la señal:', state);
    this.release();
    if (fallbackDirect) {
      this.openAttempt(true, true);
      return;
    }
    this.onStreamResult?.(attempt.url, state);
    if (!retry && !nextCandidate) {
      this.report('no-signal', unavailable[state] || 'La señal no está disponible.', state);
      return;
    }
    if (retry) session.retries += 1;
    else session.index += 1;
    const delay = retry ? 450 * 2 ** (session.retries - 1) : 260;
    this.report('reconnecting', retry ? 'Reintentando la señal…' : 'Probando una señal alternativa…');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.session === session) this.openAttempt(retry && attempt.mode === 'direct', true);
    }, delay);
  }

  audioTracks(attempt) {
    return Array.from(attempt.hls ? attempt.hls.audioTracks : this.video.audioTracks || []);
  }

  selectAudio(attempt, tracks, index) {
    if (attempt.hls) {
      if (attempt.hls.audioTrack !== index) attempt.hls.audioTrack = index;
    } else {
      tracks.forEach((track, next) => {
        const enabled = next === index;
        if (track.enabled !== enabled) track.enabled = enabled;
      });
    }
  }

  updateTracks(attempt, preferAudio = false) {
    if (!this.current(attempt)) return;
    const hls = attempt.hls;
    const tracks = this.audioTracks(attempt);
    if (preferAudio && !attempt.preferredAudioApplied && tracks.length) {
      const manual = attempt.session.manualAudio;
      const language = manual?.language || languageKey(this.settings.audioLanguage);
      const exact = manual ? tracks.findIndex((track, index) => trackLabel(track, index) === manual.label) : -1;
      const preferred = exact >= 0 ? exact : tracks.findIndex(track => language && trackLanguage(track) === language);
      if (preferred >= 0) {
        attempt.preferredAudioApplied = true;
        this.selectAudio(attempt, tracks, preferred);
      }
    }
    const qualities = (hls?.levels || []).map((level, index) => ({ index, label: qualityLabel(level, index) }));
    this.emitTracks({
      qualities,
      audios: tracks.map((track, index) => ({ index, label: trackLabel(track, index) })),
      quality: hls && !hls.autoLevelEnabled ? (qualities.find(level => level.label === attempt.session.manualQuality)?.index ?? hls.loadLevel) : -1,
      activeQuality: hls?.currentLevel ?? -1,
      audio: hls?.audioTrack ?? tracks.findIndex(track => track.enabled)
    });
  }
}
