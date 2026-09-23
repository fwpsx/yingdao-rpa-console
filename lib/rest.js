/**
 * 影刀本地 REST API 客户端
 *
 * 影刀客户端（ShadowBot.Shell.exe）内置 EmbedIO HTTP 服务器，监听 127.0.0.1:42500，
 * 前缀 /api/v1。CLI 本质是它的封装，每条 CLI 命令有 ~1.1s 进程启动开销。
 * 直连 REST 只需 1~80ms，比 CLI 快 30~1000 倍。
 */
const http = require('http');
const config = require('../config');

/**
 * 调影刀本地 REST API，返回 { ok, status, code, data } 统一结构
 * 影刀响应体是 PascalCase 的 { Code, Message, Data }，这里转成小写便于前端使用
 */
function rest(path, method, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: config.REST_HOST, port: config.REST_PORT,
      path: config.REST_BASE + path,
      method: method || 'GET',
      timeout: config.REST_TIMEOUT,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          // 影刀标准响应 { Code, Message, Data }
          if (j && typeof j.Code !== 'undefined') {
            resolve({ ok: j.Code === 0, status: res.statusCode, code: j.Code, message: j.Message, data: j.Data });
          } else {
            resolve({ ok: true, status: res.statusCode, data: j });
          }
        } catch {
          resolve({ ok: false, status: res.statusCode, error: d.substring(0, 300) });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 'TIMEOUT', error: 'REST 超时' }); });
    req.on('error', (e) => resolve({ ok: false, status: 'ERR', error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

// ================= REST 可用性探测 =================
// 可用 → 长期缓存（避免每次数据获取都多打一次探测请求）；
// 不可用 → 只缓存 REST_DOWN_RETRY_MS，到点重探。
// 为什么"不可用"不能长期缓存：影刀晚于本服务启动是常见场景，若永久记住"不可用"，
// 之后影刀起来了也永远走 CLI（每条命令约 1.1s 进程开销），账号哨兵也会一直退化到 CLI 分支。
const REST_DOWN_RETRY_MS = 30000;
let restState = { ok: null, ts: 0 };

async function restReady() {
  const now = Date.now();
  if (restState.ok === true) return true;
  if (restState.ok === false && now - restState.ts < REST_DOWN_RETRY_MS) return false;
  const r = await rest('/operator/state');
  restState = { ok: !!(r && r.ok), ts: Date.now() };
  return restState.ok;
}
function resetRestReady() { restState = { ok: null, ts: 0 }; }

// ================= 分页上限（影刀 REST 的硬限制） =================
// 实测：请求 PageSize=1000 / 100000 时服务端回显并截断为 500；
// 且影刀 REST 不支持翻页（PageIndex=2 仍返回第 1 页），响应体里也没有 Total 字段。
// 因此"取满单页上限"是判断结果是否可能被截断的唯一可用信号。
const REST_MAX_PAGE_SIZE = 500;

// 是否为"取满上限"的页。为真表示无法确认后面还有没有数据，
// 调用方应放弃 REST 结果、回退到 CLI 全量分页，避免静默丢数据。
function isTruncatedPage(items) {
  return Array.isArray(items) && items.length >= REST_MAX_PAGE_SIZE;
}

// REST 重查询缓存（apps 全量列表返回 34KB，是 Dashboard 最慢的子查询）
// 只缓存少量稳定的大结果，写操作后清空
const REST_CACHE = new Map();
async function cachedRest(path, ttl) {
  const ttlMs = ttl || config.REST_CACHE_TTL;
  const hit = REST_CACHE.get(path);
  if (hit && Date.now() - hit.ts < ttlMs) {
    return Object.assign({ fromCache: true }, hit.data);
  }
  const r = await rest(path);
  if (r.ok) REST_CACHE.set(path, { data: r, ts: Date.now() });
  return r;
}
function clearRestCache() { REST_CACHE.clear(); }

module.exports = {
  rest, restReady, resetRestReady, cachedRest, clearRestCache,
  REST_MAX_PAGE_SIZE, isTruncatedPage,
};
