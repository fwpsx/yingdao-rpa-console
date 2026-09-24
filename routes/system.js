/**
 * 系统类路由：健康检查、系统状态汇总、应用分组、通用 CLI 执行、缓存清除、静态资源
 */
const path = require('path');
const config = require('../config');
const auth = require('../lib/auth');
const { rest, restReady, cachedRest } = require('../lib/rest');
const { cachedCli, isCacheable, cliCommandPath, clearCache } = require('../lib/cli');
const { sendJson, sendFile, getLanIP, readJsonBody } = require('../lib/utils');
const { fetchAllGroups, fetchAllApps, normAccount, checkAccountSwitch } = require('../lib/business');

// 静态资源 MIME 映射
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ================= /api/exec 的 CLI 白名单 =================
 * 只校验 args[0] 不足以构成"白名单代理"：args[0] 为 'console' 时，
 * 'console trigger delete'、'console app delete' 这类破坏性子命令会被一并放行。
 * 这里改为按「命令路径」精确匹配——命令路径 = args 中第一个以 `-` 开头的元素之前的部分
 * （即子命令层级，不含标志与取值）。标志与取值可自由变化，子命令层级必须完全命中。
 *
 * 说明：lib/cli.js 用 execFile 以数组传参、不经 shell，因此不存在命令行注入；
 *       本白名单解决的是授权粒度问题，不是注入防护。
 * 维护：新增前端功能时，需同步在此登记其命令路径。
 */
const ALLOWED_CLI_PATHS = new Set([
  'auth current',
  'auth account list',
  'console app',
  'console task run',
  'console task stop',
  'console message list',
  'console message read',
  'console message read-all',
  'console extension list',
  'console trigger list',
  'console trigger enable',
  'console trigger disable',
  'console trigger delete',
  'mode switch',
  'config list',
  'config set',
]);
// 触发器新建/编辑：路径形如 `console trigger <type> add|update`，type 限定为前端实际支持的四种
const TRIGGER_SUBCOMMANDS = new Set(['schedule', 'email', 'file', 'hotkey']);

function isAllowedCli(args) {
  const p = cliCommandPath(args); // 非字符串参数会返回空数组 → 一律拒绝
  if (!p.length) return false;
  if (p.length === 4 && p[0] === 'console' && p[1] === 'trigger'
      && TRIGGER_SUBCOMMANDS.has(p[2]) && (p[3] === 'add' || p[3] === 'update')) {
    return true;
  }
  return ALLOWED_CLI_PATHS.has(p.join(' '));
}

