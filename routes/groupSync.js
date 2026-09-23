/**
 * 分组同步类路由：导出分组、备份列表/删除/上传、匹配预览、执行同步
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const fsp = fs.promises;
const { sendJson, readJsonBody, ensureDir } = require('../lib/utils');
const { exportGroups, matchGroups, importGroups } = require('../lib/business');

const routes = [
  // 导出当前账号的分组结构（分组 + 分组内应用），可传 onlyGroups 仅导出指定分组
  {
    method: 'POST', pattern: /^\/api\/group-sync\/export$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      const r = await exportGroups(body.onlyGroups);
      sendJson(res, 200, r);
    },
  },

  // 列出分组备份文件
  {
    method: 'GET', pattern: /^\/api\/group-sync\/backups$/, handler: async (req, res) => {
      ensureDir(config.BACKUP_DIR);
      // 用异步 fs：原 readdirSync + 逐个 statSync 会在请求路径上阻塞事件循环
      const names = (await fsp.readdir(config.BACKUP_DIR)).filter((f) => f.startsWith('groups_') && f.endsWith('.json'));
      const files = (await Promise.all(names.map(async (f) => {
        const st = await fsp.stat(path.join(config.BACKUP_DIR, f));
        return { name: f, size: st.size, mtime: st.mtime.toISOString() };
      }))).sort((a, b) => b.mtime.localeCompare(a.mtime));
      sendJson(res, 200, { ok: true, files });
    },
  },

  // 删除分组备份文件
  {
    method: 'POST', pattern: /^\/api\/group-sync\/backups\/delete$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      if (!body.file) { sendJson(res, 400, { ok: false, error: 'file 必填' }); return; }
      const safe = path.basename(body.file);
      if (!safe.startsWith('groups_') || !safe.endsWith('.json')) { sendJson(res, 400, { ok: false, error: '仅支持删除 groups_ 前缀的 .json 备份文件' }); return; }
      const filePath = path.join(config.BACKUP_DIR, safe);
      if (!fs.existsSync(filePath)) { sendJson(res, 404, { ok: false, error: '备份文件不存在: ' + safe }); return; }
      fs.unlinkSync(filePath);
      sendJson(res, 200, { ok: true, file: safe });
    },
  },

  // 上传分组备份文件
  {
    method: 'POST', pattern: /^\/api\/group-sync\/backups\/upload$/, handler: async (req, res) => {
      ensureDir(config.BACKUP_DIR);
      const body = await readJsonBody(req);
      if (!body.content) { sendJson(res, 400, { ok: false, error: 'content 必填（备份 JSON 字符串）' }); return; }
      let parsed;
      try { parsed = JSON.parse(body.content); } catch (e) { sendJson(res, 400, { ok: false, error: 'JSON 解析失败: ' + e.message }); return; }
      if (!parsed || !Array.isArray(parsed.groups)) { sendJson(res, 400, { ok: false, error: '备份格式不正确（缺少 groups 数组）' }); return; }
      const name = body.name ? 'groups_' + path.basename(body.name).replace(/^groups_/, '') : `groups_uploaded_${Date.now()}.json`;
      fs.writeFileSync(path.join(config.BACKUP_DIR, name), JSON.stringify(parsed, null, 2), 'utf-8');
      sendJson(res, 200, { ok: true, file: name, count: parsed.groups.length });
    },
  },

  // 匹配预览（可传 onlyGroups 仅同步指定分组名）
  {
    method: 'POST', pattern: /^\/api\/group-sync\/match$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      if (!body.file) { sendJson(res, 400, { ok: false, error: 'file 必填' }); return; }
      const r = await matchGroups(body.file, body.onlyGroups);
      sendJson(res, 200, r);
    },
  },

  // 执行同步（支持 dry-run）
  {
    method: 'POST', pattern: /^\/api\/group-sync\/import$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      if (!body.file) { sendJson(res, 400, { ok: false, error: 'file 必填' }); return; }
      const r = await importGroups(body.file, body.onlyGroups, body.dryRun);
      sendJson(res, 200, r);
    },
  },
];

module.exports = { routes };
