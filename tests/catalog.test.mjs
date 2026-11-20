import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker as Thread } from 'node:worker_threads';
import test, { mock } from 'node:test';
import {
  Availability, buildCatalog, buildCatalogAsync, fetchSource, orderedChannels,
  parseM3U, parseM3UAsync, playlistEPGUrls, safeUrl
} from '../js/catalog.js';

test('reads quoted metadata, relative URLs, HLS sources, and XMLTV hints safely', () => {
  const baseUrl = 'https://listas.example/publica/canales.m3u';
  const text = '\uFEFF#EXTM3U x-tvg-url="../guia.xml, javascript:alert(1)"\r\n' +
    '#EXTINF:-1 tvg-id="Noticias.do@2" tvg-logo="../logo.png" tvg-language="spa;eng" group-title="Noticias, General",Noticias, en vivo\n' +
    '../directo.m3u8#fragmento\n' +
    '#EXTINF:-1,Maliciosa\nhttps://nombre:clave@web.example/media\n' +
    '#EXTINF:-1,Esquema incompatible\njavascript:alert(1)\n' +
    '#EXTINF:-1 tvg-id="Cultura.es",Cultura\n#EXTGRP:Cultura\nhttps://otro.example/cultura\n';
  const entries = parseM3U(text, { baseUrl });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'Noticias, en vivo');
  assert.deepEqual(entries[0].countries, ['DO']);
  assert.deepEqual(entries[0].languages, ['es', 'en']);
  assert.deepEqual(entries[0].categories, ['Noticias', 'General']);
  assert.equal(entries[0].url, 'https://listas.example/directo.m3u8');
  assert.equal(entries[0].logo, 'https://listas.example/logo.png');
  assert.deepEqual(entries[1].categories, ['Cultura']);
  assert.deepEqual(playlistEPGUrls(text, baseUrl), ['https://listas.example/guia.xml']);
  assert.equal(safeUrl('https://usuario:clave@web.example/video'), '');
  assert.equal(safeUrl('data:text/html,<script>'), '');
  assert.throws(() => parseM3U('<!doctype html>'), /cabecera/);
  const hls = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n';
  assert.throws(() => parseM3U(hls), /sola señal HLS/);
  assert.deepEqual(parseM3U(hls, { baseUrl, name: 'Mi señal' }).map(({ name, url, type }) => [name, url, type]),
    [['Mi señal', baseUrl, 'hls']]);
});

test('deduplicates and groups variants, reserves numbers, and recovers the saved identity after turnover', () => {
  const rows = parseM3U(`#EXTM3U
#EXTINF:-1 tvg-id="Noticias.es",Otro país
https://es.example/index.m3u8
#EXTINF:-1 tvg-id="Principal.do@regional",Tele Visión HD
https://do-a.example/index.m3u8
#EXTINF:-1 tvg-id="Principal.do@nacional",TV Principal
https://do-b.example/playlist.m3u8
#EXTINF:-1 tvg-country="DO",Tele Vision
https://do-c.example/alternativa
#EXTINF:-1,Variante con URL idéntica
https://do-c.example/alternativa#misma
`);
  let numbers = {};
  const first = buildCatalog(rows, numbers);
  const dominant = first[0];
  assert.equal(dominant.country, 'DO');
  assert.equal(dominant.number, 0);
  assert.equal(dominant.tvgId, 'Principal.do@regional');
  assert.ok(dominant.tvgIds.includes('Principal.do'));
  assert.equal(dominant.streams.length, 3);
  assert.equal(first[1].number, 1);
  numbers = JSON.parse(JSON.stringify(numbers));
  const refreshed = buildCatalog([rows[0], rows[3], ...parseM3U('#EXTM3U\n#EXTINF:-1 tvg-id="Nuevo.do",Nuevo\nhttps://nuevo.example/1\n')], numbers);
  assert.equal(refreshed[0].id, dominant.id);
  assert.equal(refreshed[0].number, 0);
  assert.equal(refreshed[2].number, 2);
  assert.deepEqual(orderedChannels(refreshed, { order: [refreshed[1].id], hidden: [dominant.id] }).map(c => c.number), [1, 2]);
  assert.deepEqual(orderedChannels(refreshed, {}, { includeHidden: true }).map(c => c.number), [0, 2, 1]);
});

