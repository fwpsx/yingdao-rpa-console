/**
 * 通用工具函数（零依赖）
 */
const fs = require('fs');
const zlib = require('zlib');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readBody(req, limitMb) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const limit = (limitMb || 10) * 1024 * 1024;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * 客户端错误（4xx）：带 status 抛出，让 server.js 的兜底按状态码返回，
 * 而不是把客户端错误一律报成 500。
 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * 读取并解析 JSON 请求体。
 * - 空 body → `{}`：多数接口随后会给出更具体的字段校验错误，
 *   且导出类接口（group-sync/export）依赖"空 body = 用默认值"的语义。
 * - 非法 JSON、或顶层不是对象（如 `null` / `123` / `[...]`）→ 抛 HttpError(400)，
 *   避免 `body.args` 这类取值抛 TypeError 被兜底成 500。
 */
async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw || !raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

// 追加 Vary 头，避免覆盖其它环节已写入的值（如来源守卫的 Origin）
function appendVary(res, value) {
  const cur = res.getHeader('Vary');
  if (!cur) { res.setHeader('Vary', value); return; }
  const parts = String(cur).split(/,\s*/);
  if (!parts.includes(value)) res.setHeader('Vary', parts.concat(value).join(', '));
}

// 可 gzip 的响应类型与最小体积（小文件压缩后反而更大）
const COMPRESSIBLE_MIME = /^(?:text\/|application\/(?:javascript|json)|image\/svg)/;
const GZIP_MIN_BYTES = 1024;
// gzip 结果缓存：键为文件路径，值为 { mtimeMs, buf }。静态资源变更后 mtime 变化即失效
const GZIP_CACHE = new Map();

function wantsGzip(req) {
  return !!(req && /\bgzip\b/i.test(req.headers['accept-encoding'] || ''));
}

// 文件读取失败：ENOENT 是请求了不存在的资源（客户端问题）→ 404；其余才算服务端故障 → 500
function sendFileError(res, err, filePath) {
  if (err && err.code === 'ENOENT') {
    sendJson(res, 404, { ok: false, error: '文件不存在' });
    return;
  }
  sendJson(res, 500, { ok: false, error: 'read file failed: ' + filePath });
}

/**
 * 发送静态文件：ETag 协商缓存 + 按需 gzip。
 *
 * 前端资源文件名无版本指纹，故用 `no-cache`（每次都来校验，未变更回 304、不回 body），
 * 而不是强缓存——否则改版后浏览器会继续用旧资源。
 * req 为可选参数：不传则退化为"无缓存头、无压缩"的旧行为。
 */
function sendFile(res, filePath, mime, req) {
  fs.stat(filePath, (err, st) => {
    if (err) { sendFileError(res, err, filePath); return; }
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const base = {
      'Content-Type': mime,
      'Cache-Control': 'no-cache',
      'ETag': etag,
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (req && req.headers['if-none-match'] === etag) {
      res.writeHead(304, base);
      res.end();
      return;
    }
    const gzipOn = wantsGzip(req) && COMPRESSIBLE_MIME.test(mime) && st.size >= GZIP_MIN_BYTES;
    const gzipped = (buf) => {
      appendVary(res, 'Accept-Encoding');
      return Object.assign({}, base, { 'Content-Encoding': 'gzip', 'Content-Length': buf.length });
    };
    if (gzipOn) {
      const hit = GZIP_CACHE.get(filePath);
      if (hit && hit.mtimeMs === st.mtimeMs) {
        res.writeHead(200, gzipped(hit.buf));
        res.end(hit.buf);
        return;
      }
    }
    fs.readFile(filePath, (err2, data) => {
      if (err2) { sendFileError(res, err2, filePath); return; }
      if (!gzipOn) {
        res.writeHead(200, Object.assign({}, base, { 'Content-Length': data.length }));
        res.end(data);
        return;
      }
      const buf = zlib.gzipSync(data);
      GZIP_CACHE.set(filePath, { mtimeMs: st.mtimeMs, buf });
      res.writeHead(200, gzipped(buf));
      res.end(buf);
    });
  });
}

// 本地时间戳（YYYY-MM-DD-HH-mm），用于备份文件名（避免 UTC 慢 8 小时）
function localTs(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}

// 影刀各类 ID（TaskId / AppId / Trigger Id）实测均为标准 UUID：36 位、字符集仅 0-9a-f 与连字符。
// 用于校验来自 URL 的 ID —— 未校验的值会被拼进 REST 路径或用于文件名匹配。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// 虚拟网卡 / VPN 的接口名特征：它们的地址对"局域网访问地址"提示没有意义，
// 且常常排在真实网卡前面，会让界面提示一个人家连不上的地址。
const VIRTUAL_IFACE_RE = /(vmware|virtualbox|vethernet|hyper-v|loopback|tailscale|zerotier|radmin|hamachi|npcap)/i;
const PRIVATE_IP_RE = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;

// 获取本机局域网 IPv4 地址（用于提示局域网访问地址）
// 优先级：私有网段且非虚拟网卡 → 私有网段 → 非虚拟网卡 → 第一个非内部 IPv4
function getLanIP() {
  try {
    const ifaces = require('os').networkInterfaces();
    const all = [];
    for (const name of Object.keys(ifaces)) {
      for (const it of ifaces[name] || []) {
        if (it.family === 'IPv4' && !it.internal) all.push({ name, ip: it.address });
      }
    }
    const real = all.filter((c) => !VIRTUAL_IFACE_RE.test(c.name));
    const pick = real.find((c) => PRIVATE_IP_RE.test(c.ip))
      || all.find((c) => PRIVATE_IP_RE.test(c.ip))
      || real[0] || all[0];
    return pick ? pick.ip : null;
  } catch (e) { /* 忽略 */ }
  return null;
}

function argsToDisplay(args) {
  return args.map((a) => {
    if (/[\s"]/.test(a)) return '"' + a.replace(/"/g, '\\"') + '"';
    return a;
  }).join(' ');
}

module.exports = {
  ensureDir, readBody, readJsonBody, HttpError,
  sendJson, sendFile, appendVary, localTs, getLanIP, argsToDisplay,
  isUuid,
};
