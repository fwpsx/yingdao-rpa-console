/**
 * 触发器迁移类路由：导出、备份列表/删除/上传、匹配、导入
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const fsp = fs.promises;
const { sendJson, readJsonBody, ensureDir } = require('../lib/utils');
const { exportTriggers, matchTriggers, importTriggers } = require('../lib/business');

const routes = [
  // 导出当前账号触发器
  {
    method: 'POST', pattern: /^\/api\/migration\/export$/, handler: async (req, res) => {
      const r = await exportTriggers();
      sendJson(res, 200, r);
    },
  },

  // 列出备份文件
  {
    method: 'GET', pattern: /^\/api\/migration\/backups$/, handler: async (req, res) => {
      ensureDir(config.BACKUP_DIR);
      // 用异步 fs：原 readdirSync + 逐个 statSync 会在请求路径上阻塞事件循环
      const names = (await fsp.readdir(config.BACKUP_DIR)).filter((f) => f.endsWith('.json'));
      const files = (await Promise.all(names.map(async (f) => {
        const st = await fsp.stat(path.join(config.BACKUP_DIR, f));
        return { name: f, size: st.size, mtime: st.mtime.toISOString() };
      }))).sort((a, b) => b.mtime.localeCompare(a.mtime));
      sendJson(res, 200, { ok: true, files });
    },
  },

  // 删除备份文件
  {
    method: 'POST', pattern: /^\/api\/migration\/backups\/delete$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      if (!body.file) { sendJson(res, 400, { ok: false, error: 'file 必填' }); return; }
      const safe = path.basename(body.file);
      if (!safe.endsWith('.json')) { sendJson(res, 400, { ok: false, error: '仅支持删除 .json 备份文件' }); return; }
      const filePath = path.join(config.BACKUP_DIR, safe);
      if (!fs.existsSync(filePath)) { sendJson(res, 404, { ok: false, error: '备份文件不存在: ' + safe }); return; }
      fs.unlinkSync(filePath);
      sendJson(res, 200, { ok: true, file: safe });
    },
  },

  // 上传备份文件
  {
    method: 'POST', pattern: /^\/api\/migration\/backups\/upload$/, handler: async (req, res) => {
      ensureDir(config.BACKUP_DIR);
      const body = await readJsonBody(req);
      if (!body.content) { sendJson(res, 400, { ok: false, error: 'content 必填（备份 JSON 字符串）' }); return; }
      let parsed;
      try { parsed = JSON.parse(body.content); } catch (e) { sendJson(res, 400, { ok: false, error: 'JSON 解析失败: ' + e.message }); return; }
      if (!parsed || !Array.isArray(parsed.triggers)) { sendJson(res, 400, { ok: false, error: '备份格式不正确（缺少 triggers 数组）' }); return; }
      const name = body.name ? path.basename(body.name) : `uploaded_${Date.now()}.json`;
      fs.writeFileSync(path.join(config.BACKUP_DIR, name), JSON.stringify(parsed, null, 2), 'utf-8');
      sendJson(res, 200, { ok: true, file: name, count: parsed.triggers.length });
    },
  },

  // 名称匹配
  {
    method: 'POST', pattern: /^\/api\/migration\/match$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      if (!body.file) { sendJson(res, 400, { ok: false, error: 'file 必填' }); return; }
      const r = await matchTriggers(body.file);
      sendJson(res, 200, r);
    },
  },

  // 导入（支持 dry-run）
  {
    method: 'POST', pattern: /^\/api\/migration\/import$/, handler: async (req, res) => {
      const body = await readJsonBody(req);
      if (!body.file) { sendJson(res, 400, { ok: false, error: 'file 必填' }); return; }
      const r = await importTriggers(body.file, body.assignments || {}, body.dryRun);
      sendJson(res, 200, r);
    },
  },
];

module.exports = { routes };
