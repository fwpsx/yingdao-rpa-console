/* ============================================================
 * 路由与全局状态：App 状态、页面注册表、导航、账号刷新
 * 页面模块通过 register() 注册自身，navigate() 从注册表取 render 函数。
 * 依赖：utils.js、api.js
 * ============================================================ */
import { el, $, $$ } from './utils.js';
import { api, cli, requestLogin } from './api.js';

export const App = { account: null, module: 'dashboard', unread: 0 };

// 页面注册表：key -> { title, sub, icon, render }
const modules = {};
export function register(key, def) { modules[key] = def; }

export function buildNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  Object.entries(modules).forEach(([key, m]) => {
    nav.appendChild(el('div', { class: 'nav-item' + (key === App.module ? ' active' : ''), onclick: () => navigate(key) },
      el('span', { html: m.icon }), m.title,
      key === 'messages' && App.unread > 0 ? el('span', { class: 'nav-dot', title: '未读消息' }) : null
    ));
  });
}

export function setActiveNav(name) {
  // 只切换 active 状态，不重建 DOM（避免导航切换时的重排开销）
  const keys = Object.keys(modules);
  $$('.nav-item', $('#nav')).forEach((n, i) => {
    n.classList.toggle('active', keys[i] === name);
  });
}

export function navigate(name) {
  App.module = name;
  setActiveNav(name);
  const m = modules[name];
  $('#page-title').innerHTML = `${m.title}<small>${m.sub}</small>`;
  const page = $('#page');
  page.innerHTML = '';
  page.classList.remove('page-anim');
  void page.offsetWidth; // 强制重排以重启动画
  page.classList.add('page-anim');
  m.render(page);
}

export async function refreshAccount() {
  const prevUserId = App.account ? App.account.userId : null;
  try {
    const r = await cli(['auth', 'current']);
    App.account = r.data && r.data.loggedIn ? r.data : null;
  } catch { App.account = null; }
  // 账号哨兵（前端层）：检测到影刀账号变化时，清缓存并刷新当前页面
  const curUserId = App.account ? App.account.userId : null;
  if (prevUserId !== null && curUserId !== null && prevUserId !== curUserId) {
    try { await fetch('/api/cache/clear', { method: 'POST', headers: { 'X-Auth-Token': localStorage.getItem('rpa_auth_token') || '' } }); } catch (e) { /* 忽略 */ }
    const cur = App.module;
    if (cur) navigate(cur); // 重新渲染当前页（拉取新账号数据）
  }
  const chip = $('#account-chip');
  if (App.account) {
    const name = App.account.displayName || App.account.userName || '未知';
    chip.title = `${App.account.userName} · ${App.account.accountType || ''}`;
    chip.innerHTML = '';
    chip.appendChild(el('div', { class: 'avatar' }, String(name).charAt(0)));
    chip.appendChild(el('span', {}, name));
    chip.appendChild(el('span', { class: 'badge ok plain', style: 'font-size:10.5px' }, '在线'));
  } else {
    // 未登录：给出明确状态 + 显式登录入口。
    // 自动弹窗在用户放弃后会被抑制，这里必须留一个可点的入口，否则用户无处登录。
    chip.innerHTML = '';
    chip.title = '尚未登录控制台';
    chip.appendChild(el('span', { style: 'color:var(--danger);font-size:12.5px' }, '● 未登录'));
    chip.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: async () => {
        const t = await requestLogin();
        if (t) { await refreshAccount(); navigate(App.module); } // 登录成功：刷新账号与当前页数据
      },
    }, '登录'));
  }
}

export async function updateLanAddr() {
  const eln = $('#lan-addr');
  if (!eln) return;
  try {
    const r = await api('/api/health');
    if (r && r.ok && r.lanIP) {
      eln.textContent = r.lanIP + ':' + (r.port || '18923');
      eln.title = '局域网访问地址';
    }
  } catch (e) { /* 忽略，保持默认 127.0.0.1 */ }
}
