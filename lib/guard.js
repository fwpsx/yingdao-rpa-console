/**
 * 请求来源守卫：收紧 CORS + 校验 Host
 *
 * 背景（为什么需要这道闸）：
 *   原实现对每个响应无条件回 `Access-Control-Allow-Origin: *`，而默认 HOST=0.0.0.0、
 *   默认可不设密码。三者叠加后：本机浏览器打开任意网页时，该网页的 JS 即可跨域调用
 *   http://127.0.0.1:18923/api/* 并读取响应（含执行 CLI 的 /api/exec、切换账号）。
 *   另外原实现不校验 Host，存在 DNS rebinding 面：恶意域名解析到 127.0.0.1 后
 *   浏览器会把它当作同源，绕过 CORS。
 *
 * 策略：
 *   只放行「主机属于本机（loopback + 各网卡 IP）」的来源，其余 403。
 *   反向代理 / 自定义域名场景可用 .env 的 ALLOWED_ORIGINS 追加（逗号分隔）。
 *
 * 边界：本守卫针对浏览器来源，不防非浏览器客户端（那由 lib/auth.js 的 token 把关）。
 */
const os = require('os');
const config = require('../config');
const { appendVary } = require('./utils');

// 本机地址集合。带 TTL 缓存：网卡地址是会变的（切 Wi-Fi、插拔网线、VPN 上下线），
// 若像原实现那样永久缓存，换网络后必须重启服务才能继续访问——与 restReady 同类问题。
const LOCAL_HOSTS_TTL_MS = 30000;
let cachedHosts = null;
let cachedHostsTs = 0;

function localHosts() {
  const now = Date.now();
  if (cachedHosts && now - cachedHostsTs < LOCAL_HOSTS_TTL_MS) return cachedHosts;
  const set = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] || []) set.add(String(addr.address).toLowerCase());
    }
  } catch (e) { /* 探测失败退化为仅 loopback，不阻塞服务 */ }
  for (const extra of String(config.ALLOWED_ORIGINS || '').split(',')) {
    const h = extra.trim().toLowerCase();
    if (h) set.add(h);
  }
  cachedHosts = set;
  cachedHostsTs = now;
  return set;
}

// 从 Origin 头取主机名。'null'（file:// 等沙箱来源）与非法值都返回不可能命中的占位串
function hostFromOrigin(origin) {
  if (origin === 'null') return '\u0000null';
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch (e) {
    return '\u0000invalid';
  }
}

// 从 Host 头取主机名：去掉端口，保留 IPv6 的方括号形式
function hostFromHeader(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(h);
  return m ? m[1] : '';
}

// 来源放行判定：无 Origin（同源导航 / 非浏览器客户端）放行，交给后续鉴权把关
function originAllowed(origin) {
  if (!origin) return true;
  return localHosts().has(hostFromOrigin(origin));
}

// Host 放行判定：攻击者域名解析到 127.0.0.1 时，Host 会是该域名而非本机地址
function hostAllowed(hostHeader) {
  return localHosts().has(hostFromHeader(hostHeader));
}

// 按具体来源回 CORS 头（不再无条件 *）。未放行的来源不回 Allow-Origin，浏览器即拦截
function applyCors(req, res) {
  const origin = req.headers.origin;
  appendVary(res, 'Origin');
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auth-Token, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

module.exports = { localHosts, originAllowed, hostAllowed, applyCors };