test('keeps equal names from different countries and their ambiguous unclassified variants separate', () => {
  const text = '#EXTM3U\n#EXTINF:-1 tvg-country="DO",Canal 10\nhttps://do.example/s\n' +
    '#EXTINF:-1 tvg-country="ES",Canal 10\nhttps://es.example/s\n' +
    '#EXTINF:-1,Canal 10\nhttps://u1.example/s\n#EXTINF:-1,Canal 10\nhttps://u2.example/s\n';
  const channels = buildCatalog(parseM3U(text), {});
  assert.equal(channels.length, 3);
  assert.equal(new Set(channels.map(channel => channel.id)).size, 3);
  assert.equal(channels.find(channel => !channel.country).streams.length, 2);
});

test('retains independently assigned numbers after a temporary merge splits again', () => {
  const numbers = {};
  const first = { name: 'One', country: 'DO', url: 'https://one.example/a' };
  const second = { name: 'Two', country: 'DO', url: 'https://two.example/b' };
  assert.deepEqual(buildCatalog([first, second], numbers).map(channel => channel.number), [0, 1]);
  assert.equal(buildCatalog([first, second, { ...first, url: second.url }], numbers).length, 1);
  assert.deepEqual(buildCatalog([second, first], numbers).map(({ name, number }) => [name, number]), [['One', 0], ['Two', 1]]);
});

test('supports large asynchronous builds without a worker and cancels without assigning numbers', async () => {
  const text = '#EXTM3U\n' + Array.from({ length: 2600 }, (_, index) =>
    `#EXTINF:-1 tvg-id="LargeCatalogChannel${index}.do",Canal grande ${index}\nhttps://medio.example/pruebas/${index}/master.m3u8\n`
  ).join('');
  const rows = await parseM3UAsync(text);
  const assigned = {};
  const channels = await buildCatalogAsync(rows, assigned);
  assert.equal(channels.length, 2600);
  assert.equal(channels[0].number, 0);
  assert.equal(assigned[channels[2599].id], 2599);
  const controller = new AbortController();
  const draft = {};
  const pending = buildCatalogAsync(rows, draft, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(draft, {});
});

test('executes the catalog worker protocol on a separate thread', async () => {
  const bootstrap = `
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.addEventListener = (type, receive) => parentPort.on(type, data => receive({ data }));
    globalThis.postMessage = data => parentPort.postMessage(data);
    import(workerData).catch(error => { throw error; });
  `;
  const previousWorker = globalThis.Worker;
  let results = 0;
  globalThis.Worker = class {
    constructor(url) {
      this.thread = new Thread(bootstrap, { eval: true, workerData: url.href });
      this.thread.on('message', data => {
        results += 1;
        this.onmessage?.({ data });
      });
      this.thread.on('error', () => this.onerror?.(new Event('error')));
    }

    postMessage(data) { this.thread.postMessage(data); }
    terminate() { this.thread.terminate(); }
  };
  try {
    const text = '#EXTM3U\n' + Array.from({ length: 2400 }, (_, index) =>
      `#EXTINF:-1 tvg-id="IndependentThread${index}.do",Canal dedicado ${index}\nhttps://medio.example/threads/${index}/stream.m3u8\n`
    ).join('');
    const rows = await parseM3UAsync(text);
    const numbers = {};
    const fixedLineup = [{ number: 0, name: 'Principal de prueba', streams: [] }];
    const channels = await buildCatalogAsync(rows, numbers, { fixedLineup });
    assert.equal(results, 2);
    assert.equal(channels.length, 2401);
    assert.equal(channels[0].id, 'fixed:0');
    assert.equal(numbers['tvg:independentthread0.do'], 1);
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  }
});

test('loads source URLs relative to the server redirect and reports HTTP failures', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.credentials, 'omit');
    if (url.includes('fallo')) return new Response(null, { status: 503 });
    const response = new Response('#EXTM3U url-tvg="epg.xml"\n#EXTINF:-1,Canal\nstream.m3u8\n');
    Object.defineProperty(response, 'url', { value: 'https://nuevo.example/api/lista.m3u' });
    return response;
  });
  try {
    const entries = await fetchSource({ id: 'fuente', url: 'https://viejo.example/lista' });
    assert.equal(entries[0].sourceId, 'fuente');
    assert.equal(entries[0].url, 'https://nuevo.example/api/stream.m3u8');
    assert.deepEqual(entries.epgUrls, ['https://nuevo.example/api/epg.xml']);
    await assert.rejects(fetchSource({ url: 'https://viejo.example/fallo' }), /HTTP 503/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('examines the selected HLS media sample and caches honest outcomes', async () => {
  const ts = new Uint8Array(376);
  ts[0] = 0x47;
  ts[188] = 0x47;
  const list = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg.ts\n';
  const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.includes('region')) return new Response(null, { status: 451 });
    if (url.includes('prohibido')) return new Response(null, { status: 403 });
    if (url.includes('html')) return new Response('<!doctype html><title>200</title>');
    if (url.includes('cors')) throw new TypeError('Failed to fetch');
    if (new URL(url).pathname === '/master.m3u8') return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000\ngrande.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\npequena.m3u8\n');
    if (url.includes('seg.ts')) {
      assert.equal(init.headers.Range, 'bytes=0-1023');
      return new Response(ts, { status: 206 });
    }
    assert.match(url, /pequena/);
    return new Response(list);
  });
  try {
    const availability = new Availability({ concurrency: 2 });
    const stream = 'https://master.example/master.m3u8';
    assert.equal((await availability.probe(stream)).state, 'reachable');
    const count = fetchMock.mock.callCount();
    assert.equal((await availability.probe(stream)).state, 'reachable');
    assert.equal(fetchMock.mock.callCount(), count);
    const statuses = await Promise.all(['region', 'prohibido', 'html', 'cors'].map(name => availability.probe(`https://${name}.example/v.m3u8`)));
    assert.deepEqual(statuses.map(result => result.state), ['region', 'restricted', 'format', 'unreachable']);
    availability.mark('https://bueno.example/video', 'playing');
    assert.deepEqual(availability.rank([{ url: stream }, { url: 'https://bueno.example/video' }]).map(item => item.url),
      ['https://bueno.example/video', stream]);
  } finally {
    fetchMock.mock.restore();
  }
});

