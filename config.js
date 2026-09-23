/**
 * 配置模块 — 支持 .env 覆盖，路径自动探测（避免每台电脑硬编码）
 * 优先级：环境变量 > .env 文件 > 自动探测 > 兜底默认值
 *
 * 影刀安装目录会尝试自动探测（where 命令 + 常见目录扫描），
 * 因此 CLI_CWD / CLI_EXE / SCREENCAST_DIR 无需在每台电脑手动填写。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------- 极简 .env 加载器（零依赖） ----------
// 支持 KEY=VALUE、KEY="value"、# 注释、空行
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 去掉首尾成对引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile(path.join(__dirname, '.env'));

// ---------- 配置项 ----------
function env(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}
function envInt(key, fallback) {
  const n = parseInt(env(key, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- 影刀安装目录自动探测 ----------
// 优先：where 命令（系统 PATH）；其次：常见安装目录扫描。
// 返回包含 shadowbot.shell-cli.exe 的目录，找不到返回 null。
function findShadowBotDir() {
  // 1) where 命令（系统 PATH 或已注册的映射）
  try {
    const out = execSync('where shadowbot.shell-cli.exe', {
      encoding: 'utf-8', windowsHide: true, timeout: 5000,
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return path.dirname(first);
  } catch (e) { /* 忽略，走目录扫描 */ }

  // 2) 常见安装目录扫描（按命中概率排序）
  const candidates = [
    'D:\\ShadowBot',
    'D:\\soft\\ShadowBot',
    'C:\\Program Files\\ShadowBot',
    'C:\\Program Files (x86)\\ShadowBot',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ShadowBot'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'ShadowBot'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'ShadowBot'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'shadowbot.shell-cli.exe'))) return dir;
  }
  return null;
}

const shadowBotDir = findShadowBotDir();

// CLI 可执行文件：优先 .env 显式配置；否则用探测到的绝对路径；再兜底裸名（依赖 PATH）
let cliExe = env('CLI_EXE', 'shadowbot.shell-cli.exe');
if (!path.isAbsolute(cliExe) && shadowBotDir) {
  cliExe = path.join(shadowBotDir, cliExe);
}

module.exports = {
  // HTTP 服务
  PORT: envInt('PORT', 18923),
  HOST: env('HOST', '0.0.0.0'),   // 0.0.0.0 监听所有网卡（局域网可访问）；仅本机用 127.0.0.1
  // 控制台登录账号（单管理员）
  AUTH_USER: env('AUTH_USER', 'admin'),
  // 控制台登录密码：留空 = 不启用鉴权（本机单用户场景）；设置后需账号密码登录。
  // 局域网部署建议设置。密码明文存于 .env（已被 gitignore）。
  AUTH_PASS: env('AUTH_PASS', ''),
  // 登录有效期（天），到期后需重新登录
  AUTH_TTL_DAYS: envInt('AUTH_TTL_DAYS', 7),
  // 额外放行的来源主机（逗号分隔）。默认空 = 只信任本机与各网卡 IP。
  // 仅在反向代理 / 自定义域名访问时才需要配置，否则会被来源守卫拒绝（403）。
  ALLOWED_ORIGINS: env('ALLOWED_ORIGINS', ''),

  // 目录
  HTML_PATH: path.join(__dirname, 'public', 'index.html'),
  BACKUP_DIR: env('BACKUP_DIR', path.join(__dirname, 'backups')),
  // 视频回放目录：优先显式配置；否则用「安装目录\screencast」；探测不到为空
  SCREENCAST_DIR: env('SCREENCAST_DIR', shadowBotDir ? path.join(shadowBotDir, 'screencast') : ''),

  // 影刀 CLI
  CLI_EXE: cliExe,
  CLI_CWD: env('CLI_CWD', shadowBotDir || ''),
  CLI_TIMEOUT: envInt('CLI_TIMEOUT', 120000),
  // 探测到的影刀安装目录（可能为 null，供启动时校验提示）
  SHADOWBOT_DIR: shadowBotDir,

  // 影刀本地 REST API（仅本机 127.0.0.1，通常无需修改）
  REST_HOST: env('REST_HOST', '127.0.0.1'),
  REST_PORT: envInt('REST_PORT', 42500),
  REST_BASE: '/api/v1',
  REST_TIMEOUT: envInt('REST_TIMEOUT', 4000),

  // 缓存 TTL（毫秒）
  CACHE_TTL: envInt('CACHE_TTL', 30000),
  REST_CACHE_TTL: envInt('REST_CACHE_TTL', 30000),
};
