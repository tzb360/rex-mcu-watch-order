// This file is concatenated with shared, tested core code by build-local.mjs.
// Trakt Client ID is public. No account token or client secret is distributed.
var MCU_CLIENT_ID = 'jik3qry8gfgZ1jhnC8txpNYnoA1eImB_zz-nBDtGbiI';
var MCU_SEED_URL = 'https://raw.githubusercontent.com/tzb360/rex-mcu-watch-order/main/timeline.seed.json';
var WidgetMetadata = {
  id: 'personal.mcu.timeline.local', title: '漫威宇宙时间线 · 本地版',
  description: '按漫威故事顺序显示下一部和下一集。时间线通过 HTTPS 更新，观看进度由 Rex 直接从 Trakt 同步。',
  author: 'Personal MCU Timeline', site: 'https://www.marvel.com/articles/movies/mcu-timeline-order-disney-plus',
  version: '0.2.7', requiredVersion: '0.0.1', detailCacheDuration: 60,
  modules: [{
    id: 'mcu-local', title: '漫威宇宙观影顺序', functionName: 'loadMcuLocal', cacheDuration: 0, requiresWebView: false,
    params: [
      { name: 'action', title: '操作', type: 'enumeration', value: 'watch', enumOptions: [
        { title: '查看待看清单', value: 'watch' }, { title: '连接 Trakt', value: 'connect' },
        { title: '我已完成授权', value: 'confirm' }, { title: '立即同步观看记录', value: 'refresh' },
        { title: '刷新时间线', value: 'catalog' }, { title: '检查运行环境', value: 'diagnose' }
      ] },
      { name: 'seedUrl', title: '时间线数据地址', type: 'input', value: MCU_SEED_URL, description: '只填写可信的公开 HTTPS JSON 地址；不携带个人观看数据或凭据。' },
      { name: 'page', title: '页码', type: 'page', value: '1' }
    ]
  }]
};

