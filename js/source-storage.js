import { fetchSource, parseM3UAsync, playlistEPGUrls } from './catalog.js';

const STORE = 'snapshots';
const FILE_LIMIT = 8 * 1024 * 1024;

async function readFile(file, maximum, description) {
  if (!file || file.size < 1 || file.size > maximum) throw new Error(`${description} debe pesar entre 1 byte y ${Math.floor(maximum / 1048576)} MB.`);
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsText(file);
  });
}

export { readFile };

function database() {
  return new Promise(resolve => {
    try {
      const request = indexedDB.open('tv-pro-local', 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

export class Sources {
  snapshots = new Map();
  status = new Map();
  #database = database();
  #refresh;

  async #operate(mode, action) {
    const db = await this.#database;
    if (!db) return undefined;
    return new Promise(resolve => {
      try {
        const transaction = db.transaction(STORE, mode);
        const request = action(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request.result ?? true);
        transaction.onerror = transaction.onabort = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }

  async restore(list) {
    await Promise.all(list.map(async source => {
      const cache = await this.#operate('readonly', store => store.get(source.id));
      if (cache && cache.url === source.url && Array.isArray(cache.entries)) {
        this.snapshots.set(source.id, cache);
        this.status.set(source.id, 'En caché');
      } else if (source.local) this.status.set(source.id, 'Vuelve a importar el archivo');
    }));
  }

  cachedEntries(list) {
    const entries = [];
    for (const source of list) {
      const snapshot = this.snapshots.get(source.id);
      if (snapshot?.url !== source.url) continue;
      for (const entry of snapshot.entries) entries.push(entry);
    }
    return entries;
  }

  guideUrls(list, sourceIds = []) {
    const ranked = [...list].sort((a, b) => Number(sourceIds.includes(b.id)) - Number(sourceIds.includes(a.id)));
    const urls = ranked.flatMap(source => [source.epg, ...(this.snapshots.get(source.id)?.epgUrls || [])]);
    return [...new Set(urls.filter(Boolean))].slice(0, 4);
  }

  async importFile(source, file) {
    const text = await readFile(file, FILE_LIMIT, 'La lista M3U');
    const entries = (await parseM3UAsync(text, source)).map(entry => ({ ...entry, sourceId: source.id }));
    if (!entries.length) throw new Error('El archivo no contiene señales HTTP o HTTPS compatibles.');
    const snapshot = { url: '', entries, epgUrls: playlistEPGUrls(text), updated: Date.now() };
    this.snapshots.set(source.id, snapshot);
    const persisted = await this.#operate('readwrite', store => store.put(snapshot, source.id));
    this.status.set(source.id, persisted ? 'Importada' : 'Importada para esta sesión');
    return Boolean(persisted);
  }

  async remove(id) {
    this.snapshots.delete(id);
    this.status.delete(id);
    await this.#operate('readwrite', store => store.delete(id));
  }

  cancel() {
    if (!this.#refresh) return;
    for (const [id, previous] of this.#refresh.pending) {
      if (previous) this.status.set(id, previous);
      else this.status.delete(id);
    }
    this.#refresh.controller.abort();
    this.#refresh = undefined;
  }

  async refresh(list, { force = false, hours = 24, onUpdate = () => {} } = {}) {
    if (this.#refresh && !force) return;
    this.cancel();
    const now = Date.now();
    const toLoad = list.filter(source => {
      if (source.local) return false;
      const cache = this.snapshots.get(source.id);
      if (force || !cache || cache.url !== source.url) return true;
      return hours > 0 && now - cache.updated >= hours * 3600000;
    });
    if (!toLoad.length) return;
    const run = { controller: new AbortController(), pending: new Map() };
    this.#refresh = run;
    let index = 0;
    async function worker() {
      while (index < toLoad.length && !run.controller.signal.aborted) {
        const source = toLoad[index++];
        run.pending.set(source.id, this.status.get(source.id));
        this.status.set(source.id, 'Actualizando…');
        onUpdate(false);
        try {
          const entries = await fetchSource(source, { signal: run.controller.signal, timeout: 14000 });
          if (run.controller.signal.aborted) return;
          if (!entries.length) throw new Error('Lista vacía');
          const snapshot = { url: source.url, entries, updated: Date.now(), epgUrls: entries.epgUrls || [] };
          this.snapshots.set(source.id, snapshot);
          this.status.set(source.id, `${entries.length} señales`);
          run.pending.delete(source.id);
          onUpdate(true);
          await this.#operate('readwrite', store => store.put(snapshot, source.id));
        } catch (error) {
          if (run.controller.signal.aborted) return;
          this.status.set(source.id, this.snapshots.has(source.id) ? 'Error · se conserva la última lista' : 'Lista no disponible');
          run.pending.delete(source.id);
          console.debug('TV PRO: fuente no disponible', source.id, error.name);
          onUpdate(false);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, toLoad.length) }, () => worker.call(this)));
    if (this.#refresh === run) {
      this.#refresh = undefined;
      onUpdate(false);
    }
  }

  get updating() { return Boolean(this.#refresh); }
}
