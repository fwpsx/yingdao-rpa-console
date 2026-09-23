/**
 * 业务逻辑：字段归一化、数据获取、触发器导出/匹配/导入
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { rest, restReady, cachedRest, REST_MAX_PAGE_SIZE, isTruncatedPage } = require('./rest');
const { cachedCli, runCli, clearCache } = require('./cli');
const { ensureDir, localTs, argsToDisplay } = require('./utils');

// ================= 字段归一化 =================
// REST 返回 PascalCase，归一化为 CLI 的小写驼峰，保证下游代码（匹配/导入）字段一致
function normApp(a) {
  if (!a) return a;
  return {
    appId: a.AppId, appName: a.AppName, appType: a.AppType,
    groupId: a.GroupId, ownerName: a.OwnerName,
    updateTime: a.UpdateTime, versionId: a.VersionId,
  };
}
function normGroup(g) {
  if (!g) return g;
  return {
    groupId: g.GroupId, name: g.Name, icon: g.Icon,
    appType: g.AppType, createTime: g.CreateTime, updateTime: g.UpdateTime,
  };
}
function normTrigger(t) {
  if (!t) return t;
  return {
    id: t.Id, domain: t.Domain, triggerType: t.TriggerType, name: t.Name,
    appId: t.AppId, appName: t.AppName, enabled: t.Enabled,
    timeout: t.Timeout, queueWhenBusy: t.QueueWhenBusy,
    createTime: t.CreateTime, modifyTime: t.ModifyTime, details: t.Details,
  };
}
function normTask(t) {
  if (!t) return t;
  return {
    taskId: t.TaskId, appId: t.AppId, appName: t.AppName,
    sourceName: t.SourceName, statusCode: t.Status, error: t.Error,
    createTime: t.CreateTime,
  };
}

// ================= 账号哨兵 =================
// 用户可能直接在影刀客户端手动切换账号（不经过本控制台的 /api/auth/switch），
// 此时 clearCache() 不会被触发，CLI/REST 缓存里仍是旧账号数据（应用列表缓存 5 分钟）。
// 哨兵机制：每次数据获取前直连 /account/current 对比账号，变化则清空全部缓存。
let lastKnownUserId = null;

async function checkAccountSwitch() {
  try {
    if (await restReady()) {
      // REST 直连（无缓存，1~80ms），实时拿到当前账号
      const r = await rest('/account/current');
      if (r.ok && r.data) {
        const a = r.data.Account || r.data.User || r.data;
        const userId = a.UserId || a.Id || null;
        if (lastKnownUserId !== null && userId !== null && userId !== lastKnownUserId) {
          clearCache(); // 账号已变化，清空全部数据缓存
        }
        if (userId !== null) lastKnownUserId = userId;
      }
    } else {
      // REST 不可用回退 CLI（带 30s 缓存，最坏延迟 30 秒，远好于 5 分钟）
      const r = await cachedCli(['auth', 'current']);
      if (r && r.ok && r.data && r.data.loggedIn) {
        const userId = r.data.userId || null;
        if (lastKnownUserId !== null && userId !== null && userId !== lastKnownUserId) {
          clearCache();
        }
        if (userId !== null) lastKnownUserId = userId;
      }
    }
  } catch (e) { /* 检测失败不阻塞业务 */ }
}

