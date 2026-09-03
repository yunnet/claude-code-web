# 修复计划：Start Claude 遮罩吞掉创建会话弹窗

日期：2026-09-03
回滚锚点：main `55bf958`（v4.1.2）
分支：`fix/overlay-hides-modals`

## 症状

手机登录后新建 ts 目录的项目，多次重试都不成功。服务端从未收到过一次
`POST /api/sessions/create`，日志里也没有任何相关痕迹。

## 根因

`#overlay`（`.terminal-overlay`，"Start Claude" 提示）是 fixed、全视口、
z-index **5000**。`#newSessionModal`（`.session-modal`）是 z-index **2000**。
遮罩打开时（`body.overlay-open`），创建会话弹窗在遮罩**底下**弹出，被 95%
不透明的黑色盖住——看得见轮廓，点不到按钮。

手机视口（390x844，iPhone UA）实测：

```
overlayOpen: true          overlayZ: 5000   overlayDisplay: flex
modalZ:      2000          modalDisplay: flex        ← 弹窗确实弹出来了
createBtnRect: 225,269 121x44
whatIsOnTopOfCreateBtn: DIV.overlay-content          ← 按钮中心命中遮罩
clickReachesButton: false
模拟真人点击 → POST /api/sessions/create ? false
```

这是 4.1.1 那次修复的漏网之鱼。当时把 tab bar(5001)、mobile menu(5002)、
folder browser(5003) 都提到遮罩之上，唯独漏了 `.session-modal`。而这个缺陷
只有在 4.1.1 修好前几步之后才暴露——之前用户连 `+` 都点不到，走不到这一步。

同一作用域下的第二处：`.settings-modal` z-index **1000**，遮罩打开时点侧边
菜单的 Settings 同样是白点。一并修，避免又留半个。

## 触发条件

任何时候会话的 claude 进程没在跑，登录就会看到 "Start Claude" 遮罩。
2026-09-03 上午重启 32352 清掉全部旧 claude 进程后，这个状态成了必经之路。

## 修复

`src/public/style.css`，紧接现有的 overlay-open 块：

```css
body.overlay-open .session-modal  { z-index: 5004; }
body.overlay-open .settings-modal { z-index: 5004; }
```

`.session-modal` 一处覆盖四个实例：`#newSessionModal`、`#mobileSessionsModal`、
动态确认框、reconcile 弹窗。5004 高于 folder browser(5003)，低于文件浏览器
抽屉(6000)和计划弹窗(10001)——既有次序不变。

## 步骤

1. 建分支（回滚锚点 `55bf958`）
2. 先给 `test/overlay-stacking.test.js` 补断言 → 跑 → **必须先失败**
3. 改 `style.css` → 测试转绿
4. 全量 `npm test`（基线 134 passing）
5. 手机视口脚本验证 dev(32353)：遮罩打开时能走完创建流程
6. 同一脚本验证 stable(32352)
7. 回归：遮罩关闭时行为不变（既有路径不能被抬高的层级破坏）
8. CHANGELOG + 版本号 4.1.3
9. 合并回 main

## 部署

只改 CSS 和测试，不动任何服务端 JS。`express.static` 是
`Cache-Control: public, max-age=0` + ETag，两个端口都**不需要重启**——
32352 和 32353 共用同一份代码目录，客户端刷新一次即可拿到新样式。
（32353 也不能重启：本次会话的 claude 进程正是它的子进程。）

回滚：`git checkout 55bf958 -- src/public/style.css`，同样无需重启。