test('starts higher priorities first, caps concurrency, coalesces duplicate requests, and cancels old probes', async () => {
  const seen = [];
  let active = 0;
  let peak = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async (url, { signal }) => {
    seen.push(url);
    active += 1;
    peak = Math.max(active, peak);
    try {
      await delay(15, null, { signal });
      return new Response(null, { status: 404 });
    } finally {
      active -= 1;
    }
  });
  try {
    const availability = new Availability({ concurrency: 2 });
    const low = availability.probe('https://lento.example/s', 0);
    const high = availability.probe('https://pronto.example/s', 20);
    const middle = availability.probe('https://intermedio.example/s', 10);
    assert.equal(availability.probe('https://pronto.example/s', 21), high);
    await Promise.all([low, high, middle]);
    assert.equal(seen[0], 'https://pronto.example/s');
    assert.equal(seen[1], 'https://intermedio.example/s');
    assert.equal(peak, 2);
    const abandoned = availability.probe('https://anterior.example/s');
    await Promise.resolve();
    availability.clear();
    assert.equal((await abandoned).state, 'canceled');
    assert.equal(availability.get('https://anterior.example/s'), undefined);
    const current = availability.probe('https://actual.example/s');
    await Promise.resolve();
    availability.mark('https://actual.example/s', 'playing');
    assert.equal((await current).state, 'playing');
    assert.equal(availability.get('https://actual.example/s').state, 'playing');
  } finally {
    fetchMock.mock.restore();
  }
});

test('observes HTTP rate-limit cooldowns without contacting the same origin for queued siblings', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 429, headers: { 'Retry-After': '10' }
  }));
  try {
    const availability = new Availability();
    const first = availability.probe('https://limite.example/uno');
    const second = availability.probe('https://limite.example/dos');
    assert.deepEqual((await Promise.all([first, second])).map(result => result.state), ['rate-limited', 'rate-limited']);
    assert.equal(fetchMock.mock.callCount(), 1);
  } finally {
    fetchMock.mock.restore();
  }
});
