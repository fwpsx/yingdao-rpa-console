/* ============================================================
 * 任务管理
 * ============================================================ */
import { el, toast, confirmModal, skeletonRows, emptyState, stagger, renderPager, fmtTime, shortId, modal } from '../utils.js';
import { api, cli } from '../api.js';
import { register } from '../router.js';
import { TASK_STATUS, I } from '../constants.js';

async function renderTasks(page) {
  let curPage = 1, filter = 0, keyword = '';
  let pageSize = 20;
  const FILTERS = [
    { code: 0, name: '全部' }, { code: 2, name: '成功' }, { code: 3, name: '失败' },
    { code: 5, name: '运行中' }, { code: 1, name: '等待中' }, { code: 4, name: '已取消' },
  ];

  let tabs, listWrap, allItems = [];
  page.appendChild(tabs = el('div', { class: 'tabs' }));
  page.appendChild(el('div', { class: 'toolbar' },
    el('div', { class: 'search-box' }, el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' }),
      el('input', { class: 'input', placeholder: '搜索任务：应用名 / 任务ID / 错误信息…', oninput: (e) => {
        keyword = e.target.value.trim().toLowerCase();
        clearTimeout(renderTasks._t);
        renderTasks._t = setTimeout(renderList, 300);
      } }))));
  page.appendChild(listWrap = el('div', {}));

  function buildTabs() {
    tabs.innerHTML = '';
    FILTERS.forEach((f) => {
      tabs.appendChild(el('div', {
        class: 'tab' + (filter === f.code ? ' active' : ''),
        onclick: () => { filter = f.code; buildTabs(); renderList(); }
      }, f.name));
    });
    tabs.appendChild(el('div', { class: 'spacer', style: 'flex:1' }));
    tabs.appendChild(el('button', { class: 'btn btn-ghost btn-sm', html: I.refresh + '刷新', onclick: load }));
  }

  async function load() {
    listWrap.innerHTML = '';
    listWrap.appendChild(skeletonRows(5));
    try {
      const r = await api('/api/tasks');
      if (!r.ok) throw new Error(r.message || r.error || '获取任务历史失败');
      allItems = (r.data && r.data.items) || [];
      renderList();
    } catch (e) {
      listWrap.innerHTML = '';
      listWrap.appendChild(el('div', { class: 'empty' }, el('p', { style: 'color:var(--danger)' }, '加载失败: ' + e.message)));
    }
  }

  function renderList() {
    listWrap.innerHTML = '';
    let filtered = filter === 0 ? allItems : allItems.filter((t) => (t.statusCode || t.status) === filter);
    if (keyword) {
      filtered = filtered.filter((t) => {
        const taskId = (t.taskId || t.id || '').toString().toLowerCase();
        const appName = (t.appName || '').toLowerCase();
        const err = (t.error || '').toLowerCase();
        const src = (t.sourceName || '').toLowerCase();
        return appName.includes(keyword) || taskId.includes(keyword) || err.includes(keyword) || src.includes(keyword);
      });
    }

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (curPage > totalPages) curPage = totalPages;
    const startIdx = (curPage - 1) * pageSize;
    const items = filtered.slice(startIdx, startIdx + pageSize);

    if (!items.length) { listWrap.appendChild(emptyState(keyword ? '没有匹配的任务' : '当前筛选条件下没有任务', '🗂️')); return; }

    const tbl = el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {},
        el('th', {}, '任务'), el('th', {}, '状态'), el('th', {}, '创建时间'),
        el('th', {}, '错误信息'), el('th', { style: 'text-align:right' }, '操作'))));
    const tbody = el('tbody');
    items.forEach((t) => {
      const sc = t.statusCode || t.status;
      const st = TASK_STATUS[sc] || { name: t.statusName || '未知', cls: 'cancel' };
      const taskId = t.taskId || t.id;
      tbody.appendChild(el('tr', { class: 'fade-item' },
        el('td', { class: 'name-cell' }, t.appName || '-', el('span', { class: 'sub' }, '任务: ' + shortId(taskId))),
        el('td', {}, el('span', { class: 'badge ' + st.cls }, st.name)),
        el('td', { class: 'mono' }, fmtTime(t.createTime)),
        el('td', { style: 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--danger);font-size:12px' }, t.error || '-'),
        el('td', { style: 'text-align:right;white-space:nowrap' },
          el('button', { class: 'btn btn-ghost btn-sm', html: I.doc + '日志', onclick: () => showLogs(t) }),
          ' ',
          el('button', { class: 'btn btn-ghost btn-sm', html: I.video + '回放', onclick: () => openVideo(taskId) }),
          ' ',
          sc === 5
            ? el('button', { class: 'btn btn-danger btn-sm', onclick: () => stopTask(t) }, '停止')
            : el('button', { class: 'btn btn-ghost btn-sm', html: I.play + '重跑', onclick: () => rerun(t) }),
        )
      ));
    });
    tbl.appendChild(tbody);
    listWrap.appendChild(el('div', { class: 'tbl-wrap' }, tbl));
    stagger(listWrap);
    listWrap.appendChild(renderPager({
      curPage, total, pageSize,
      onPage: (p) => { curPage = p; renderList(); },
      onSize: (s) => { pageSize = s; curPage = 1; renderList(); },
    }));
  }

  async function showLogs(t) {
    const taskId = t.taskId || t.id;
    const pre = el('div', { class: 'mono-block' }, '正在加载日志…');
    modal({ title: `任务日志 — ${t.appName || shortId(taskId)}`, body: pre, wide: true });
    try {
      const r = await api(`/api/tasks/${encodeURIComponent(taskId)}/logs`);
      let text = '';
      const d = r.data || {};
      if (typeof d === 'string') text = d;
      else if (Array.isArray(d)) text = d.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
      else if (Array.isArray(d.logs)) text = d.logs.map((x) => (typeof x === 'string' ? x : (x.content || x.message || JSON.stringify(x)))).join('\n');
      else if (Array.isArray(d.items)) text = d.items.map((x) => (typeof x === 'string' ? x : (x.content || x.message || JSON.stringify(x)))).join('\n');
      else text = JSON.stringify(d, null, 2);
      pre.textContent = text || '（无日志）';
      pre.scrollTop = pre.scrollHeight;
    } catch (e) { pre.textContent = '日志加载失败: ' + e.message; }
  }

  async function openVideo(taskId) {
    try {
      const r = await api(`/api/tasks/${encodeURIComponent(taskId)}/video`);
      if (r.ok && r.count > 0) {
        await api(`/api/tasks/${encodeURIComponent(taskId)}/video/open`, { method: 'POST' });
        toast(`已打开视频回放（${r.files[0].name}）`, 'ok');
      } else {
        toast('该任务没有视频回放文件', 'info');
      }
    } catch (e) { toast('打开回放失败: ' + e.message, 'fail'); }
  }

  async function stopTask(t) {
    const taskId = t.taskId || t.id;
    const ok = await confirmModal('停止任务', `确定要停止任务「${t.appName || shortId(taskId)}」吗？`, { danger: true, okText: '停止' });
    if (!ok) return;
    try {
      await cli(['console', 'task', 'stop', '--task-id', taskId, '--reason', '控制台手动停止']);
      toast('已发送停止指令', 'ok');
      setTimeout(load, 1500);
    } catch (e) { toast('停止失败: ' + e.message, 'fail'); }
  }

  async function rerun(t) {
    const ok = await confirmModal('重新运行', `确定要重新运行「${t.appName}」吗？`, { okText: '运行' });
    if (!ok) return;
    try {
      await cli(['console', 'task', 'run', '--app-id', t.appId, '--async']);
      toast(`「${t.appName}」已重新启动`, 'ok');
    } catch (e) { toast('重跑失败: ' + e.message, 'fail'); }
  }

  buildTabs();
  load();
}

register('tasks', { title: '任务管理', sub: '任务历史、日志与回放', icon: I.tasks, render: renderTasks });
