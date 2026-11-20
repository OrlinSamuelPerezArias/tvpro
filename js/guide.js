import { readTextLimited } from './catalog.js';

const GUIDE_LIMIT = 12 * 1024 * 1024;
const GUIDE_FRESH_MS = 30 * 60000;

export function xmltvTime(value) {
  const parts = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s+([+-])(\d{2})(\d{2})|\s+UTC|\s+GMT)?$/i.exec(value || '');
  if (!parts) return NaN;
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = parts;
  const utc = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day ||
      +hour >= 24 || +minute >= 60 || +second >= 60 || +offsetHours > 23 || +offsetMinutes >= 60) return NaN;
  return utc - (sign === '-' ? -1 : 1) * ((+offsetHours || 0) * 60 + (+offsetMinutes || 0)) * 60000;
}

function parseGuide(text) {
  const content = text.replace(/<!DOCTYPE\s+tv(?:\s+SYSTEM\s+(?:"[^"<>]*"|'[^'<>]*'))?\s*>/i, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('XMLTV no compatible');
  const document = new DOMParser().parseFromString(content, 'text/xml');
  if (document.documentElement?.localName !== 'tv' || document.querySelector('parsererror')) throw new Error('Guía XMLTV inválida');
  const programmes = new Map();
  const cutoff = Date.now() - 2 * 3600000;
  const future = Date.now() + 2 * 86400000;
  for (const node of document.getElementsByTagName('programme')) {
    const channel = node.getAttribute('channel')?.trim().toLowerCase();
    const start = xmltvTime(node.getAttribute('start'));
    const stop = xmltvTime(node.getAttribute('stop'));
    const titles = Array.from(node.getElementsByTagName('title'));
    const title = (titles.find(item => /^es(?:-|$)/i.test(item.getAttribute('lang') || '')) || titles[0])?.textContent.trim().slice(0, 180);
    if (!channel || !title || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= start || stop < cutoff || start > future) continue;
    if (!programmes.has(channel)) programmes.set(channel, []);
    if (programmes.get(channel).length < 160) programmes.get(channel).push({ channel, start, stop, title });
  }
  return programmes;
}

async function download(url, outsideSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, 10000);
  outsideSignal.addEventListener('abort', cancel, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Respuesta XMLTV no disponible');
    }
    let input = response;
    const contentType = response.headers.get('content-type') || '';
    if (!response.headers.get('content-encoding') && (/\b(?:x-)?gzip\b/i.test(contentType) || (/\.gz(?:[?#]|$)/i.test(response.url || url) && !/xml/i.test(contentType)))) {
      if (!response.body || typeof DecompressionStream === 'undefined') {
        controller.abort();
        throw new Error('XMLTV comprimido no compatible');
      }
      input = new Response(response.body.pipeThrough(new DecompressionStream('gzip')));
    }
    const text = await readTextLimited(input, GUIDE_LIMIT);
    return parseGuide(text);
  } finally {
    clearTimeout(timer);
    outsideSignal.removeEventListener('abort', cancel);
  }
}

export class Guide {
  #cache = new Map();
  #controller;

  cancel() { this.#controller?.abort(); }

  async load(urls) {
    this.cancel();
    this.#controller = new AbortController();
    const { signal } = this.#controller;
    let loaded = 0;
    for (const url of urls) {
      if (signal.aborted) break;
      if (this.#cache.get(url)?.expires > Date.now()) { loaded++; continue; }
      try {
        const programmes = await download(url, signal);
        if (signal.aborted) break;
        this.#cache.set(url, { programmes, expires: Date.now() + GUIDE_FRESH_MS });
        if (this.#cache.size > 6) this.#cache.delete(this.#cache.keys().next().value);
        loaded++;
      } catch {
        if (this.#cache.has(url)) loaded++;
      }
    }
    return loaded;
  }

  forChannel(channel, urls, now = Date.now()) {
    const ids = new Set([channel?.tvgId, ...(channel?.tvgIds || [])].filter(Boolean).map(id => id.toLowerCase()));
    for (const id of [...ids]) if (id.includes('@')) ids.add(id.split('@')[0]);
    const records = new Map();
    for (const url of urls) {
      const programmes = this.#cache.get(url)?.programmes;
      for (const id of ids) for (const programme of programmes?.get(id) || []) {
        if (programme.stop > now) records.set(`${programme.start}|${programme.title}`, programme);
      }
    }
    return [...records.values()].sort((a, b) => a.start - b.start).slice(0, 12);
  }
}
