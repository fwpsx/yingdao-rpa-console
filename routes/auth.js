/**
 * 账号类路由：记住的账号列表、切换登录
 *
 * 切换账号机制（重要）：
 * 影刀 CLI 的 `auth login --username X` 在「已登录」状态下会直接返回
 * 「当前账号已登录」而不切换（CLI 无 logout/switch 命令，REST 也无登出端点）。
 * 唯一可行路径：先杀掉影刀客户端进程（ShadowBot.Shell.exe 及其附属），
 * 让客户端进入「未登录」态，再 `auth login --username X` 启动并登录到目标账号。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { cachedCli, runCli, clearCache } = require('../lib/cli');
const { sendJson, readJsonBody } = require('../lib/utils');

// 影刀客户端进程名（杀 Shell 主进程后附属进程会自行退出，这里一并清理）
const SHADOWBOT_PROCESSES = [
  'ShadowBot.Shell.exe',
  'ShadowBot.Explorer.exe',
  'ShadowBot.UIAutomation.Provider.exe',
  'ShadowBot.ChromeBridge.exe',
];

// 异步执行 taskkill（不阻塞事件循环）
function taskkill(imagename) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/IM', imagename, '/T'], { windowsHide: true }, () => resolve());
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 杀掉所有影刀进程
async function killShadowBot() {
  await Promise.all(SHADOWBOT_PROCESSES.map((n) => taskkill(n)));
  await sleep(1500); // 等待进程完全退出、端口释放
}

// 查询影刀运行时状态（system state），返回 data 或 null
async function fetchRuntimeState() {
  try {
    const r = await runCli(['system', 'state'], 15000);
    return (r && r.ok && r.data) ? r.data : null;
  } catch (e) {
    return null;
  }
}

// 检查影刀是否被占用（运行中任务 / Studio 编辑）。返回 null 表示可切换，否则返回阻断原因文案
function checkBusyState(state) {
  if (!state) return null; // 查不到状态时不阻断（避免误伤）
  if (state.hasRunningTask) {
    const t = state.runningTask;
    const desc = t && (t.appName || t.app) ? `（${t.appName || t.app}）` : '';
    return `影刀正在运行任务${desc}，请先停止任务再切换账号`;
  }
  if (state.hasStudioOpened || state.isStudioBusy) {
    return '影刀 Studio 正在编辑中，请先关闭编辑再切换账号';
  }
  return null;
}

// 轮询 auth current 直到目标账号登录成功（返回 { ok, userName }）
async function waitLogin(username, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 60000);
  while (Date.now() < deadline) {
    const cur = await runCli(['auth', 'current'], 15000);
    if (cur && cur.ok && cur.data && cur.data.loggedIn && cur.data.userName === username) {
      return { ok: true, userName: cur.data.userName, account: cur.data };
    }
    await sleep(1500);
  }
  return { ok: false, error: `等待登录「${username}」超时` };
}

// 读取影刀账号配置（Account.xml），提取每个账号的显示名/企业名（CLI account list 不返回这些）
function readAccountXml() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'ShadowBot', 'users', 'Account.xml'),
    path.join(process.env.APPDATA || '', 'ShadowBot', 'users', 'Account.xml'),
  ];
  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      const xml = fs.readFileSync(p, 'utf-8');
      const out = new Map();
      // 逐个 <AccountInfo>…</AccountInfo> 块解析 Name / UserInfoDisplayName / EnterpriseName
      const re = /<AccountInfo>([\s\S]*?)<\/AccountInfo>/g;
      let m;
      while ((m = re.exec(xml)) !== null) {
        const block = m[1];
        const g = (tag) => { const t = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>')); return t ? t[1].trim() : ''; };
        const name = g('Name');
        if (name) out.set(name, { displayName: g('UserInfoDisplayName') || '', enterpriseName: g('EnterpriseName') || '' });
      }
      return out;
    } catch (e) { /* 忽略解析错误 */ }
  }
  return null;
}

const routes = [
  // 记住的账号列表（REST 未暴露此路径，走 CLI + 缓存；补充 Account.xml 里的显示名）
  {
    method: 'GET', pattern: /^\/api\/auth\/accounts$/, handler: async (req, res) => {
      const r = await cachedCli(['auth', 'account', 'list']);
      if (r && r.ok && r.data && Array.isArray(r.data.items)) {
        const extra = readAccountXml();
        r.data.items = r.data.items.map((it) => {
          const name = it.name;
          const info = extra ? extra.get(name) : null;
          return {
            name,
            displayName: (info && info.displayName) || it.displayName || '',
            enterpriseName: (info && info.enterpriseName) || '',
            hasSavedPassword: !!it.hasSavedPassword,
            autoLogin: !!it.autoLogin,
          };
        });
      }
      sendJson(res, 200, r);
    },
  },

  // 切换登录：杀影刀进程 → auth login 到目标账号 → 轮询确认
  {
    method: 'POST', pattern: /^\/api\/auth\/switch$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      if (!body.username) { sendJson(res, 400, { ok: false, error: 'username 必填' }); return; }

      // 0. 切换前检测：运行中任务 / Studio 编辑占用时拒绝切换
      const state = await fetchRuntimeState();
      const busyReason = checkBusyState(state);
      if (busyReason) {
        sendJson(res, 200, { ok: false, blocked: true, error: busyReason, state });
        return;
      }

      // 1. 杀掉影刀客户端进程，使其进入「未登录」态
      await killShadowBot();

      // 2. 登录目标账号（免密，需该账号已记住密码）
      const login = await runCli(['auth', 'login', '--username', body.username, '--login-timeout', '90s'], 180000);
      if (!login.ok) {
        clearCache();
        sendJson(res, 200, { ok: false, error: '登录失败: ' + (login.message || login.error || '未知错误'), detail: login });
        return;
      }

      // 3. 轮询确认登录结果
      const confirmed = await waitLogin(body.username, 60000);

      clearCache(); // 切换账号后清空所有缓存
      if (confirmed.ok) {
        sendJson(res, 200, { ok: true, switched: true, userName: confirmed.userName, account: confirmed.account });
      } else {
        sendJson(res, 200, { ok: false, error: confirmed.error, detail: login });
      }
    },
  },
];

module.exports = { routes };
