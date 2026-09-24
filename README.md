# 影刀 RPA 网页控制台

零 npm 依赖的影刀 RPA 控制台服务端 + 模块化控制台前端（ES Modules），含触发器跨账号迁移、分组同步与账号密码登录功能。

> 如果这个项目对你有帮助，欢迎在仓库页点个 ⭐ Star 支持一下～

## 功能模块

| 模块 | 说明 |
|------|------|
| 仪表盘 | 账号信息、系统状态、应用/触发器/消息/扩展数量统计、本机/局域网访问地址 |
| 应用管理 | 搜索、分组、分页、运行（异步）、跳转任务 |
| 任务管理 | 历史记录、状态筛选、日志查看、视频回放、停止/重跑 |
| 触发器管理 | 全部/定时/邮件/文件夹/热键分类、启用/禁用开关、新增/编辑/删除 |
| 触发器迁移 | 跨账号导出 → 名称匹配 → 人工映射兜底 → dry-run 预览 → 批量导入 |
| 分组同步 | 跨账号导出分组 → 切换账号 → 匹配确认 → 创建缺失分组并归组应用（支持仅同步指定分组名、未分组应用不同步） |
| 账号切换 | 账号列表分页 + 模糊搜索（账号名/显示名），切换前自动检测运行中任务与 Studio 编辑状态 |
| 消息中心 | 已读/未读、标记已读、全部已读 |
| 扩展管理 | 扩展列表与安装状态 |
| 系统设置 | 配置管理、console/assistant 模式切换 |
| 访问鉴权 | 账号密码登录（单管理员），登录态自动持久化、默认 7 天，支持「退出登录」 |

## 目录结构

```
├── server.js              # 服务入口（精简）
├── config.js              # 配置加载（.env + 默认值 + 路径自动探测）
├── .env.example           # 配置模板（脱敏，复制为 .env 使用）
├── lib/
│   ├── utils.js           # 通用工具
│   ├── rest.js            # 影刀 REST 客户端
│   ├── cli.js             # CLI 封装 + 缓存
│   ├── auth.js            # 登录鉴权（账号密码 + 带有效期 token）
│   └── business.js        # 业务逻辑（导出/匹配/导入）
├── routes/
│   ├── index.js           # 路由聚合与分发
│   ├── system.js          # 健康检查/状态/分组/CLI 执行
│   ├── apps.js            # 应用
│   ├── tasks.js           # 任务/日志/视频
│   ├── auth.js            # 账号
│   ├── migration.js       # 触发器迁移
│   └── groupSync.js       # 分组同步
├── public/
│   ├── index.html         # 页面骨架
│   ├── style.css          # 样式
│   └── js/                # 前端逻辑（ES Modules）
│       ├── main.js        # 入口（副作用引入各页面并启动）
│       ├── router.js      # 全局状态 + 页面注册表 + 导航
│       ├── utils.js       # DOM/UI/格式化工具
│       ├── api.js         # fetch/CLI 封装 + 登录令牌
│       ├── constants.js   # 常量与图标
│       ├── account.js     # 账号列表（分页 + 搜索）
│       └── pages/         # 各功能页面模块
│           ├── dashboard.js / apps.js / tasks.js / triggers.js
│           ├── migration.js / groupSync.js
│           └── messages.js / extensions.js / settings.js
├── start.bat / stop.bat   # Windows 一键启停
└── backups/               # 触发器备份目录（已被 .gitignore 排除）
```

## 快速开始

### 前置条件

- 影刀 RPA 客户端已安装并登录
- `shadowbot.shell-cli.exe` 可用（路径会自动探测，无需手动加入 PATH）
- Node.js ≥ 16（无需任何 npm 依赖；`start.bat` 会自动探测 node，命令行方式需 node 在 PATH）

### 方式一：一键脚本（推荐，Windows）

- 启动：双击 `start.bat`
- 停止：双击 `stop.bat`

### 方式二：命令行

```bash
node server.js
# 或
npm start
```

访问 `http://127.0.0.1:18923`（局域网访问地址会在页面侧边栏和仪表盘显示）。

## 配置

影刀安装目录与 CLI 路径会**自动探测**（`where` 命令 → 常见安装目录扫描），因此绝大多数电脑**无需任何配置**即可运行。

