# 升级计划：网页终端对齐 claude-cli 手感（流控 + 渲染优化）

日期：2026-08-07
基线（回滚锚点）：dev `b84f768`
适用：先改 dev(32353)，每阶段独立 git 提交、可单独回滚；dev 验证通过后 fast-forward 部署到 stable(32352)。

## 背景 / 根因

服务端 usage 扫描导致的 CPU/GC/fd 抖动已修复（commit `04299fa`）。但"用久了仍卡"属**另一个层**：客户端 xterm 写缓冲无背压地积压。

xterm 官方：为不卡 UI，每帧只处理 <16ms 数据，吞吐上限 5–35 MB/s；当 PTY 输出快过渲染，内部写缓冲无限堆积 → 终端迟钝、按键不响应。当前代码 `broadcastToSession` → `terminal.write(data)` 立即写，既无批处理也无背压。

业界（VS Code / Codespaces / Gitpod / copilot-cli）通行解法：**RAF 写批处理 + 水位背压 + WebGL 渲染**。参考：
- xterm.js Flow Control 指南：https://xtermjs.org/docs/guides/flowcontrol/
- github/copilot-cli #1805（4 层方案）：https://github.com/github/copilot-cli/issues/1805

## 目标 / 成功判据

- 连续刷屏（`find /`、大 `git diff` 等）时，输入回显 < 100ms。
- 未渲染字节稳定在水位区间内，进程内存不随刷屏无限上涨。
- 长时间使用不再"越用越卡"。

## 进度

- ✅ 阶段 1 — RAF 写批处理（commit `7ac68a5`，浏览器实测：50 次入队→1 次合并写）
- ✅ 阶段 2 — WebGL 渲染器（commit `d4e8c96`，实测 `activeRenderer=webgl`，回退链验证）
- ✅ 阶段 3 — 背压水位线（commit `9399b0d`，实测 200KB backlog→pause，排空→resume，服务端无异常）
- ⏳ 阶段 4 — DEC 2026 同步输出（可选，待评估）
- ⏳ 阶段 5 — 活跃 jsonl 增量解析（可选）
- 尚未部署到 stable(32352)，待 dev 验证手感后 ff。

## 阶段

### 阶段 0 — 取证确认主因（先证后修）
- `app.js`：`term.write(data, cb)` 回调统计"已提交未渲染字节"，超阈值 `console.warn` 打点；记录 WS 到达速率。
- 复现卡顿看探针：积压持续走高 → 实锤背压问题；积压平稳仍卡 → 转查渲染器/服务端 jsonl。
- 探针用完即删，不进最终提交。

### 阶段 1 — RAF 写入批处理（纯前端·低风险·高收益）
- 新增 `TerminalWriter`：WS `output` 先入队，每个 `requestAnimationFrame` 合并 `term.write` 一次。
- 改动：`app.js` 的 `output` 分支与 `session_joined` 回放走同一队列。
- 验证：刷屏时 `term.write` 频次降到 ~60/s；打字跟手。

### 阶段 2 — WebGL 渲染器（纯前端·中低风险）
- 把 `xterm-addon-webgl` vendored 进 `src/public/vendor/xterm/`。
- `app.js`：WebGL → 失败回退 canvas → 再回退 DOM；处理 context lost。
- 验证：控制台确认走 WebGL；滚动/刷屏更顺、字体不糊。

### 阶段 3 — 背压水位线（前后端协同·最治本·中风险）
- 客户端：`term.write` 回调累计未渲染字节；> HIGH(128KB) 发 `pause`，< LOW(16KB) 发 `resume`。
- 服务端：`server.js` 收 pause/resume → bridge `pause()/resume()` 对应 PTY；暂停期不 broadcast。
- 多连接：任一连接暂停则暂停（最慢连接驱动）。
- 安全阀：暂停超时（5s）强制 resume，杜绝永久卡死整条流。
- 验证：猛刷时未渲染字节夹在水位间、内存不涨、输入不丢。

### 阶段 4 —（可选）DEC 2026 同步输出
- 确认 xterm 版本是否原生支持 `ESC[?2026h/l`；否则在批处理层原子缓冲。

### 阶段 5 —（可选·服务端次要项）活跃 jsonl 增量解析
- 活跃会话 jsonl 变大后每 15s 全量重解析 → 改按字节偏移增量读。

## 部署节奏

阶段 0→1→2（纯前端，先做）→ 你验证手感 → 阶段 3（治本）→ 4/5 视情况。
每阶段：dev 提交 → 32353 验证 → ff 部署 32352 → 记录回滚锚点。