const routes = [
  // 静态首页
  { method: 'GET', pattern: /^\/(?:index\.html)?$/, handler: (req, res) => { sendFile(res, config.HTML_PATH, 'text/html; charset=utf-8', req); } },

  // 静态资源（public 目录下的 css/js/图片等，支持 js/ 及 js/pages/ 子目录）
  {
    method: 'GET', pattern: /^\/([\w\-./]+\.(?:css|js|json|png|jpe?g|gif|svg|ico))$/, handler: (req, res, m) => {
      const rel = m[1];
      const publicRoot = path.join(__dirname, '..', 'public');
      const filePath = path.normalize(path.join(publicRoot, rel));
      // 防路径穿越：规范化后必须仍在 public 目录内
      if (!filePath.startsWith(publicRoot + path.sep)) {
        sendJson(res, 403, { ok: false, error: '非法路径' });
        return;
      }
      // 存在性交给 sendFile 里的异步 stat 判断：同步 existsSync 既阻塞事件循环，
      // 又与 sendFile 内部那次 stat 重复。文件不存在时 sendFile 会回 404。
      const ext = path.extname(rel).toLowerCase();
      sendFile(res, filePath, MIME[ext] || 'application/octet-stream', req);
    },
  },

  // 健康检查
  {
    method: 'GET', pattern: /^\/api\/health$/, handler: (req, res) => {
      sendJson(res, 200, { ok: true, service: 'rpa-console', time: new Date().toISOString(), lanIP: getLanIP(), port: config.PORT });
    },
  },

  // 控制台登录（账号 + 密码 → 签发 token）
  {
    method: 'POST', pattern: /^\/api\/login$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      const r = auth.login(body.username, body.password);
      if (r.ok) sendJson(res, 200, { ok: true, token: r.token, user: body.username });
      else sendJson(res, 401, { ok: false, error: r.error });
    },
  },

  // 通用 CLI 执行（白名单）
  {
    method: 'POST', pattern: /^\/api\/exec$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      const args = Array.isArray(body.args) ? body.args : null;
      if (!args || !args.length || typeof args[0] !== 'string') {
        sendJson(res, 400, { ok: false, error: 'args 数组必填' });
        return;
      }
      if (!isAllowedCli(args)) {
        sendJson(res, 403, { ok: false, error: `命令不在白名单: ${args.join(' ')}` });
        return;
      }
      const r = await cachedCli(args, body.timeout);
      if (!isCacheable(args)) clearCache();
      sendJson(res, 200, r);
    },
  },

  // 清除缓存
  {
    method: 'POST', pattern: /^\/api\/cache\/clear$/, handler: (req, res) => {
      clearCache();
      sendJson(res, 200, { ok: true, cleared: true });
    },
  },

  // 系统状态汇总
  {
    method: 'GET', pattern: /^\/api\/system\/status$/, handler: async (req, res) => {
      await checkAccountSwitch(); // 账号哨兵：手动切换影刀账号后清空旧缓存
      let account = null, triggerCount = null, appCount = null, health = null;
      if (await restReady()) {
        // 应用数改用 fetchAllApps()，与 /api/apps 同源：既避免两处口径不一致，
        // 也避免原 PageSize=1000 被 REST 静默截断到 500 后计出偏小的数量。
        const [accR, appsAll, trigR, stateR] = await Promise.all([
          rest('/account/current').catch(() => null),
          fetchAllApps().catch(() => null),
          cachedRest('/triggers', 30000).catch(() => null),
          rest('/operator/state').catch(() => null),
        ]);
        if (accR && accR.ok) account = normAccount(accR.data); // 与 fetchCurrentAccount 同源
        if (appsAll) appCount = appsAll.length;
        if (trigR && trigR.ok) triggerCount = (trigR.data.Items || []).length;
        if (stateR && stateR.ok) health = stateR.data;
        sendJson(res, 200, {
          ok: true, account, health, triggerCount, appCount,
          serverTime: new Date().toISOString(), via: 'rest',
          lanIP: getLanIP(), port: config.PORT,
        });
        return;
      }
      const [accountR, healthR, appsR, triggersR] = await Promise.all([
        cachedCli(['auth', 'current']).catch(() => null),
        cachedCli(['system', 'health']).catch(() => null),
        cachedCli(['console', 'app', '--page', '1', '--page-size', '100']).catch(() => null),
        cachedCli(['console', 'trigger', 'list', '--type', 'all']).catch(() => null),
      ]);
      if (appsR && appsR.ok && appsR.data) appCount = (appsR.data.items || []).length;
      sendJson(res, 200, {
        ok: true,
        account: accountR && accountR.ok ? accountR.data : null,
        health: healthR && healthR.ok ? healthR.data : null,
        triggerCount: triggersR && triggersR.ok && triggersR.data ? (triggersR.data.items || []).length : null,
        appCount,
        serverTime: new Date().toISOString(), via: 'cli',
        lanIP: getLanIP(), port: config.PORT,
      });
    },
  },

  // 应用分组列表
  {
    method: 'GET', pattern: /^\/api\/app-groups$/, handler: async (req, res) => {
      try {
        const items = await fetchAllGroups();
        sendJson(res, 200, { ok: true, data: { items }, via: 'rest' });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
    },
  },
];

module.exports = { routes };