// ================= 数据获取（REST 优先，回退 CLI） =================
async function fetchAllApps() {
  await checkAccountSwitch();
  if (await restReady()) {
    // 用 REST 的单页硬上限取数：取满即无法确认是否还有更多（REST 不支持翻页、无 Total），
    // 此时不采信 REST 结果，交给下面的 CLI 全量分页，避免应用数超过上限时静默丢数据。
    const r = await cachedRest(`/apps?PageIndex=1&PageSize=${REST_MAX_PAGE_SIZE}`, 300000); // apps 缓存 5 分钟
    if (r.ok && r.data) {
      const items = (r.data.Items || []).map(normApp);
      if (items.length && !isTruncatedPage(items)) return items;
    }
  }
  const apps = [];
  let page = 1;
  while (page <= 50) {
    const r = await cachedCli(['console', 'app', '--page', String(page), '--page-size', '100']);
    if (!r.ok) throw new Error(r.message || r.error || 'console app 调用失败');
    const items = (r.data && r.data.items) || [];
    apps.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return apps;
}

async function fetchAllGroups() {
  await checkAccountSwitch();
  if (await restReady()) {
    const r = await cachedRest('/app-groups', 300000); // 分组缓存 5 分钟
    if (r.ok && r.data) {
      const items = (r.data.Items || []).map(normGroup);
      if (items.length) return items;
    }
  }
  const r = await cachedCli(['console', 'app', 'group', 'list', '--app-type', 'developed']);
  if (!r.ok) throw new Error(r.message || r.error || 'app group list 调用失败');
  return (r.data && r.data.items) || [];
}

async function fetchAllTriggers() {
  await checkAccountSwitch();
  if (await restReady()) {
    const r = await cachedRest('/triggers');
    if (r.ok && r.data) {
      const items = (r.data.Items || []).map(normTrigger);
      return items; // REST 一次返回全部，无需分页
    }
  }
  const r = await cachedCli(['console', 'trigger', 'list', '--type', 'all']);
  if (!r.ok) throw new Error(r.message || r.error || 'trigger list 调用失败');
  return (r.data && r.data.items) || [];
}

async function fetchCurrentAccount() {
  if (await restReady()) {
    const r = await rest('/account/current');
    if (r.ok && r.data) {
      const d = r.data;
      const a = d.Account || d.User || d;
      return {
        loggedIn: true,
        userId: a.UserId || a.Id,
        userName: a.UserName || a.Name || a.Email,
        displayName: a.DisplayName || a.NickName,
        accountType: a.AccountType,
      };
    }
  }
  const r = await cachedCli(['auth', 'current']);
  if (!r.ok || !r.data || !r.data.loggedIn) return null;
  return r.data;
}

// ================= 触发器导出 =================
async function exportTriggers() {
  const account = await fetchCurrentAccount();
  const triggers = await fetchAllTriggers();
  const backup = {
    meta: {
      version: 1,
      exportedAt: new Date().toISOString(),
      triggerCount: triggers.length,
      sourceAccount: account ? {
        userId: account.userId,
        userName: account.userName,
        displayName: account.displayName,
        accountType: account.accountType,
      } : null,
    },
    triggers,
  };
  ensureDir(config.BACKUP_DIR);
  const ts = localTs();
  const accTag = account ? String(account.userName || account.displayName || 'unknown').replace(/[^\w@.-]/g, '_') : 'unknown';
  const fileName = `triggers_${accTag}_${ts}.json`;
  const filePath = path.join(config.BACKUP_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8');
  return { ok: true, file: fileName, count: triggers.length, account: backup.meta.sourceAccount };
}

function loadBackup(fileName) {
  // 防路径穿越：只允许 backups 目录下的文件名
  const safe = path.basename(fileName);
  const filePath = path.join(config.BACKUP_DIR, safe);
  if (!fs.existsSync(filePath)) throw new Error('备份文件不存在: ' + safe);
  const backup = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!backup || !Array.isArray(backup.triggers)) throw new Error('备份文件格式不正确（缺少 triggers 数组）');
  return { backup, fileName: safe };
}

// ================= 触发器匹配 =================
async function matchTriggers(fileName) {
  const { backup } = loadBackup(fileName);
  const [targetApps, targetTriggers, account] = await Promise.all([
    fetchAllApps(),
    fetchAllTriggers(),
    fetchCurrentAccount(),
  ]);

  const byName = {};
  targetApps.forEach((a) => {
    (byName[a.appName] = byName[a.appName] || []).push(a);
  });
  const targetAppById = {};
  targetApps.forEach((a) => { targetAppById[a.appId] = a; });
  // 重复检测键：触发器名 + 目标应用名 + 类型
  const existingKeys = new Set();
  targetTriggers.forEach((t) => {
    existingKeys.add(`${t.name}|${t.appName}|${t.triggerType}`);
  });

  const matched = [], ambiguous = [], missing = [], duplicates = [];

  backup.triggers.forEach((t) => {
    const key = `${t.name}|${t.appName}|${t.triggerType}`;
    const item = {
      triggerId: t.id,
      name: t.name,
      type: t.triggerType,
      sourceAppName: t.appName,
      sourceAppId: t.appId,
      enabled: t.enabled,
      details: t.details,
      duplicate: existingKeys.has(key),
    };
    if (item.duplicate) {
      duplicates.push(item);
      return;
    }
    const candidates = byName[t.appName] || [];
    if (candidates.length === 1) {
      item.targetAppId = candidates[0].appId;
      item.targetAppName = candidates[0].appName;
      matched.push(item);
    } else if (candidates.length > 1) {
      item.candidates = candidates.map((c) => ({ appId: c.appId, appName: c.appName, updateTime: c.updateTime }));
      ambiguous.push(item);
    } else {
      item.allApps = targetApps.map((a) => ({ appId: a.appId, appName: a.appName }));
      missing.push(item);
    }
  });

  return {
    ok: true,
    backupFile: path.basename(fileName),
    sourceAccount: backup.meta.sourceAccount,
    targetAccount: account ? { userId: account.userId, userName: account.userName, displayName: account.displayName } : null,
    sameAccount: account && backup.meta.sourceAccount && account.userId === backup.meta.sourceAccount.userId,
    summary: {
      total: backup.triggers.length,
      matched: matched.length,
      ambiguous: ambiguous.length,
      missing: missing.length,
      duplicate: duplicates.length,
      targetAppCount: targetApps.length,
    },
    matched, ambiguous, missing, duplicate: duplicates,
  };
}

// ================= 触发器导入 =================
function buildAddArgs(t, targetAppId) {
  const type = (t.triggerType || t.domain || '').toLowerCase();
  const args = ['console', 'trigger'];
  if (type === 'schedule') {
    args.push('schedule', 'add', '--app-id', targetAppId, '--name', t.name, '--cron', t.details.cron);
    const et = t.details.endTime;
    if (et && !String(et).startsWith('0001-')) args.push('--end-time', et);
  } else if (type === 'email' || type === 'file' || type === 'folder' || type === 'hotkey') {
    const sub = (type === 'file' || type === 'folder') ? 'file' : type;
    args.push(sub, 'add', '--app-id', targetAppId, '--name', t.name, '--details-json', JSON.stringify(t.details));
  } else {
    return null;
  }
  if (t.enabled === false) args.push('--enabled=false');
  if (t.queueWhenBusy) args.push('--queue-when-busy');
  if (t.timeout && t.timeout > 0) args.push('--timeout', String(t.timeout));
  return args;
}

async function importTriggers(fileName, assignments, dryRun) {
  const { backup } = loadBackup(fileName);
  const results = [];
  let okCount = 0, failCount = 0, skipCount = 0;

  for (const t of backup.triggers) {
    const targetAppId = assignments ? assignments[t.id] : null;
    if (!targetAppId) {
      skipCount++;
      results.push({ name: t.name, type: t.triggerType, status: 'skipped', message: '未分配目标应用', command: '' });
      continue;
    }
    const args = buildAddArgs(t, targetAppId);
    if (!args) {
      skipCount++;
      results.push({ name: t.name, type: t.triggerType, status: 'skipped', message: '不支持的触发器类型: ' + t.triggerType, command: '' });
      continue;
    }
    const display = config.CLI_EXE + ' ' + argsToDisplay(args);
    if (dryRun) {
      results.push({ name: t.name, type: t.triggerType, status: 'dry-run', message: '预览', command: display });
      continue;
    }
    const r = await runCli(args);
    if (r.ok) {
      okCount++;
      results.push({ name: t.name, type: t.triggerType, status: 'ok', message: '创建成功', command: display, data: r.data });
    } else {
      failCount++;
      results.push({ name: t.name, type: t.triggerType, status: 'fail', message: r.message || r.error || '创建失败', command: display });
    }
  }

  if (!dryRun) clearCache(); // 导入后清空缓存，确保后续读取拿到最新触发器列表

  return {
    ok: true,
    dryRun: !!dryRun,
    summary: { total: backup.triggers.length, ok: okCount, fail: failCount, skipped: skipCount },
    results,
  };
}

// ================= 分组同步 =================
// 导出当前账号的「分组 + 分组内应用」结构，用于跨账号同步分组名称并归组应用。

async function exportGroups(onlyGroups) {
  const [account, groups, apps] = await Promise.all([
    fetchCurrentAccount(),
    fetchAllGroups(),
    fetchAllApps(),
  ]);

  // 同步范围过滤：onlyGroups 提供时，仅导出命中的分组（精确匹配分组名）
  const wanted = new Set();
  if (Array.isArray(onlyGroups) && onlyGroups.length) onlyGroups.forEach((n) => { const v = String(n).trim(); if (v) wanted.add(v); });
  let selected = groups;
  if (wanted.size) {
    selected = groups.filter((g) => wanted.has(g.name));
    if (!selected.length) {
      const err = new Error('未找到匹配的分组：' + [...wanted].join('、') + '。请确认分组名称与影刀客户端中完全一致。');
      err.code = 'NO_MATCH';
      throw err;
    }
  }

  // 未分组应用（groupId 为空/缺失）——不同步，仅统计数量用于提示
  const ungroupedCount = apps.filter((a) => !a.groupId).length;

  const backup = {
    meta: {
      version: 1,
      exportedAt: new Date().toISOString(),
      groupCount: selected.length,
      totalGroupCount: groups.length,
      onlyGroups: wanted.size ? [...wanted] : null,
      ungroupedAppCount: ungroupedCount,
      sourceAccount: account ? {
        userId: account.userId,
        userName: account.userName,
        displayName: account.displayName,
        accountType: account.accountType,
      } : null,
    },
    groups: selected.map((g) => ({
      groupId: g.groupId,
      name: g.name,
      appType: g.appType,
      // 归入该分组的应用（按 groupId 匹配）；未分组应用不在此列，不会同步
      apps: apps.filter((a) => a.groupId === g.groupId).map((a) => ({ appId: a.appId, appName: a.appName })),
    })),
  };
  ensureDir(config.BACKUP_DIR);
  const ts = localTs();
  const accTag = account ? String(account.userName || account.displayName || 'unknown').replace(/[^\w@.-]/g, '_') : 'unknown';
  const fileName = `groups_${accTag}_${ts}.json`;
  const filePath = path.join(config.BACKUP_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8');
  return { ok: true, file: fileName, count: selected.length, ungroupedAppCount: ungroupedCount, account: backup.meta.sourceAccount };
}

function loadGroupBackup(fileName) {
  const safe = path.basename(fileName);
  const filePath = path.join(config.BACKUP_DIR, safe);
  if (!fs.existsSync(filePath)) throw new Error('备份文件不存在: ' + safe);
  const backup = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!backup || !Array.isArray(backup.groups)) throw new Error('备份文件格式不正确（缺少 groups 数组）');
  return { backup, fileName: safe };
}

/**
 * 分组同步预览：读取源分组备份，与目标账号现有分组/应用做匹配。
 * @param fileName 源分组备份文件名
 * @param onlyGroups 可选，仅同步这些分组名称（不传则同步全部）
 * 返回：
 *  - groups: 需要创建的分组（目标不存在同名分组）
 *  - existingGroups: 目标已存在的同名分组（直接复用其 groupId）
 *  - moves: 需要移动的应用（源应用名在目标有同名应用 → 归入目标分组）
 *  - unmatchedApps: 源分组内应用在目标无同名应用（无法归组）
 */
async function matchGroups(fileName, onlyGroups) {
  const { backup } = loadGroupBackup(fileName);
  const [targetGroups, targetApps, account] = await Promise.all([
    fetchAllGroups(),
    fetchAllApps(),
    fetchCurrentAccount(),
  ]);

  // 目标分组按名称索引（同名视为同一分组）
  const targetGroupByName = {};
  targetGroups.forEach((g) => { targetGroupByName[g.name] = g; });

  // 目标应用按名称索引
  const targetAppByName = {};
  targetApps.forEach((a) => { (targetAppByName[a.appName] = targetAppByName[a.appName] || []).push(a); });

  // 过滤：如果指定了 onlyGroups，只处理命中的分组
  const wanted = new Set();
  if (Array.isArray(onlyGroups) && onlyGroups.length) onlyGroups.forEach((n) => wanted.add(String(n).trim()));

  const toCreate = [];     // 目标不存在的分组
  const existingGroups = []; // 目标已存在的同名分组
  const moves = [];        // 需要移动的应用
  const unmatchedApps = []; // 目标无同名应用

  backup.groups.forEach((g) => {
    if (wanted.size && !wanted.has(g.name)) return; // 未在配置范围内，跳过
    const targetGroup = targetGroupByName[g.name];
    const groupId = targetGroup ? targetGroup.groupId : null;
    if (!targetGroup) {
      toCreate.push({ name: g.name, appType: g.appType, appCount: g.apps.length });
    } else {
      existingGroups.push({ name: g.name, groupId: targetGroup.groupId, appCount: g.apps.length });
    }
    // 处理分组内应用
    (g.apps || []).forEach((a) => {
      const targets = targetAppByName[a.appName] || [];
      if (targets.length === 1) {
        moves.push({ appName: a.appName, targetAppId: targets[0].appId, groupName: g.name, groupId, targetAppGroupId: targets[0].groupId });
      } else if (targets.length > 1) {
        unmatchedApps.push({ appName: a.appName, groupName: g.name, reason: '目标存在多个同名应用' });
      } else {
        unmatchedApps.push({ appName: a.appName, groupName: g.name, reason: '目标无同名应用' });
      }
    });
  });

  return {
    ok: true,
    backupFile: path.basename(fileName),
    sourceAccount: backup.meta.sourceAccount,
    targetAccount: account ? { userId: account.userId, userName: account.userName, displayName: account.displayName } : null,
    sameAccount: account && backup.meta.sourceAccount && account.userId === backup.meta.sourceAccount.userId,
    onlyGroups: Array.isArray(onlyGroups) ? onlyGroups : null,
    summary: {
      totalGroups: backup.groups.length,
      toCreate: toCreate.length,
      existingGroups: existingGroups.length,
      moveCount: moves.length,
      unmatched: unmatchedApps.length,
      targetGroupCount: targetGroups.length,
      targetAppCount: targetApps.length,
    },
    toCreate, existingGroups, moves, unmatchedApps,
  };
}

/**
 * 执行分组同步：创建缺失分组 + 移动应用。
 * @param fileName 源分组备份文件名
 * @param onlyGroups 可选，仅同步指定分组名
 * @param dryRun true 时仅预览命令
 */
async function importGroups(fileName, onlyGroups, dryRun) {
  const match = await matchGroups(fileName, onlyGroups);
  const results = [];
  const groupIdByName = {}; // 分组名 → 目标 groupId（创建后回填）
  let createOk = 0, createFail = 0, moveOk = 0, moveFail = 0, moveSkip = 0;

  // 已存在的同名分组，直接复用 groupId
  match.existingGroups.forEach((g) => { groupIdByName[g.name] = g.groupId; });

  // 1) 创建缺失分组
  for (const g of match.toCreate) {
    const args = ['console', 'app', 'group', 'create', '--app-type', 'developed', '--name', g.name];
    const display = config.CLI_EXE + ' ' + argsToDisplay(args);
    if (dryRun) {
      results.push({ kind: 'group', name: g.name, status: 'dry-run', message: '创建分组', command: display });
      continue;
    }
    const r = await runCli(args);
    if (r.ok) {
      createOk++;
      // 从返回结果解析新分组 ID
      const newId = (r.data && (r.data.groupId || r.data.id || r.data.Id)) || null;
      if (newId) groupIdByName[g.name] = newId;
      results.push({ kind: 'group', name: g.name, status: 'ok', message: '分组已创建', command: display, groupId: newId });
    } else {
      createFail++;
      results.push({ kind: 'group', name: g.name, status: 'fail', message: r.message || r.error || '创建失败', command: display });
    }
  }

  // 若创建分组后未回填 groupId，重新拉取分组列表补全映射
  if (!dryRun && match.toCreate.length) {
    try {
      const freshGroups = await fetchAllGroups();
      freshGroups.forEach((g) => {
        if (match.toCreate.some((x) => x.name === g.name) && !groupIdByName[g.name]) groupIdByName[g.name] = g.groupId;
      });
    } catch { /* 忽略，移动时会跳过缺少 groupId 的项 */ }
  }

  // 2) 移动应用到分组
  for (const mv of match.moves) {
    // dry-run 时分组可能尚未创建，使用 groupId（已存在分组）或占位
    let groupId = groupIdByName[mv.groupName] || mv.groupId;
    if (!groupId) {
      moveSkip++;
      results.push({ kind: 'move', appName: mv.appName, groupName: mv.groupName, status: 'skipped', message: '分组未创建成功，无法移动', command: '' });
      continue;
    }
    const args = ['console', 'app', 'group', 'move', '--app-id', mv.targetAppId, '--group-id', groupId];
    const display = config.CLI_EXE + ' ' + argsToDisplay(args);
    if (dryRun) {
      results.push({ kind: 'move', appName: mv.appName, groupName: mv.groupName, status: 'dry-run', message: '移动应用', command: display });
      continue;
    }
    const r = await runCli(args);
    if (r.ok) {
      moveOk++;
      results.push({ kind: 'move', appName: mv.appName, groupName: mv.groupName, status: 'ok', message: '已归入分组', command: display });
    } else {
      moveFail++;
      results.push({ kind: 'move', appName: mv.appName, groupName: mv.groupName, status: 'fail', message: r.message || r.error || '移动失败', command: display });
    }
  }

  if (!dryRun) clearCache();

  return {
    ok: true,
    dryRun: !!dryRun,
    summary: {
      createGroups: match.toCreate.length, createOk, createFail,
      moveCount: match.moves.length, moveOk, moveFail, moveSkip,
      unmatched: match.unmatchedApps.length,
    },
    results,
  };
}

module.exports = {
  normApp, normGroup, normTrigger, normTask,
  fetchAllApps, fetchAllGroups, fetchAllTriggers, fetchCurrentAccount,
  exportTriggers, loadBackup, matchTriggers, buildAddArgs, importTriggers,
  exportGroups, loadGroupBackup, matchGroups, importGroups,
  checkAccountSwitch,
};