如需覆盖，复制 `.env.example` 为 `.env` 后按需修改（`.env` 已被 `.gitignore` 排除，不会提交）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `18923` | 监听端口 |
| `HOST` | `0.0.0.0` | `0.0.0.0` 局域网可访问，`127.0.0.1` 仅本机 |
| `AUTH_USER` | `admin` | 控制台登录账号 |
| `AUTH_PASS` | 留空（不启用） | 控制台登录密码，设置后需账号密码登录 |
| `AUTH_TTL_DAYS` | `7` | 登录有效期（天），到期后需重新登录 |
| `ALLOWED_ORIGINS` | 留空 | 额外放行的来源主机（逗号分隔）。默认只信任本机与各网卡 IP，仅在反向代理/自定义域名访问时需配置 |
| `CLI_EXE` | 自动探测 | CLI 可执行文件（自动解析为安装目录下的绝对路径） |
| `CLI_CWD` | 自动探测 | 影刀安装目录（自动定位，无需手填） |
| `SCREENCAST_DIR` | 自动探测 | 视频回放目录（默认「安装目录\screencast」） |
| `BACKUP_DIR` | 项目下 `backups/` | 备份存储目录 |
| `REST_HOST` / `REST_PORT` | `127.0.0.1` / `42500` | 影刀本地 REST API |

也可通过环境变量直接设置。自动探测会扫描常见安装目录（`D:\ShadowBot`、`D:\soft\ShadowBot`、`C:\Program Files\ShadowBot` 等）；仅当影刀装在非常规位置时才需手动设置 `CLI_EXE` / `CLI_CWD`。

### 自动探测失败怎么办

自动探测按以下顺序查找影刀：`where shadowbot.shell-cli.exe`（系统 PATH）→ 常见安装目录（`D:\ShadowBot`、`D:\soft\ShadowBot`、`C:\Program Files\ShadowBot`、`C:\Program Files (x86)\ShadowBot`、`%LOCALAPPDATA%\ShadowBot`、`%APPDATA%\ShadowBot` 等）。

若影刀装在**非常规位置**导致探测失败，启动时控制台会打印 `[警告] 未自动探测到影刀安装目录`。此时手动配置即可：

1. 复制 `.env.example` 为 `.env`
2. 在 `.env` 中取消注释并填写（以影刀装在 `E:\MyTools\ShadowBot` 为例）：

```ini
CLI_EXE=E:\MyTools\ShadowBot\shadowbot.shell-cli.exe
CLI_CWD=E:\MyTools\ShadowBot
SCREENCAST_DIR=E:\MyTools\ShadowBot\screencast
```

3. 重新启动服务

> 如何找到影刀安装目录：右键桌面/开始菜单的影刀快捷方式 →「打开文件所在位置」，找到 `shadowbot.shell-cli.exe` 所在目录即可。

### 访问鉴权（账号密码登录，局域网部署建议开启）

默认 `HOST=0.0.0.0` 意味着**局域网内任何设备都能访问并操作**本控制台（含账号切换、触发器迁移等写操作）。若需在多设备局域网环境使用，建议开启账号密码登录：

1. 在 `.env` 中设置登录账号和密码：

```ini
AUTH_USER=admin
AUTH_PASS=请改成你的密码
AUTH_TTL_DAYS=7
```

2. 重启服务后，浏览器首次访问会弹出「登录」框，输入账号密码后自动记住（存于浏览器 `localStorage`），有效期默认 7 天，到期后重新弹出登录框。

3. 登录后，页面顶部右上角（账号显示旁）有「**退出登录**」按钮，点击确认后清除本地登录态并重新弹出登录框。

> 说明：这是**简单访问控制**（单管理员账号），用于防止局域网内的误操作，并非专业安全方案（密码明文存于 `.env`，令牌经本地 HTTP 明文传输，不防中间人）。仅本机使用时可保持 `AUTH_PASS` 留空。

### 来源守卫（默认开启，无需配置）

服务会校验每个请求的 `Host` 与 `Origin`，**只放行来源主机属于本机或本机网卡 IP 的请求**，其余一律返回 `403`：

- 防止「本机浏览器打开任意网页时，该网页的脚本跨域调用本控制台」——这在不设密码时尤其危险。
- 防止 DNS rebinding：攻击者域名解析到 `127.0.0.1` 后，`Host` 会是该域名，直接被拒。

正常从 `http://127.0.0.1:18923` 或 `http://<本机局域网IP>:18923` 访问不受影响。
若通过反向代理或用自定义域名访问，会被拒（403），此时需在 `.env` 中把它加入 `ALLOWED_ORIGINS`。

## 触发器迁移工作流

