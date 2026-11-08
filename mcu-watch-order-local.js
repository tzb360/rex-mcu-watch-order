// This file is concatenated with shared, tested core code by build-local.mjs.
// Trakt Client ID is public. No account token or client secret is distributed.
var MCU_CLIENT_ID = 'jik3qry8gfgZ1jhnC8txpNYnoA1eImB_zz-nBDtGbiI';
var MCU_SEED_URL = 'https://raw.githubusercontent.com/tzb360/rex-mcu-watch-order/main/timeline.seed.json';
var WidgetMetadata = {
  id: 'personal.mcu.timeline.local', title: '漫威宇宙时间线 · 本地版',
  description: '本机直接读取 Trakt，不需要常驻 AWS 后端。授权记录保存于 Rex 模块本地存储；未确认其采用系统钥匙串。仅供本人使用。',
  author: 'Personal MCU Timeline', site: 'https://www.marvel.com/articles/movies/mcu-timeline-order-disney-plus',
  version: '0.2.0', requiredVersion: '0.0.1', detailCacheDuration: 60,
  modules: [{
    id: 'mcu-local', title: '漫威宇宙观影顺序', functionName: 'loadMcuLocal', cacheDuration: 0, requiresWebView: false,
    params: [
      { name: 'action', title: '操作', type: 'enumeration', value: 'watch', enumOptions: [
        { title: '查看待看清单', value: 'watch' }, { title: '连接 Trakt', value: 'connect' },
        { title: '我已完成授权', value: 'confirm' }, { title: '立即同步观看记录', value: 'refresh' },
        { title: '更新官方时间线', value: 'catalog' }, { title: '检查运行环境', value: 'diagnose' }
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
  if (options.method === 'POST') {
    response = await Widget.http.post(url, options.body ? JSON.parse(options.body) : {}, { headers: options.headers || {} });
  } else {
    response = await Widget.http.get(url, { headers: options.headers || {} });
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
var mcuLocalTimeline = null;
var mcuLocalSync = null;
var mcuLocalOperation = null;
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
async function mcuLocalRun(params) {
  if (typeof Widget === 'undefined' || !Widget.http || !Widget.storage || !Widget.storage.get || !Widget.storage.set) throw new Error('此 Rex 运行环境缺少 HTTP 或持久化存储接口，无法运行本地版。');
  var page = Number(params.page || 1);
  if (!Number.isInteger(page) || page < 1) throw new Error('页码无效。');
  mcuLocalTrakt = mcuLocalTrakt || new Trakt({ clientId: MCU_CLIENT_ID, redirectUri: 'http://127.0.0.1:8788/callback', store: mcuLocalStore, fetchImpl: mcuNativeFetch });
  // Persist the provider's backoff between client script invocations.
  mcuLocalTrakt.blockedUntil = await mcuLocalStore.read('blocked-until') || 0;
  var action = params.action || 'watch';
  if (action === 'diagnose') {
    var marker = 'storage-check-' + Date.now();
    await mcuLocalStore.write('probe', marker);
    var roundTrip = (await mcuLocalStore.read('probe')) === marker;
    var result = await mcuLocalTrakt.get('/movies/iron-man-2008', {}, false);
    var authorized = Boolean(await mcuLocalStore.readSecret('tokens'));
    return mcuLocalStatus('本地诊断：存储读写=' + (roundTrip ? '成功' : '失败') + '；Trakt GET=' + result.status + '；TMDB=' + Boolean(Widget.tmdb && Widget.tmdb.get) + '；Trakt 授权=' + (authorized ? '已连接' : '未连接') + '。未读取或修改观看记录。');
  }
  if (action === 'connect' || action === 'confirm') return mcuAuthorizeDevice(action);
  var token = await mcuLocalStore.readSecret('tokens');
  if (!token) throw new Error('请先将“操作”选择为“连接 Trakt”。');
  var seedUrl = String(params.seedUrl || MCU_SEED_URL);
  if (!/^https:\/\/[^\s?#@]+$/.test(seedUrl)) throw new Error('请填写可信的 HTTPS 时间线 JSON 地址。');
  mcuLocalTimeline = new Timeline({ store: mcuLocalStore, trakt: mcuLocalTrakt, fetchImpl: mcuNativeFetch, seedLoader: async function () {
    var response = await mcuNativeFetch(seedUrl);
    if (!response.ok) throw new Error('TIMELINE_SEED_UNAVAILABLE');
    var seed = await response.json();
    if (seed.schemaVersion !== 1 || !Array.isArray(seed.entries) || seed.entries.length < 50 || seed.entries.some(function (e) { return !e.stableId || !e.originalTitle || !Array.isArray(e.chronologySource) || !e.chronologySource.some(function (s) { return s.url === SOURCE; }); })) throw new Error('TIMELINE_SEED_INVALID');
    return seed;
  } });
  var timeline = await mcuLocalTimeline.load();
  var status = await mcuLocalStore.read('update-status');
  var due = !status || (status.success ? Date.now() - Date.parse(status.checkedAt) >= 86400000 : Date.now() >= status.retryAt);
  if (action === 'catalog' || due || timeline.metadataStatus !== 'resolved') {
    try { timeline = await mcuLocalTimeline.update(); }
    catch (error) { if (timeline.metadataStatus !== 'resolved') throw error; }
  }
  mcuLocalSync = mcuLocalSync || new WatchSync(mcuLocalTrakt, mcuLocalStore, 600000);
  var snapshot = await mcuLocalSync.load(action === 'refresh');
  var updateStatus = await mcuLocalStore.read('update-status');
  var warning = [snapshot.warning, timeline.sourceWarning, updateStatus && updateStatus.success === false ? '时间线更新失败，使用上次有效数据' : '', timeline.pendingReview ? timeline.pendingReview + '部新作品待核实' : '', Date.now() - Date.parse(timeline.updatedAt) > 172800000 ? '时间线超过48小时未更新' : ''].filter(Boolean).join('；');
  var items = buildQueue(timeline, Object.assign({}, snapshot, { warning: warning }));
  if (!items.length && page === 1) throw new Error('当前已核实、已发行的 MCU 内容已全部完成。' + warning);
  var selected = items.slice((page - 1) * 30, page * 30);
  var output = [];
  for (var offset = 0; offset < selected.length; offset += 3) output = output.concat(await Promise.all(selected.slice(offset, offset + 3).map(mcuLocalArtwork)));
  if (warning && output.length) output[0].title = '【同步提示】' + output[0].title;
  return output;
}
async function mcuLocalArtwork(item) {
  if (!Widget.tmdb || !Widget.tmdb.get) return item;
  var key = 'artwork.' + item.id;
  var cached = await mcuLocalStore.read(key);
  try {
    if (!cached || Date.now() - cached.checkedAt > 86400000) {
      var response = await Widget.tmdb.get(item.id.replace('.', '/'), { params: { language: 'zh-CN' } });
      var media = response && response.data !== undefined ? response.data : response;
      if (typeof media === 'string') media = JSON.parse(media);
      if (!media || String(media.id) !== item.id.split('.')[1]) throw new Error('TMDB_ID_INVALID');
      cached = { checkedAt: Date.now(), title: media.title || media.name, posterPath: media.poster_path, backdropPath: media.backdrop_path, overview: media.overview };
      await mcuLocalStore.write(key, cached);
    }
  } catch (_) { /* Preserve Trakt identity/details and the previous valid artwork. */ }
  if (cached) {
    if (cached.title) item.title = cached.title + item.title.slice(item.title.indexOf(' · ') >= 0 ? item.title.indexOf(' · ') : item.title.length);
    item.posterPath = cached.posterPath || item.posterPath;
    item.backdropPath = cached.backdropPath || item.backdropPath;
    if (cached.overview) item.description += '\n' + cached.overview;
  }
  return item;
}
async function loadMcuLocal(params) {
  if (mcuLocalOperation) return mcuLocalOperation;
  mcuLocalOperation = mcuLocalRun(params || {}).catch(async function (error) {
    if (mcuLocalTrakt && mcuLocalTrakt.blockedUntil) await mcuLocalStore.write('blocked-until', mcuLocalTrakt.blockedUntil);
    if (error.code === 'TRAKT_NETWORK') throw new Error('Rex 无法连接 Trakt，请检查网络；本地缓存和观看记录保留。');
    if (error.code === 'TRAKT_REAUTHORIZE' || error.code === 'TRAKT_AUTH_REQUIRED') throw new Error('Trakt 授权已失效，请选择“连接 Trakt”重新授权；已有缓存保留。');
    if (error.code === 'TRAKT_RATE_LIMIT') throw new Error('Trakt 请求限流，请于 ' + new Date(error.retryAt).toISOString() + ' 后重试。');
    throw error;
  }).catch(function (error) { return mcuLocalStatus('设置或同步提示：' + error.message); }).finally(async function () {
    if (mcuLocalTrakt && mcuLocalTrakt.blockedUntil) await mcuLocalStore.write('blocked-until', mcuLocalTrakt.blockedUntil);
    mcuLocalOperation = null;
  });
  return mcuLocalOperation;
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
    let data = null;
    const text = await response.text();
    if (text) { try { data = JSON.parse(text); } catch { throw new RemoteError('TRAKT_INVALID_RESPONSE'); } }
    if (!response.ok) throw new RemoteError(response.status === 401 ? 'TRAKT_UNAUTHORIZED' : 'TRAKT_HTTP_' + response.status);
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
  const done = new Set((show?.seasons || []).flatMap(s => s.episodes.filter(e => e.plays > 0).map(e => s.number + ':' + e.number)));
  const episodes = (entry.episodes || []).filter(e => e.firstAired && Date.parse(e.firstAired) <= now);
  const remaining = episodes.filter(e => !done.has(e.season + ':' + e.number));
  return { next: remaining[0] || null, remaining: remaining.length, complete: entry.segmentComplete === true && episodes.length > 0 && remaining.length === 0, watched: episodes.length - remaining.length };
}
function buildQueue(timeline, snapshot, now = Date.now()) {
  if (!snapshot?.movies || !snapshot?.shows) throw new Error('WATCH_STATE_UNAVAILABLE');
  const items = [];
  for (const entry of [...timeline.entries].sort((a, b) => a.timelineOrder - b.timelineOrder)) {
    if (!['available', 'released'].includes(entry.availabilityStatus) || !entry.releaseDate || Date.parse(entry.releaseDate) > now) continue;
    if (!entry.tmdbId) throw new Error('METADATA_INCOMPLETE:' + entry.stableId);
    let progress = null;
    if (entry.mediaType === 'movie') {
      if (snapshot.movies.some(w => w.plays > 0 && matches(entry, w.movie))) continue;
    } else {
      progress = nextEpisode(entry, snapshot.shows, now);
      if (progress.complete) continue;
      if (!progress.next) continue; // released episodes all watched, future episodes cannot lead the queue
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
      ...(progress?.next ? { episode: progress.next.number } : {})
    });
  }
  return items;
}

class WatchSync {
  constructor(trakt, store, ttl = 600000, now = Date.now) { Object.assign(this, { trakt, store, ttl, now }); this.pending = null; this.nextAttempt = 0; }
  async load(force = false) {
    const old = await this.store.read('watched');
    if (!force && old && this.now() - Date.parse(old.syncedAt) < this.ttl) return old;
    if (this.pending) return this.pending;
    if (this.now() < this.nextAttempt) {
      if (old) return { ...old, warning: '观看状态暂不可刷新，使用缓存' };
      throw new Error('WATCH_SYNC_RETRY_LATER');
    }
    this.pending = (async () => {
      try {
        // Fetch watched state before playback; commit only a complete snapshot.
        const movies = await this.trakt.pages('/sync/watched/movies');
        const shows = await this.trakt.pages('/sync/watched/shows', { extended: 'progress' });
        if (shows.some(s => !Array.isArray(s.seasons))) throw new Error('TRAKT_MISSING_EPISODES');
        let playback = [], watching = null, playbackWarning;
        try {
          playback = await this.trakt.pages('/sync/playback');
          watching = (await this.trakt.get('/users/me/watching')).data;
        } catch { playbackWarning = '播放进度暂不可用；已观看记录已同步'; }
        const next = { movies, shows, playback, watching, syncedAt: new Date(this.now()).toISOString(), warning: playbackWarning };
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
    return { ...old, entries, pendingReview: proposals.length, officialCheckedAt: new Date(this.now()).toISOString() };
  }
  async update() {
    if (this.updating) return this.updating;
    this.updating = (async () => {
      const old = await this.load();
      let candidate;
      try { candidate = await this.checkOfficial(old); }
      catch (e) { candidate = { ...old, sourceWarning: e.message.split(':')[0] }; }
      const entries = [];
      try {
        const metadata = await this.store.read('metadata-cache') || {};
        for (const e of candidate.entries) {
          const cached = metadata[e.stableId];
          let resolved;
          if (cached && this.now() - Date.parse(cached.metadataVerifiedAt) < 23 * 3600000) {
            // Keep fresh chronology fields from the official list, but reuse expensive
            // IDs/episodes/artwork independently of the watched-state cache.
            resolved = { ...e, ...cached, timelineOrder: e.timelineOrder, timelineEra: e.timelineEra, chronologySource: e.chronologySource, lastVerifiedAt: e.lastVerifiedAt };
          } else {
            resolved = await this.enrich(e);
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