function MCUQuery(values) {
  this.toString = function () { return Object.keys(values).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(String(values[key])); }).join('&'); };
}
function mcuVersion(value) {
  var result = 2166136261;
  for (var i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return (result >>> 0).toString(16);
}
var mcuLocalStore = {
  read: async function (key) {
    var value = await Widget.storage.get('mcu.local.v2.' + key);
    if (value == null || value === '') return null;
    try { return typeof value === 'string' ? JSON.parse(value) : value; }
    catch (_) { throw new Error('本地模块缓存损坏，请重新连接 Trakt；不会输出缓存原文。'); }
  },
  write: async function (key, value) { await Widget.storage.set('mcu.local.v2.' + key, JSON.stringify(value)); },
  readSecret: async function (key) { return this.read('private.' + key); },
  writeSecret: async function (key, value) { return this.write('private.' + key, value); }
};
async function mcuNativeFetch(url, options) {
  options = options || {};
  var response;
  var request = { headers: options.headers || {}, timeout: 6 };
  if (options.method === 'POST') {
    response = await Widget.http.post(url, options.body ? JSON.parse(options.body) : {}, request);
  } else {
    response = await Widget.http.get(url, request);
  }
  var status = Number(response.statusCode || response.status || 200);
  var data = response.data;
  var headers = response.headers || {};
  return {
    status: status, ok: status >= 200 && status < 300,
    headers: { get: function (key) { var found = Object.keys(headers).find(function (k) { return k.toLowerCase() === key.toLowerCase(); }); return found ? String(headers[found]) : null; } },
    text: async function () { return data == null ? '' : typeof data === 'string' ? data : JSON.stringify(data); },
    json: async function () { return typeof data === 'string' ? JSON.parse(data) : data; }
  };
}
var mcuLocalTrakt = null;
var mcuLocalSync = null;
var mcuArtworkInFlight = new Map();
var mcuLocalOperations = new Map();
var mcuLocalOperation = Promise.resolve();
function mcuLocalStatus(message, link) {
  var url = link || 'https://developer.trakt.tv/apps';
  return [{ id: url, type: 'url', title: message.split('\n')[0], description: message, link: url }];
}

async function mcuAuthorizeDevice(action) {
  var pending = await mcuLocalStore.readSecret('device');
  var now = Date.now();
  if (action === 'connect') {
    if (!pending || now >= pending.expiresAt) {
      var code = await mcuLocalTrakt.oauth('/oauth/device/code', { client_id: MCU_CLIENT_ID });
      if (!code.device_code || !code.user_code || !code.verification_url || !Number.isFinite(code.interval) || !Number.isFinite(code.expires_in)) throw new Error('设备码接口未返回完整响应。');
      if (!/^https:\/\/(?:auth\.)?trakt\.tv(?:\/|$)/.test(code.verification_url)) throw new Error('授权链接不是 Trakt 官方域名，已停止。');
      pending = Object.assign({}, code, { expiresAt: now + code.expires_in * 1000, nextPollAt: now + code.interval * 1000 });
      await mcuLocalStore.writeSecret('device', pending);
    }
    return mcuLocalStatus('连接 Trakt：' + pending.user_code + '\n请用浏览器打开 ' + pending.verification_url + '，输入上述代码。授权后将“操作”改为“我已完成授权”再刷新。本地版会将令牌保存于 Rex 模块存储，不上传服务器。', pending.verification_url);
  }
  if (!pending || now >= pending.expiresAt) throw new Error('授权码已过期，请选择“连接 Trakt”重新生成。');
  if (now < pending.nextPollAt) throw new Error('请等待 ' + Math.ceil((pending.nextPollAt - now) / 1000) + ' 秒后再检查授权。');
  // A user-driven poll needs no timers and never polls faster than the provider interval.
  pending.nextPollAt = now + pending.interval * 1000;
  await mcuLocalStore.writeSecret('device', pending);
  try {
    var token = await mcuLocalTrakt.oauth('/oauth/device/token', { code: pending.device_code, client_id: MCU_CLIENT_ID });
    await mcuLocalTrakt.saveToken(token);
    await mcuLocalStore.writeSecret('device', null);
  } catch (error) {
    if (error.code === 'TRAKT_HTTP_400') throw new Error('Trakt 尚未确认授权；请完成网页授权后再刷新。');
    if (error.code === 'TRAKT_RATE_LIMIT') {
      pending.nextPollAt = error.retryAt || now + 60000;
      await mcuLocalStore.writeSecret('device', pending);
    }
    if (['TRAKT_HTTP_404', 'TRAKT_HTTP_409', 'TRAKT_HTTP_410', 'TRAKT_HTTP_418'].indexOf(error.code) >= 0) {
      await mcuLocalStore.writeSecret('device', null);
      throw new Error('授权已失效或被拒绝，请重新连接 Trakt。');
    }
    throw error;
  }
  return mcuLocalStatus('Trakt 已连接成功。请选择“查看待看清单”并刷新。');
}
function mcuValidCatalog(seed) {
  if (!seed || seed.schemaVersion !== 1 || typeof seed.version !== 'string' ||
      !/^[-.a-zA-Z0-9]{1,80}$/.test(seed.version) || !Number.isFinite(Date.parse(seed.updatedAt)) ||
      !Array.isArray(seed.entries) || seed.entries.length < 50 || seed.entries.length > 600) return false;
  var ids = new Set();
  var positions = new Set();
  return seed.entries.every(function (entry) {
    if (!entry || typeof entry.stableId !== 'string' || !entry.stableId || ids.has(entry.stableId) ||
        typeof entry.originalTitle !== 'string' || !entry.originalTitle || !['movie', 'tv'].includes(entry.mediaType) ||
        !Number.isFinite(entry.timelineOrder) || positions.has(entry.timelineOrder) ||
        !Array.isArray(entry.chronologySource) || !entry.chronologySource.some(function (source) { return source && source.url === SOURCE; })) return false;
    ids.add(entry.stableId);
    positions.add(entry.timelineOrder);
    if (seed.metadataStatus !== 'resolved') return seed.metadataStatus === 'requires-live-resolution';
    if (entry.availabilityStatus === 'pending_metadata') return true;
    if (!['released', 'available', 'announced'].includes(entry.availabilityStatus) ||
        !Number.isInteger(entry.tmdbId) || entry.tmdbId <= 0 ||
        (entry.availabilityStatus !== 'announced' && !Number.isFinite(Date.parse(entry.releaseDate)))) return false;
    if (entry.mediaType === 'movie') return true;
    var episodes = entry.episodes;
    return Number.isInteger(entry.season) && Array.isArray(episodes) &&
      (entry.availabilityStatus !== 'available' || episodes.length > 0) &&
      new Set(episodes.map(function (episode) { return episode && episode.number; })).size === episodes.length &&
      episodes.every(function (episode) {
        return episode && episode.season === entry.season && Number.isInteger(episode.number) && episode.number > 0 &&
          (episode.firstAired == null || Number.isFinite(Date.parse(episode.firstAired)));
      });
  }) && (seed.metadataStatus !== 'resolved' || seed.entries.some(function (entry) {
    return ['released', 'available'].includes(entry.availabilityStatus);
  }));
}
async function mcuLoadSeed(url, etag, force) {
  var headers = {};
  if (etag && url !== MCU_SEED_URL) headers['If-None-Match'] = etag;
  if (force) headers['Cache-Control'] = 'no-cache';
  var requestUrl = url;
  if (url === MCU_SEED_URL) {
    // Rex can reject a bare 304. Raw uses a fresh cache key and validates the returned version.
    var revision = force ? Date.now() : Math.floor(Date.now() / (30 * 60000));
    requestUrl += '?mcu-catalog=' + revision;
  }
  var response, seed;
  try { response = await mcuNativeFetch(requestUrl, { headers: headers }); }
  catch (_) { throw new Error('时间线下载失败：Rex 无法连接数据地址。'); }
  if (response.status === 304) return null;
  if (!response.ok) throw new Error('时间线下载失败：HTTP ' + response.status + '。');
  try { seed = await response.json(); }
  catch (_) { throw new Error('时间线地址没有返回 JSON。'); }
  if (!mcuValidCatalog(seed)) throw new Error('时间线 JSON 格式不符合要求。');
  return { seed: seed, etag: response.headers.get('etag') };
}
async function mcuRefreshCatalog(url, force, cacheOnly) {
  var previous = await mcuLocalStore.read('public-catalog');
  var cached = previous && previous.url === url ? previous : null;
  if (cached && (cacheOnly || (!force && Date.now() < cached.nextCheck))) return cached;
  try {
    var remote = await mcuLoadSeed(url, cached && cached.etag, force);
    if (!remote && !cached) throw new Error('时间线服务器没有返回初始数据。');
    if (remote && cached && cached.seed.metadataStatus === 'resolved' && remote.seed.metadataStatus !== 'resolved') {
      throw new Error('新时间线缺少已核实的元数据。');
    }
    if (remote && cached && Date.parse(remote.seed.updatedAt) < Date.parse(cached.seed.updatedAt)) {
      throw new Error('时间线版本早于本地缓存。');
    }
    var latest = Object.assign({}, remote || cached, { url: url, nextCheck: Date.now() + 30 * 60000, warning: '' });
    await mcuLocalStore.write('public-catalog', latest);
    return latest;
  } catch (error) {
    if (!cached) {
      var legacy = !previous && url === MCU_SEED_URL && await mcuLocalStore.read('timeline');
      if (legacy && legacy.metadataStatus === 'resolved') return { seed: legacy, warning: error.message };
      throw error;
    }
    var fallback = Object.assign({}, cached, { nextCheck: Date.now() + 5 * 60000, warning: error.message });
    await mcuLocalStore.write('public-catalog', fallback);
    return fallback;
  }
}
async function mcuLocalRun(params) {
  if (typeof Widget === 'undefined' || !Widget.http || !Widget.storage || !Widget.storage.get || !Widget.storage.set) throw new Error('此 Rex 运行环境缺少 HTTP 或持久化存储接口，无法运行本地版。');
  var page = Number(params.page || 1);
  if (!Number.isInteger(page) || page < 1) throw new Error('页码无效。');
  mcuLocalTrakt = mcuLocalTrakt || new Trakt({ clientId: MCU_CLIENT_ID, redirectUri: 'http://127.0.0.1:8788/callback', store: mcuLocalStore, fetchImpl: mcuNativeFetch });
  // Persist the provider's backoff between client script invocations.
  mcuLocalTrakt.blockedUntil = await mcuLocalStore.read('blocked-until') || 0;
  var action = params.action || 'watch';
  if (action === 'connect' || action === 'confirm') return mcuAuthorizeDevice(action);
  var seedUrl = String(params.seedUrl || MCU_SEED_URL);
  if (!/^https:\/\/[^\s?#@]+$/.test(seedUrl)) throw new Error('请填写可信的 HTTPS 时间线 JSON 地址。');
  if (action === 'diagnose') {
    var marker = 'storage-check-' + Date.now();
    await mcuLocalStore.write('probe', marker);
    var roundTrip = (await mcuLocalStore.read('probe')) === marker;
    var authorized = Boolean(await mcuLocalStore.readSecret('tokens'));
    var cached = await mcuLocalStore.read('public-catalog');
    var watched = await mcuLocalStore.read('watched');
    var checks = await Promise.allSettled([mcuLocalTrakt.get('/movies/iron-man-2008', {}, false), mcuLoadSeed(seedUrl)]);
    var traktStatus = checks[0].status === 'fulfilled' ? checks[0].value.status : checks[0].reason.code || '失败';
    var seedStatus = checks[1].status === 'fulfilled' ? checks[1].value.seed.version + '，' + checks[1].value.seed.entries.length + ' 个区段' : checks[1].reason.message;
    return mcuLocalStatus('本地诊断：存储读写=' + (roundTrip ? '成功' : '失败') + '；Trakt GET=' + traktStatus + '；时间线=' + seedStatus + '；TMDB=' + Boolean(Widget.tmdb && Widget.tmdb.get) + '；Trakt 授权=' + (authorized ? '已连接' : '未连接') + '。\n本地时间线=' + (cached ? cached.seed.version + (cached.warning ? '（使用缓存）' : '') : '未缓存') + '；观看记录=' + (watched ? watched.syncedAt : '未同步') + '。');
  }
  var token = await mcuLocalStore.readSecret('tokens');
  if (!token) throw new Error('请先将“操作”选择为“连接 Trakt”。');
  var catalog = await mcuRefreshCatalog(seedUrl, action === 'catalog' && page === 1, action === 'refresh');
  var timeline = catalog.seed;
  if (timeline.metadataStatus !== 'resolved') {
    var saved = await mcuLocalStore.read('timeline');
    if (saved && saved.catalogUrl === seedUrl && saved.catalogVersion === timeline.version) {
      timeline = saved;
    } else {
      var resolver = new Timeline({ store: mcuLocalStore, trakt: mcuLocalTrakt, fetchImpl: mcuNativeFetch });
      var next = await resolver.update({
        current: Object.assign({}, timeline, { catalogUrl: seedUrl, catalogVersion: timeline.version }),
        maxNewEntries: 8, deadline: Date.now() + 5000, verifyOfficial: false, tolerateMissing: true
      });
      if (next.metadataStatus === 'resolved') timeline = next;
      else if (saved && saved.metadataStatus === 'resolved' && (saved.catalogUrl === seedUrl || (!saved.catalogUrl && seedUrl === MCU_SEED_URL))) timeline = saved;
      else return page === 1 ? mcuLocalStatus('正在核对时间线 ' + next.entries.length + '/' + next.totalEntries + '。刷新可继续。') : [];
    }
  }
  mcuLocalSync = mcuLocalSync || new WatchSync(mcuLocalTrakt, mcuLocalStore, 30000);
  var snapshot = await mcuLocalSync.load(action === 'refresh' && page === 1, action === 'catalog', false);
  var items = buildQueue(timeline, snapshot, Date.now(), true);
  if (!items.length && page === 1) return mcuLocalStatus('当前已核实、已发行的 MCU 内容已全部完成。');
  return Promise.all(items.slice((page - 1) * 20, page * 20).map(mcuNativeCard));
}
async function mcuNativeCard(item) {
  var key = 'artwork.' + item.mediaType + '.' + item.tmdbId;
  var cached = await mcuLocalStore.read(key).catch(function () { return null; });
  if ((!cached || !cached.posterPath) && Widget.tmdb && Widget.tmdb.get) {
    if (!mcuArtworkInFlight.has(key)) {
      var request = Promise.resolve().then(async function () {
        var response = await Widget.tmdb.get(item.mediaType + '/' + item.tmdbId, { params: { language: 'zh-CN' } });
        var media = response && response.data !== undefined ? response.data : response;
        if (typeof media === 'string') media = JSON.parse(media);
        if (!media || Number(media.id) !== item.tmdbId) return null;
        var official = {
          title: media.title || media.name, posterPath: media.poster_path, backdropPath: media.backdrop_path,
          overview: media.overview, checkedAt: Date.now()
        };
        await mcuLocalStore.write(key, official).catch(function () {});
        return official;
      }).catch(function () { return null; }).finally(function () {
        mcuArtworkInFlight.delete(key);
      });
      mcuArtworkInFlight.set(key, request);
    }
    cached = await mcuArtworkInFlight.get(key) || cached;
  }
  if (cached) {
    item.title = cached.title || item.title;
    if (cached.posterPath) item.posterPath = cached.posterPath;
    if (cached.backdropPath) item.backdropPath = cached.backdropPath;
    if (cached.overview) item.description = cached.overview;
  }
  return item;
}
function loadMcuLocal(params) {
  params = params || {};
  var key = JSON.stringify([params.action || 'watch', params.seedUrl || MCU_SEED_URL, Number(params.page || 1)]);
  if (mcuLocalOperations.has(key)) return mcuLocalOperations.get(key);
  var task = mcuLocalOperation.then(function () {
    return mcuLocalRun(params);
  }).catch(function (error) {
    var message = error.message;
    if (error.code === 'TRAKT_NETWORK') message = 'Rex 无法连接 Trakt，请检查网络。';
    if (error.code === 'TRAKT_REAUTHORIZE' || error.code === 'TRAKT_AUTH_REQUIRED') message = 'Trakt 授权已失效，请使用“连接 Trakt”重新授权。';
    if (error.code === 'TRAKT_RATE_LIMIT') message = 'Trakt 请求限流，请于 ' + new Date(error.retryAt).toISOString() + ' 后重试。';
    return mcuLocalStatus('设置或同步提示：' + message);
  }).finally(async function () {
    try {
      if (mcuLocalTrakt && mcuLocalTrakt.blockedUntil) await mcuLocalStore.write('blocked-until', mcuLocalTrakt.blockedUntil);
    } catch (_) { /* Keep the current result if saving rate-limit state fails. */ }
    mcuLocalOperations.delete(key);
  });
  mcuLocalOperations.set(key, task);
  mcuLocalOperation = task;
  return task;
}


class RemoteError extends Error {
  constructor(code, retryAt = null) { super(code); this.code = code; this.retryAt = retryAt; }
}

// All Trakt personal-data writes are forbidden; only OAuth token POSTs are implemented.
class Trakt {
  constructor({ clientId, clientSecret, redirectUri, store, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { clientId, clientSecret, redirectUri, store, fetchImpl, now });
    this.refreshing = null;
    this.blockedUntil = 0;
  }
  async raw(origin, path, { method = 'GET', body, accessToken } = {}) {
    if (this.now() < this.blockedUntil) throw new RemoteError('TRAKT_RATE_LIMIT', this.blockedUntil);
    const headers = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': this.clientId };
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    let response;
    try {
      response = await this.fetchImpl(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: undefined, redirect: 'error' });
    } catch { throw new RemoteError('TRAKT_NETWORK'); }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds = Number(retry);
      this.blockedUntil = Number.isFinite(seconds) && seconds > 0 ? this.now() + seconds * 1000 : Math.max(this.now() + 60000, Date.parse(retry) || 0);
      throw new RemoteError('TRAKT_RATE_LIMIT', this.blockedUntil);
    }
    if (!response.ok) throw new RemoteError(response.status === 401 ? 'TRAKT_UNAUTHORIZED' : 'TRAKT_HTTP_' + response.status);
    let data = null;
    const text = await response.text();
    if (text) { try { data = JSON.parse(text); } catch { throw new RemoteError('TRAKT_INVALID_RESPONSE'); } }
    return { data, headers: response.headers, status: response.status };
  }
  async oauth(path, body) {
    if (!['/oauth/token', '/oauth/device/code', '/oauth/device/token'].includes(path)) throw new Error('OAuth endpoint not allowed');
    return (await this.raw('https://auth.trakt.tv', path, { method: 'POST', body })).data;
  }
  async saveToken(token) {
    if (!token?.access_token || !token.refresh_token || !Number.isFinite(token.expires_in) || !Number.isFinite(token.created_at)) throw new RemoteError('TRAKT_INVALID_TOKEN');
    await this.store.writeSecret('tokens', token);
    return token;
  }
  async refresh(staleAccessToken) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const old = await this.store.readSecret('tokens');
      if (!old) throw new RemoteError('TRAKT_AUTH_REQUIRED');
      if (staleAccessToken && old.access_token !== staleAccessToken) return old;
      const body = { refresh_token: old.refresh_token, client_id: this.clientId, grant_type: 'refresh_token', redirect_uri: this.redirectUri };
      try { return await this.saveToken(await this.oauth('/oauth/token', body)); }
      catch (e) {
        // Never discard a valid watched snapshot on OAuth failure.
        if (['TRAKT_HTTP_400', 'TRAKT_UNAUTHORIZED'].includes(e.code)) throw new RemoteError('TRAKT_REAUTHORIZE');
        throw e;
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async get(path, query = {}, authenticated = true) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid Trakt path');
    let token = authenticated ? await this.store.readSecret('tokens') : null;
    if (authenticated && !token) throw new RemoteError('TRAKT_AUTH_REQUIRED');
    if (token && (token.created_at + token.expires_in) * 1000 < this.now() + 60000) token = await this.refresh(token.access_token);
    const suffix = new MCUQuery(query).toString();
    const url = path + (suffix ? '?' + suffix : '');
    try { return await this.raw('https://api.trakt.tv', url, { accessToken: token?.access_token }); }
    catch (e) {
      if (e.code !== 'TRAKT_UNAUTHORIZED' || !authenticated) throw e;
      token = await this.refresh(token.access_token);
      return this.raw('https://api.trakt.tv', url, { accessToken: token.access_token });
    }
  }
  async pages(path, query = {}, authenticated = true) {
    const all = [];
    const seenPages = new Set();
    for (let page = 1; page <= 10000; page++) {
      const response = await this.get(path, { ...query, page: String(page), limit: '100' }, authenticated);
      if (!Array.isArray(response.data)) throw new RemoteError('TRAKT_INVALID_RESPONSE');
      if (!response.data.length) return all;
      const signature = JSON.stringify(response.data);
      if (seenPages.has(signature)) throw new RemoteError('TRAKT_REPEATED_PAGE');
      seenPages.add(signature);
      all.push(...response.data);
      const count = Number(response.headers.get('x-pagination-page-count'));
      if (count > 0 && page >= count) return all;
      // A short page may be the server's applied limit, not the requested limit.
      // Without a reliable page count, continue until an empty array.
    }
    throw new RemoteError('TRAKT_TOO_MANY_PAGES');
  }
}


function idsOf(entry) { return entry?.ids || {}; }
function matches(a, b) {
  const left = a.ids || { tmdb: a.tmdbId, imdb: a.imdbId, trakt: a.traktId };
  const right = idsOf(b);
  return ['trakt', 'tmdb', 'imdb'].some(k => left[k] != null && right[k] != null && String(left[k]) === String(right[k]));
}
function nextEpisode(entry, watched, now = Date.now()) {
  const show = watched.find(w => matches(entry, w.show));
  const done = new Set((show?.seasons || []).flatMap(s => s.episodes.filter(e => e.plays > 0 && (!show.reset_at || Date.parse(e.last_watched_at) >= Date.parse(show.reset_at))).map(e => s.number + ':' + e.number)));
  const episodes = (entry.episodes || []).filter(e => e.firstAired && Date.parse(e.firstAired) <= now);
  const remaining = episodes.filter(e => !done.has(e.season + ':' + e.number));
  return { next: remaining[0] || null, remaining: remaining.length, complete: entry.segmentComplete === true && episodes.length > 0 && remaining.length === 0, watched: episodes.length - remaining.length };
}
function buildQueue(timeline, snapshot, now = Date.now(), nativePresentation = false) {
  if (!snapshot?.movies || !snapshot?.shows) throw new Error('WATCH_STATE_UNAVAILABLE');
  const items = [];
  for (const entry of [...timeline.entries].sort((a, b) => a.timelineOrder - b.timelineOrder)) {
    if (!['available', 'released'].includes(entry.availabilityStatus) || !entry.releaseDate || Date.parse(entry.releaseDate) > now) continue;
    if (!entry.tmdbId) continue;
    let progress = null;
    if (entry.mediaType === 'movie') {
      if (snapshot.movies.some(w => w.plays > 0 && matches(entry, w.movie))) continue;
    } else {
      progress = nextEpisode(entry, snapshot.shows, now);
      if (progress.complete) continue;
      if (!progress.next) continue; // released episodes all watched, future episodes cannot lead the queue
    }
    if (nativePresentation) {
      items.push({
        id: String(entry.tmdbId), tmdbId: entry.tmdbId, type: 'tmdb', mediaType: entry.mediaType,
        title: entry.originalTitle, releaseDate: entry.releaseDate,
        ...(progress?.next ? { season: progress.next.season, episode: progress.next.number } : {})
      });
      continue;
    }
    const paused = (snapshot.playback || []).find(p => p.progress > 0 && p.progress < 100 && (entry.mediaType === 'movie' ? p.type === 'movie' && matches(entry, p.movie) : p.type === 'episode' && matches(entry, p.show) && p.episode?.season === progress.next.season && p.episode?.number === progress.next.number));
    const live = snapshot.watching && Date.parse(snapshot.watching.expires_at) > now && Date.parse(snapshot.watching.started_at) <= now && (entry.mediaType === 'movie' ? snapshot.watching.type === 'movie' && matches(entry, snapshot.watching.movie) : snapshot.watching.type === 'episode' && matches(entry, snapshot.watching.show) && snapshot.watching.episode?.season === progress.next.season && snapshot.watching.episode?.number === progress.next.number);
    const status = live ? '正在观看' : paused ? '继续观看 ' + Math.round(paused.progress) + '%' : progress?.watched ? '部分观看' : '未观看';
    const next = progress?.next ? '下一集：S' + String(progress.next.season).padStart(2, '0') + 'E' + String(progress.next.number).padStart(2, '0') : '';
    const segment = entry.mediaType === 'tv' ? '第' + entry.season + '季' : '';
    const notices = snapshot.warning ? '同步提示：' + snapshot.warning + '；上次成功：' + snapshot.syncedAt : '';
    items.push({
      id: entry.mediaType + '.' + entry.tmdbId, type: 'tmdb', mediaType: entry.mediaType,
      title: [entry.title || entry.originalTitle, segment, next || status].filter(Boolean).join(' · '),
      releaseDate: entry.releaseDate, posterPath: entry.posterPath || undefined, backdropPath: entry.backdropPath || undefined,
      description: [entry.originalTitle, entry.timelineEra, entry.universe === 'multiverse' ? '多元宇宙分支 · 官方推荐观影位置' : entry.universe === 'official-unclassified' ? '官方已收录；宇宙归属待核实' : '', status, next, entry.overview, 'Trakt 同步：' + snapshot.syncedAt, notices].filter(Boolean).join('\n'),
      ...(progress?.next ? { season: progress.next.season, episode: progress.next.number } : {})
    });
  }
  return items;
}

class WatchSync {
  constructor(trakt, store, ttl = 600000, now = Date.now) { Object.assign(this, { trakt, store, ttl, now }); this.pending = null; this.nextAttempt = 0; }
  async load(force = false, cacheOnly = false, includePlayback = true) {
    const old = await this.store.read('watched');
    if (old && (cacheOnly || (!force && this.now() - Date.parse(old.syncedAt) < this.ttl))) return old;
    if (this.pending) return this.pending;
    if (this.now() < this.nextAttempt) {
      if (old) return { ...old, warning: '观看状态暂不可刷新，使用缓存' };
      throw new Error('WATCH_SYNC_RETRY_LATER');
    }
    this.pending = (async () => {
      try {
        let activities;
        try { activities = (await this.trakt.get('/sync/last_activities')).data; }
        catch (error) {
          if (error.code !== 'TRAKT_HTTP_404') throw error;
        }
        const unchanged = (kind, field) => Boolean(
          activities?.[kind]?.[field] && old?.activities?.[kind]?.[field] === activities[kind][field]
        );
        const [movies, shows] = await Promise.all([
          unchanged('movies', 'watched_at') ? old.movies : this.trakt.get('/sync/watched/movies').then(r => r.data),
          unchanged('episodes', 'watched_at') ? old.shows : this.trakt.get('/sync/watched/shows', { extended: 'progress' }).then(r => r.data)
        ]);
        if (!Array.isArray(movies) || !Array.isArray(shows)) throw new Error('TRAKT_INVALID_RESPONSE');
        if (shows.some(s => !Array.isArray(s?.seasons) || s.seasons.some(season => !Array.isArray(season?.episodes)))) {
          throw new Error('TRAKT_MISSING_EPISODES');
        }
        let playback = includePlayback ? old?.playback || [] : [], watching = null, playbackWarning;
        try {
          if (includePlayback && (!(unchanged('movies', 'paused_at') && unchanged('episodes', 'paused_at')) || old?.warning)) {
            playback = await this.trakt.pages('/sync/playback');
          }
          if (includePlayback) watching = (await this.trakt.get('/users/me/watching')).data;
        } catch { playbackWarning = '播放进度暂不可用；已观看记录已同步'; }
        const next = { movies, shows, playback, watching, activities, syncedAt: new Date(this.now()).toISOString(), warning: playbackWarning };
        await this.store.write('watched', next);
        this.nextAttempt = 0;
        return next;
      } catch (e) {
        this.nextAttempt = Math.max(this.now() + 60000, e.retryAt || 0);
        if (!old) throw e;
        return { ...old, warning: (e.code || e.message || 'WATCH_SYNC_FAILED').split(':')[0] + '，使用最近有效记录' };
      }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}



const SOURCE = 'https://www.marvel.com/articles/movies/mcu-timeline-order-disney-plus';
function normalize(value) {
  return value.normalize('NFKD').toLowerCase()
    .replace(/^marvel(?: studios)?\s+one[ -]?shot\s*:?\s*/, '')
    .replace(/^marvel['’]s\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}
const text = html => html.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/g, ' ').trim();
function parseOfficial(html) {
  // Deliberately narrow parser: a redesign is a review event, never an empty catalog.
  const section = html.match(/<h[1-6][^>]*>\s*MCU Complete Timeline\s*<\/h[1-6]>\s*<ul[^>]*>([\s\S]*?)<\/ul>/i);
  if (!section) throw new Error('OFFICIAL_FORMAT_CHANGED');
  const labels = [...section[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => text(m[1]));
  if (labels.length < 50 || new Set(labels.map(normalize)).size !== labels.length) throw new Error('OFFICIAL_LIST_INVALID');
  return labels;
}

class Timeline {
  constructor({ store, trakt, tmdbBearer, fetchImpl = fetch, now = Date.now, seedLoader }) {
    Object.assign(this, { store, trakt, tmdbBearer, fetchImpl, now });
    this.seedLoader = seedLoader;
    this.updating = null;
  }
  async load() { return await this.store.read('timeline') || await this.seedLoader(); }
  async identify(entry) {
    const kind = entry.mediaType === 'tv' ? 'show' : 'movie';
    if (entry.traktId && entry.tmdbId) return entry;
    const names = [entry.originalTitle, ...(entry.searchAliases || [])];
    const found = new Map();
    for (const query of names) {
      const results = await this.trakt.pages('/search/' + kind + '/exact', { query }, false);
      for (const result of results) {
        const media = result[kind];
        if (!media?.ids?.trakt || !media.ids.tmdb) continue;
        if (!names.some(n => normalize(n) === normalize(media.title))) continue;
        if (entry.searchYear && media.year !== entry.searchYear) continue;
        found.set(media.ids.trakt, media);
      }
      if (found.size) break;
    }
    if (found.size !== 1) throw new Error('IDENTITY_REVIEW_REQUIRED:' + entry.stableId);
    const media = [...found.values()][0];
    return { ...entry, tmdbId: media.ids.tmdb, traktId: media.ids.trakt, imdbId: media.ids.imdb || null, identitySource: 'Trakt exact title + media type + year', identityVerifiedAt: new Date(this.now()).toISOString() };
  }
  async enrich(entry) {
    entry = await this.identify(entry);
    const route = (entry.mediaType === 'tv' ? '/shows/' : '/movies/') + entry.traktId;
    const media = (await this.trakt.get(route, { extended: 'full' }, false)).data;
    if (media.ids?.trakt !== entry.traktId || media.ids?.tmdb !== entry.tmdbId) throw new Error('MEDIA_ID_CHANGED');
    const result = { ...entry, overview: media.overview || '', metadataVerifiedAt: new Date(this.now()).toISOString() };
    if (entry.mediaType === 'movie') {
      result.releaseDate = media.released || null;
      result.availabilityStatus = media.released && Date.parse(media.released) <= this.now() ? 'released' : 'announced';
    } else {
      const episodes = (await this.trakt.get(route + '/seasons/' + entry.season, { extended: 'full' }, false)).data;
      const seasons = (await this.trakt.get(route + '/seasons', { extended: 'full' }, false)).data;
      if (!Array.isArray(episodes) || !Array.isArray(seasons)) throw new Error('EPISODE_METADATA_INVALID');
      const selected = episodes.filter(e => e.season === entry.season && e.number > 0 && (!entry.episodeRange || (e.number >= entry.episodeRange[0] && e.number <= entry.episodeRange[1]))).sort((a, b) => a.number - b.number);
      if (selected.some(e => !e.ids?.trakt)) throw new Error('EPISODE_METADATA_INCOMPLETE:' + entry.stableId);
      result.episodes = selected.map(e => ({ season: e.season, number: e.number, firstAired: e.first_aired, traktId: e.ids.trakt }));
      const total = entry.episodeRange ? entry.episodeRange[1] - entry.episodeRange[0] + 1 : seasons.find(s => s.number === entry.season)?.episode_count;
      const aired = selected.filter(e => e.first_aired && Date.parse(e.first_aired) <= this.now());
      result.segmentComplete = Number.isInteger(total) && total > 0 && total === selected.length && aired.length === total;
      result.releaseDate = aired[0]?.first_aired || selected[0]?.first_aired || null;
      result.availabilityStatus = aired.length ? 'available' : 'announced';
    }
    if (this.tmdbBearer) {
      try {
        const response = await this.fetchImpl('https://api.themoviedb.org/3/' + entry.mediaType + '/' + entry.tmdbId + '?language=zh-CN', { headers: { Authorization: 'Bearer ' + this.tmdbBearer }, signal: undefined, redirect: 'error' });
        if (response.ok) {
          const tmdb = await response.json();
          if (tmdb.id !== entry.tmdbId) throw new Error('TMDB_ID_CHANGED');
          result.title = tmdb.title || tmdb.name || result.title;
          result.overview = tmdb.overview || result.overview;
          result.posterPath = tmdb.poster_path;
          result.backdropPath = tmdb.backdrop_path;
        }
      } catch { result.metadataNotice = 'TMDB 元数据刷新失败，保留 Trakt 元数据'; }
    }
    return result;
  }
  async checkOfficial(old) {
    const response = await this.fetchImpl(SOURCE, { signal: undefined, redirect: 'error', headers: { 'User-Agent': 'Personal-MCU-Timeline/0.1' } });
    if (!response.ok) throw new Error('OFFICIAL_HTTP_' + response.status);
    const html = await response.text();
    if (html.length > 5_000_000) throw new Error('OFFICIAL_RESPONSE_TOO_LARGE');
    const labels = parseOfficial(html);
    if (labels.length < old.entries.length * 0.8) throw new Error('OFFICIAL_TOO_MANY_REMOVALS');
    const known = new Map(old.entries.map(e => [normalize(e.officialLabel), e]));
    const entries = [], proposals = [];
    for (const [i, label] of labels.entries()) {
      let entry = known.get(normalize(label));
      if (!entry) {
        const seasonMatch = label.match(/\s+S(\d+)$/i);
        const title = label.replace(/\s+S\d+$/i, '').trim();
        const previousSeason = old.entries.find(e => normalize(e.originalTitle) === normalize(title) && e.mediaType === 'tv');
        if (previousSeason && seasonMatch) {
          entry = { ...previousSeason, stableId: previousSeason.stableId.replace(/-s\d+$/, '-s' + seasonMatch[1]), season: Number(seasonMatch[1]), officialLabel: label, episodes: [], segmentComplete: false };
        } else {
          const candidates = [];
          for (const kind of ['movie', 'show']) {
            const results = await this.trakt.pages('/search/' + kind + '/exact', { query: title }, false);
            for (const row of results) {
              const media = row[kind];
              if (media?.ids?.trakt && media.ids.tmdb && normalize(media.title) === normalize(title)) candidates.push({ kind, media });
            }
          }
          const unique = [...new Map(candidates.map(c => [c.kind + ':' + c.media.ids.trakt, c])).values()];
          if (unique.length === 1) {
            const { kind, media } = unique[0];
            let season = seasonMatch ? Number(seasonMatch[1]) : null;
            if (kind === 'show' && !season) {
              const seasons = (await this.trakt.get('/shows/' + media.ids.trakt + '/seasons', { extended: 'full' }, false)).data;
              const regular = Array.isArray(seasons) ? seasons.filter(s => s.number > 0) : [];
              if (regular.length === 1 && regular[0].number === 1) season = 1;
            }
            if (kind === 'movie' || season) entry = {
              stableId: 'mcu-trakt-' + kind + '-' + media.ids.trakt + (season ? '-s' + season : ''),
              title, originalTitle: title, officialLabel: label, mediaType: kind === 'show' ? 'tv' : 'movie',
              tmdbId: media.ids.tmdb, traktId: media.ids.trakt, imdbId: media.ids.imdb || null,
              searchYear: media.year, season, episodeRange: null, universe: 'official-unclassified',
              availabilityStatus: 'pending_metadata', releaseDate: null,
              identitySource: 'Unique Trakt exact match; membership/order verified in Marvel complete timeline'
            };
          }
          if (!entry) {
            proposals.push({ label, officialPosition: i + 1, source: SOURCE, reason: 'NEW_TITLE_IDENTITY_OR_SEASON_REVIEW' });
            continue;
          }
        }
      }
      entries.push({ ...entry, timelineOrder: (i + 1) * 10, timelineEra: '官方完整时间线第' + (i + 1) + '位' + (entry.universe === 'multiverse' ? '（推荐观影位置）' : '（主体故事顺序）'), lastVerifiedAt: new Date(this.now()).toISOString(), chronologySource: [{ url: SOURCE, basis: 'rendered-list-label', position: i + 1 }] });
    }
    if (proposals.length) await this.store.write('timeline-proposals', { checkedAt: new Date(this.now()).toISOString(), proposals });
    // Avoid silently losing a formerly verified title if official text changes spelling.
    const missing = old.entries.filter(e => !entries.some(n => n.stableId === e.stableId));
    if (missing.length) throw new Error('OFFICIAL_REMOVAL_REVIEW_REQUIRED');
    return { ...old, entries, sourceWarning: undefined, pendingReview: proposals.length, officialCheckedAt: new Date(this.now()).toISOString() };
  }
  async update({ maxNewEntries = Infinity, deadline = Infinity, verifyOfficial = true, tolerateMissing = false, current } = {}) {
    if (this.updating) return this.updating;
    this.updating = (async () => {
      const old = current || await this.load();
      let candidate = old;
      if (verifyOfficial) {
        const pending = Number.isFinite(maxNewEntries) ? await this.store.read('pending-catalog') : null;
        if (pending?.version === old.version && this.now() < pending.expiresAt) {
          candidate = pending.candidate;
        } else {
          try { candidate = await this.checkOfficial(old); }
          catch (e) { candidate = { ...old, sourceWarning: e.message.split(':')[0] }; }
          if (Number.isFinite(maxNewEntries)) await this.store.write('pending-catalog', { version: old.version, expiresAt: this.now() + 3600000, candidate });
        }
      }
      const entries = [];
      try {
        const metadata = await this.store.read('metadata-cache') || {};
        let fetched = 0;
        for (const e of candidate.entries) {
          const cached = metadata[e.stableId];
          let resolved;
          if (cached && cached.originalTitle === e.originalTitle && cached.mediaType === e.mediaType &&
              cached.season === e.season && String(cached.episodeRange) === String(e.episodeRange) &&
              this.now() - Date.parse(cached.metadataVerifiedAt) < 23 * 3600000) {
            // Keep fresh chronology fields from the official list, but reuse expensive
            // IDs/episodes/artwork independently of the watched-state cache.
            resolved = { ...e, ...cached, timelineOrder: e.timelineOrder, timelineEra: e.timelineEra, chronologySource: e.chronologySource, lastVerifiedAt: e.lastVerifiedAt };
          } else {
            if (fetched >= maxNewEntries || (fetched > 0 && this.now() >= deadline)) {
              return { ...candidate, entries, metadataStatus: 'initializing', totalEntries: candidate.entries.length };
            }
            try { resolved = await this.enrich(e); }
            catch (error) {
              if (!tolerateMissing || !/^(IDENTITY_REVIEW_REQUIRED:|EPISODE_METADATA_INCOMPLETE:)/.test(error.message)) throw error;
              resolved = { ...e, availabilityStatus: 'pending_metadata', metadataVerifiedAt: new Date(this.now()).toISOString() };
            }
            fetched++;
            metadata[e.stableId] = resolved;
            // Checkpoint initialization so a rate limit on item 80 doesn't cause
            // the next attempt to download items 1–79 again.
            await this.store.write('metadata-cache', metadata);
          }
          entries.push(resolved);
        }
        const revision = mcuVersion(JSON.stringify(entries));
        const next = { ...candidate, entries, metadataStatus: 'resolved', version: new Date(this.now()).toISOString().slice(0, 10) + '.' + revision, updatedAt: new Date(this.now()).toISOString() };
        await this.store.write('timeline', next);
        await this.store.write('update-status', { success: true, checkedAt: next.updatedAt, sourceWarning: next.sourceWarning, pendingReview: next.pendingReview || 0 });
        return next;
      } catch (e) {
        await this.store.write('update-status', { success: false, checkedAt: new Date(this.now()).toISOString(), retryAt: Math.max(this.now() + 300000, e.retryAt || 0), error: e.message.split(':')[0] });
        throw e;
      }
    })().finally(() => { this.updating = null; });
    return this.updating;
  }
}