1. **导出/上传备份**：在源账号登录态下点击"导出当前账号触发器"，或上传已有备份 JSON
2. **切换账号**：在记住的账号列表中选择目标账号并切换，或手动在影刀客户端切换后刷新
3. **匹配确认**：按应用名称自动匹配 → 重名应用人工选择 → 未匹配手动指定或跳过 → 已存在同名触发器默认跳过
4. **执行导入**：dry-run 预览命令列表 → 确认后正式导入 → 逐条结果报告

### 注意事项

- 邮件触发器导出数据不含 IMAP 授权码（影刀 DPAPI 加密），导入后需手动填写
- 热键触发器通过 `details-json` 创建，如失败会在结果中显示原因
- 同一台电脑同一时刻只能登录一个账号，导出与导入必须串行完成

## 账号切换说明

- 账号列表支持**分页**和**模糊搜索**（按账号名或显示名，不区分大小写）
- 影刀 CLI 在客户端「已登录」状态下无法直接切换账号（`auth login` 会返回"当前账号已登录"且无 logout/switch 命令），因此切换采用「**关闭影刀客户端进程 → 重新登录目标账号 → 轮询确认**」机制，整个过程约需 5~15 秒
- 切换会**关闭并重启影刀客户端**，切换前会自动检测运行中任务与 Studio 编辑状态：存在运行中任务或 Studio 编辑时**拒绝切换**并提示原因

## 分组同步工作流

1. **导出**：在源账号登录态下填写「同步范围」（留空 = 全部分组；填写 = 仅导出匹配的分组名，逗号分隔），点击"导出当前账号分组"
2. **切换账号**：切换到目标账号（同「账号切换」机制）
3. **匹配确认**：分组按名称精确匹配（目标同名复用分组 ID，否则标记待创建）；应用按名称精确匹配（目标同名唯一才归组）
4. **执行同步**：dry-run 预览 → 创建缺失分组 → 回填分组 ID → 逐条将应用移入对应分组

### 注意事项

- 源账号「未分组」的应用不会同步（导出时即排除）
- 填写的分组名需与实际分组名**完全一致**（自动去除首尾空格），填错会提示"未找到匹配的分组"而非静默导出全部

## API 端点

> **鉴权范围**：除 `POST /api/login` 外，**所有 `/api/*` 端点都受登录鉴权保护**，需在请求头带 `X-Auth-Token`（值为 `/api/login` 返回的 token），未携带或已失效时返回 `401`。
> 另外所有请求都会先过「来源守卫」（校验 `Host` 与 `Origin`），来源不属于本机或本机网卡 IP 时返回 `403`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 控制台页面（静态资源，不受鉴权保护） |
| GET | `/api/health` | 健康检查（含局域网 IP） |
| POST | `/api/login` | 控制台登录（账号密码 → 签发带有效期的 token） |
| POST | `/api/exec` | 通用 CLI 执行（白名单） |
| POST | `/api/cache/clear` | 清除缓存 |
| GET | `/api/system/status` | 系统状态汇总 |
| GET | `/api/app-groups` | 应用分组列表 |
| GET | `/api/apps` | 应用列表 |
| GET | `/api/tasks` | 任务历史 |
| GET | `/api/tasks/:id/logs` | 任务日志 |
| GET | `/api/tasks/:id/video` | 视频回放文件查询 |
| POST | `/api/tasks/:id/video/open` | 打开视频播放器（在服务器上启动播放器，有副作用故用 POST） |
| GET | `/api/auth/accounts` | 记住的账号列表 |
| POST | `/api/auth/switch` | 切换账号（关停影刀进程后重新登录目标账号；切换前检测运行中任务/Studio 编辑，占用则拒绝） |
| POST | `/api/migration/export` | 导出当前账号触发器 |
| GET | `/api/migration/backups` | 列出备份文件 |
| POST | `/api/migration/backups/delete` | 删除备份文件 |
| POST | `/api/migration/backups/upload` | 上传备份文件 |
| POST | `/api/migration/match` | 名称匹配 |
| POST | `/api/migration/import` | 导入（支持 dry-run） |
| POST | `/api/group-sync/export` | 导出当前账号分组结构 |
| GET | `/api/group-sync/backups` | 列出分组备份文件 |
| POST | `/api/group-sync/backups/delete` | 删除分组备份文件 |
| POST | `/api/group-sync/backups/upload` | 上传分组备份文件 |
| POST | `/api/group-sync/match` | 分组匹配（支持 onlyGroups 仅同步指定分组） |
| POST | `/api/group-sync/import` | 执行分组同步（支持 dry-run） |


## License

MIT
