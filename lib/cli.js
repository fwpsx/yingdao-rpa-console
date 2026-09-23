/**
 * 影刀 CLI 封装 + 缓存层（零依赖）
 */
const { execFile } = require('child_process');
const config = require('../config');
const { clearRestCache, resetRestReady } = require('./rest');

function runCli(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(config.CLI_EXE, args, {
      timeout: timeoutMs || config.CLI_TIMEOUT,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      cwd: config.CLI_CWD || undefined,
    }, (err, stdout, stderr) => {
      const out = (stdout || '').trim();
      let parsed = null;
      if (out) {
        try { parsed = JSON.parse(out); } catch (e) { parsed = null; }
      }
      // CLI 给出了 JSON 结论（含 ok 字段）时以它为准——这是一手信息，最可信
      if (parsed !== null) { resolve(parsed); return; }
      // 进程非零退出：即使 stdout 有内容（多半是被截断的部分输出）也不能当成功。
      // 原实现只在 `err && !stdout` 时判失败，有 stdout 就无条件 resolve({ ok: true, raw })，
      // 于是"退出码非零 + 输出非 JSON"这类失败会被上游显示为成功。
      if (err) {
        resolve({
          ok: false,
          error: err.message,
          code: err.code,
          stderr: (stderr || '').substring(0, 500),
        });
        return;
      }
      // 退出码 0 但输出不是 JSON：命令本身成功，只是结果不可解析
      resolve({ ok: true, raw: out });
    });
  });
}

/* ================= CLI 结果缓存层 =================
 * 根因：每条 CLI 命令固定开销 ~1.1s（进程启动 + 登录态校验）。
 * 只读命令结果在短时间内不变，加 TTL 缓存后：
 *   - 首次加载仍需等待（无法避免，CLI 进程开销在外部）
 *   - TTL 内再次导航/刷新 → 毫秒级命中缓存
 *   - 写操作（run/login/add/delete）不缓存，且执行后清空全部缓存
 */
const CLI_CACHE = new Map();
const CACHE_TTL = config.CACHE_TTL;

/* ================= 缓存策略：只读命令白名单 =================
 * 原实现用"写动词黑名单"（run|login|add|delete|...）判断是否可缓存，漏了
 * set / enable / disable / read / read-all，实测 12 条写命令中有 5 条被误判为可缓存。
 * 后果是"改了却读到旧值"：切换触发器开关或标记消息已读后，列表在 TTL 内仍是旧状态。
 *
 * 这里改为只读命令白名单：命令路径（第一个以 `-` 开头的元素之前的部分）必须精确命中才缓存。
 * 方向刻意选白名单而非补全黑名单——漏登记的**读**命令只是不缓存（变慢，无害），
 * 漏登记的**写**命令则会读到脏数据（有害）。与 /api/exec 的白名单同一取向。
 * 维护：新增只读命令时，需同步在此登记其命令路径。
 */
const CACHEABLE_CLI_PATHS = new Set([
  'auth current',
  'auth account list',
  'config list',
  'console app',
  'console app group list',
  'console extension list',
  'console message list',
  'console task history',
  'console task logs',
  'console trigger list',
  'system health',
]);

// 取命令路径；出现非字符串参数时返回空数组（视为不可缓存）
function cliCommandPath(args) {
  const parts = [];
  for (const a of args) {
    if (typeof a !== 'string') return [];
    if (a.startsWith('-')) break;
    parts.push(a);
  }
  return parts;
}

function isCacheable(args) {
  if (!args || !args.length) return false;
  const p = cliCommandPath(args);
  return p.length > 0 && CACHEABLE_CLI_PATHS.has(p.join(' '));
}

function cacheKey(args) { return args.join('|'); }

async function cachedCli(args, timeoutMs) {
  if (isCacheable(args)) {
    const key = cacheKey(args);
    const hit = CLI_CACHE.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
      return Object.assign({ fromCache: true, cacheAge: Date.now() - hit.ts }, hit.data);
    }
  }
  const r = await runCli(args, timeoutMs);
  if (isCacheable(args) && r.ok) {
    CLI_CACHE.set(cacheKey(args), { data: r, ts: Date.now() });
  }
  return r;
}

function clearCache() { CLI_CACHE.clear(); clearRestCache(); resetRestReady(); }

module.exports = { runCli, cachedCli, isCacheable, cliCommandPath, clearCache };
