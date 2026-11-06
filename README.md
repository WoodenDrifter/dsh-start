# DSH-start

`dsh web` 的**浏览器版控制台**。双击一个 exe，浏览器里就能启停服务、更新与回退版本、管理受信任域名与设备、查看访问密钥、给整台机器做一次体检。

界面是本地网页（原生 JS，零构建），服务只绑 `127.0.0.1`；关掉标签页控制台自己退出，`dsh web` 继续跑。

```
双击 DSH-start.exe → 本地 node 服务（随机端口，仅 127.0.0.1）→ 自动打开默认浏览器
```

- **运行要求**：Windows 10/11、Node.js 20+、`@deepseek-ai/dsh`（npm 全局安装）
- **依赖**：无。不用 webpack、不用 npm install，`node_modules` 一个都没有

---

## 它能做什么

| 页面 | 能做什么 |
|---|---|
| 概览 | 服务状态、PID、运行时长、带 token 的访问地址；一键复制 / 打开 |
| dsh web | 启动 / 停止 / 重启、stdout 与 stderr 日志、访问地址 |
| 更新与回退 | 版本对比、更新到最新、切换任意历史版本、修复半装、回退点一键回退 |
| 域名白名单 | `--trusted-host` 增删（用隧道域名访问 dsh web 时必须加） |
| 授权设备 | 只读展示设备库：名称、来源、创建 / 到期时间、剩余天数 |
| 密钥 | dsh web 的访问 token（默认打码，可显示 / 复制）、设备密钥一览 |
| 设置 | 监听端口、绑定地址、更新代理（含连通性测试）、npm registry |
| 环境体检 | node / dsh / npm / 目录可写 / 端口占用，一次看全 |

---

## 安装

1. 装 Node.js 20+（<https://nodejs.org/>），确认 `node -v` 能出结果。
2. 装 dsh：

   ```powershell
   npm i -g @deepseek-ai/dsh
   ```

3. 解压本项目到任意目录（**不要只复制 exe**，整个文件夹要一起移动），双击 `DSH-start.exe`。

第一次启动需要几秒：node 起来后会在浏览器里打开控制台。

> 如果放在 `C:\Program Files` 这类受保护目录，`npm install` 和写日志可能需要管理员权限。放到用户目录（例如 `D:\Tools\DSH-start`）更省事。

---

## 退出行为（不占内存）

控制台是「用完即走」的：

| 情形 | 行为 |
|---|---|
| 关闭标签页 | 约 **8 秒**后 node 进程自行退出（宽限期用来吸收「刷新页面」） |
| 浏览器崩溃 / 强杀（没发关闭事件） | 最后一次心跳后 **75 秒**退出 |
| 双击后浏览器一直没打开 | **120 秒**后退出，绝不留孤儿进程 |
| 有长任务在跑（更新、回退） | **先等任务结束再退**，最多 30 分钟，避免 `npm install` 被中断成半装 |
| 点侧边栏「退出」 | 立即退出 |

无论哪种方式退出，`dsh web` 都继续运行。三条时延可以用环境变量调：

```
DSH_START_GRACE_MS=8000     # 关页后的宽限
DSH_START_IDLE_MS=75000     # 心跳兜底窗口
DSH_START_BOOT_MS=120000    # 启动后等浏览器连上来的最长时间
```

---

## 几个关键设计

**热路径不起子进程。** 端口归属来自 1 秒缓存的 `netstat` 快照，`dsh` 版本直接读 `package.json`。启动器本身只做一件事：用 `CREATE_NO_WINDOW` 拉起 `node server\main.js` 然后退出（约 0.1 秒），所以双击零闪窗、无控制台。

**更新是可恢复的。** 每次更新前先落一条回退点 + 一份数据备份，安装阶段写 `config\install-journal.json`，成功后删除。控制台被强杀留下「目录在、package.json 没了」的半装状态时，下次启动会在界面上明确提示，并可「修复安装」（不碰数据）。

**回退顺序固定**：停服 → 重装程序版本 → 校验 → 恢复数据 → 重启。数据恢复里个别文件失败（被占用、只读）不会把版本卡在损坏状态。

**查版本走真正的 CONNECT 隧道**（`tls.connect` + 自定义 Agent）；代理不通会自动退回直连，并在页面上标注「本次已直连」。

**token 从日志里来。** dsh web 每次启动都会打印带 token 的访问地址，控制台读它最后一条；重启后旧 token 立即失效，所以「密钥」页会跟着服务状态刷新。

---

## 安全

- 控制台只绑 `127.0.0.1`，启动时生成一次性随机 key，用 `?k=` 换 `HttpOnly; SameSite=Strict` 的 Cookie。
- 非 GET 请求再校验 `Origin`，防止浏览器里别的网页往本机接口发请求。
- 直接输入地址打不开（会提示「从桌面快捷方式进入」）。
- 端口上的进程若不是 dsh（指纹不匹配），控制台不会去杀它，只提示占用者 PID。

---

## 目录结构

