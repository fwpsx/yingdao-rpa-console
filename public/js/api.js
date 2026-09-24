/* ============================================================
 * API 层：fetch 封装（带登录令牌）、CLI 调用、登录弹窗
 * 依赖：utils.js（el、modal）
 * ============================================================ */
import { el, modal } from './utils.js';

let AUTH_TOKEN = (() => { try { return localStorage.getItem('rpa_auth_token') || ''; } catch (e) { return ''; } })();

// 保存登录态（内存 + localStorage）。401 自动登录与账号区「登录」按钮两条路径共用，
// 避免"拿到 token 却没人写入"——显式登录不像 401 路径那样有人 await 这个 token。
function saveToken(token) {
  AUTH_TOKEN = token;
  try { localStorage.setItem('rpa_auth_token', token); } catch (e) { /* 忽略 */ }
}

// 清除登录态，与 saveToken 对称（退出登录 / 登录失效两处共用）
function clearToken() {
  AUTH_TOKEN = '';
  try { localStorage.removeItem('rpa_auth_token'); } catch (e) { /* 忽略 */ }
}

// 登录去重：并发请求同时 401 时共享同一个登录框，避免弹出多个
let loginPromise = null;

// 用户在登录框上选择放弃后，不再自动弹窗。
// 必要性：账号区有 15s 一次的账号轮询，若每次都弹，用户取消后会每 15s 被骚扰一次。
// 仅抑制"自动"；用户点账号区的「登录」按钮（requestLogin）仍会强制弹出。
let autoLoginSuppressed = false;

// 显式请求登录：清除抑制并弹窗，成功后落地登录态，返回 token 或 null
export async function requestLogin() {
  autoLoginSuppressed = false;
  const token = await ensureLogin();
  if (token) saveToken(token);
  return token;
}

function ensureLogin() {
  if (autoLoginSuppressed) return Promise.resolve(null);
  if (!loginPromise) {
    loginPromise = promptLogin().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

// 不带鉴权的请求（登录接口自身使用，避免递归）
async function rawFetch(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  return fetch(path, Object.assign({ cache: 'no-store' }, opts, { headers }));
}

export async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (AUTH_TOKEN) headers['X-Auth-Token'] = AUTH_TOKEN;

  let r = await fetch(path, Object.assign({ cache: 'no-store' }, opts, { headers }));
  if (r.status === 401) {
    // 需要登录：共享登录框，成功后重试一次
    const token = await ensureLogin();
    if (!token) throw new Error('未授权：未登录');
    saveToken(token);
    headers['X-Auth-Token'] = AUTH_TOKEN;
    r = await fetch(path, Object.assign({ cache: 'no-store' }, opts, { headers }));
    if (r.status === 401) {
      // 登录态失效：清除并报错，避免死循环
      clearToken();
      throw new Error('未授权：登录失效');
    }
  }
  return r.json();
}

// 登录弹窗：账号 + 密码 → /api/login 换取 token
function promptLogin() {
  return new Promise((resolve) => {
    const userInp = el('input', { class: 'input', placeholder: '账号' });
    const passInp = el('input', { class: 'input', type: 'password', placeholder: '密码' });
    const errBox = el('div', { style: 'font-size:12px;color:var(--danger);min-height:18px;margin-top:2px' });
    let closed = false;
    const done = (v) => { if (!closed) { closed = true; resolve(v); } };
    // 放弃登录（取消 / ✕ / 点遮罩 / Esc 四条路径都会走到这里）：
    // ① 置抑制位，避免后台轮询反复弹窗；② 必须 resolve，否则本 Promise 永久 pending，
    //    ensureLogin 返回的同一个 loginPromise 也永不落地 —— 之后所有 401 都会一直 await 它。
    const giveUp = () => { autoLoginSuppressed = true; done(null); };
    const close = modal({
      title: '登录',
      body: el('div', { style: 'display:flex;flex-direction:column;gap:10px' },
        el('p', { style: 'font-size:13px;line-height:1.6;color:var(--muted)' }, '此服务已启用访问控制，请登录后继续。'),
        userInp, passInp, errBox,
      ),
      footer: [
        el('button', { class: 'btn btn-ghost', onclick: () => close() }, '取消'),
        el('button', { class: 'btn btn-primary', onclick: submit }, '登录'),
      ],
      onClose: giveUp,
    });
    async function submit() {
      try {
        const r = await rawFetch('/api/login', { method: 'POST', body: JSON.stringify({ username: userInp.value.trim(), password: passInp.value }) });
        const j = await r.json();
        // 必须先 resolve 再关闭：close() 会触发 onClose(=giveUp)，
        // 若先关闭就会把成功结果覆盖成"取消"（返回 null）。
        if (j.ok && j.token) { done(j.token); close(); }
        else { errBox.textContent = j.error || '登录失败'; }
      } catch (e) { errBox.textContent = '登录失败: ' + e.message; }
    }
    passInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => userInp.focus(), 50);
  });
}

export async function cli(args) {
  const j = await api('/api/exec', { method: 'POST', body: JSON.stringify({ args }) });
  if (!j.ok) {
    const err = new Error(j.message || j.error || 'CLI 调用失败');
    err.apiCode = j.apiCode;
    throw err;
  }
  return j;
}

// 退出登录：清除本地令牌并刷新页面（重新进入登录态）
export function logout() {
  clearToken();
  location.reload();
}