```
DSH-start\
├─ DSH-start.exe            启动器（双击入口，无控制台窗口）
├─ app.ico                  图标（exe 图标 + 网页 favicon）
├─ package.json
├─ server\                  控制台服务
│  ├─ main.js               入口：单实例 → 监听 → 开浏览器 → 关页即退
│  ├─ http.js router.js     极简 HTTP 与路由
│  ├─ sse.js jobs.js        任务进度推送 / 长任务
│  ├─ session.js            「关页即退」状态机
│  └─ routes\index.js       全部 API
├─ lib\
│  ├─ paths.js settings.js log.js util.js runtime.js
│  ├─ netstat.js            监听表快照 + dsh 指纹识别
│  ├─ proc.js               脱离控制台的 spawn / 树杀 / 端口等待
│  ├─ dsh.js env.js         dsh web 的状态、启停与体检
│  ├─ zip.js backup.js      自研 zip 读写、数据备份与恢复（更新/回退内部使用）
│  ├─ registry.js npm.js    多源竞速、CONNECT 代理、npm 调用
│  └─ update.js restorepoints.js
├─ public\                  前端（原生 JS，零构建）
│  ├─ index.html app.js api.js ui.js
│  ├─ pages\                overview / dsh / update / hosts / devices / keys / settings / env
│  └─ styles\
├─ config\                  settings.json / runtime.json / devices.json（首次运行生成）
├─ logs\                    app.log / boot.log / web.*.log / jobs\
├─ backups\                 *.zip（更新前的数据备份）
├─ restore-points\          回退点
└─ tools\                   Build-Launcher.ps1 / launcher\DSH-start.cs / pack.mjs
```

`config\`、`logs\`、`backups\`、`restore-points\` 都是运行时数据，**不参与发布**，也在 `.gitignore` 里。

---

## 开发

```powershell
# 手动起控制台（调试用，不自动打开浏览器）
node server\main.js --no-open --port 3999

# 重新编译启动器（只在改过 tools\launcher\DSH-start.cs 后需要）
pwsh -File tools\Build-Launcher.ps1

# 打包发布 zip（自动跳过 config / logs / backups / restore-points）
node tools\pack.mjs . dist\DSH-start.zip
```

前端没有构建步骤：改 `public\` 下的文件，刷新页面即生效。

**环境变量**

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | dsh 数据目录（默认 `~\.dsh`） |
| `DSH_START_NODE` | 指定 node.exe |
| `DSH_START_DSH_BIN` | 指定 dsh 的 `lib/bin.js` |
| `NPM_CONFIG_PREFIX` | npm 全局前缀（默认 `%APPDATA%\npm`） |
| `DSH_START_NO_WATCHDOG` | `1` = 没人连也不自动退出（自动化测试用） |

---

## 排障

| 现象 | 处理 |
|---|---|
| 双击没反应 | 安全软件拦了进程创建：把整个文件夹加白名单；或看 `logs\boot.log` |
| 页面白屏 / 提示缺少凭据 | 从桌面快捷方式重新打开（Cookie 失效） |
| 端口被占用（非 dsh） | 概览页显示占用者 PID；控制台不会去动别人的进程 |
| 检查更新失败 | 设置里测一下代理；代理不通时会自动退回直连并标注 |
| 更新被打断，dsh 起不来 | 「更新与回退」页会显示**安装损坏**，点「修复安装」重装（不碰数据） |
| 回退时提示部分文件失败 | 这些文件被占用或带只读属性；程序版本已回退成功，重开 dsh 后再恢复一次 |
| 隧道域名访问接口全 401 | 到「域名白名单」把域名加上，然后重启 dsh web（走 `--trusted-host`） |
| 从隧道访问提示不安全 | dsh web 只认它自己信任的 Host，域名必须先在白名单里 |

---

## API

所有接口都在 `/api/` 下，需要 `dsx` Cookie。成功返回 `{ ok: true, data }`，长任务返回 `202 { jobId }`，失败返回 `{ ok: false, error: { code, message } }`。

```
GET    /api/status                 总状态（服务 / 版本 / 任务 / 会话）
GET    /api/system/env             环境体检
POST   /api/web/start|stop|restart 启停 dsh web
GET    /api/web/logs?stream=out    日志尾巴
GET    /api/web/access             访问地址与 token
GET    /api/hosts                  受信任域名列表
POST   /api/hosts                  添加域名
DELETE /api/hosts/:host            移除域名
GET    /api/devices                授权设备（只读）
GET    /api/keys                   访问 token 与设备密钥
GET    /api/update/check           版本对比
GET    /api/update/versions        可选版本列表
POST   /api/update/install|repair  更新 / 修复
GET    /api/restore-points         回退点列表
POST   /api/restore-points/:id/rollback   回退
GET    /api/jobs/:id               任务进度
```

---

## 更新日志

**2.1.0**
- 移除 bsk 浏览器扩展 daemon 的全部功能（页面、接口、看门狗、路径与设置项）
- 移除独立「备份」页面；数据备份保留为更新/回退的内部步骤
- 新增「密钥」页：访问 token 查看 / 复制、设备密钥一览
- 导航重排为 服务 / 版本 / 安全 / 系统 四组
- 代理默认值改为空（不再预设本机 7890）

**2.0.x** — 浏览器版控制台：单实例、关页即退、更新与回退、多源竞速。

---

## 许可

未附许可证时默认保留所有权利。要开源请在仓库根目录添加 `LICENSE`（MIT / Apache-2.0 均可），并同步改这一节。
