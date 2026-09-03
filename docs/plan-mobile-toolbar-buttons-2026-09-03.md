# 计划：手机端显示分支面板与文件浏览器按钮

日期：2026-09-03
回滚锚点：main `7a1c7b5`（v4.1.3）
分支：`feat/mobile-toolbar-buttons`

## 需求

手机端顶栏除分屏按钮外，其余工具栏按钮都要显示。

## 现状

顶栏 `.tab-actions` 里三个按钮，手机端（390px）实测全部不可见：

| 按钮 | 怎么被隐藏的 | 本次 |
|---|---|---|
| `#layoutBtn` 分屏 | `syncSplitAvailability()` 在窄到放不下两栏时置 `[hidden]` | **保持隐藏** |
| `#branchBtn` 分支面板 | `.branch-wrapper { display: none }`，media query | **改为显示** |
| `#explorerBtn` 文件浏览器 | `#explorerBtn { display: none }`，同一条 media query | **改为显示** |

那条 query 两处逐字相同：
`@media (max-width: 1024px) and (hover: none) and (pointer: coarse), (max-width: 768px)`
——覆盖到 1024px 的触屏平板，不只是手机。

分屏按钮由 JS 按可用宽度决定，跟这两条 CSS 无关，所以不动它就自动满足"分屏仍不显示"。

## 改动

1. `src/public/style.css`：删掉隐藏 `#explorerBtn` 和 `.branch-wrapper` 的两个 media block。
2. `test/git-branches.test.js`：`hides the panel on mobile...` 这条断言的意图已经反转，改写为
   "手机上可用，且面板不溢出窄屏"（保留对 `max-width: 90vw` 的约束检查）。

## 风险与验证点

- **顶栏空间**：390px 下要放下 汉堡(44) + 标签区 + `+` + 两个 44x44 按钮。标签页会被压缩，
  需实测标签仍可见可点、不换行、不横向溢出。
- **分支面板溢出**：`.branch-panel` 宽 340px / `max-width: 90vw`，右对齐。需实测在 390px 下
  完整落在视口内。原注释说"wrapper 一起隐藏，免得面板留在窄屏上打开"——现在要确认它在窄屏
  确实能正常开合。
- **文件浏览器抽屉**：`#fileExplorerModal` 之前在手机上从未暴露过，需实测抽屉能开、能列目录、
  能关闭，且不被别的层盖住。
- **平板**：这条 query 也覆盖 1024px 触屏平板，改动同样影响平板，属预期。

## 步骤

1. 建分支（回滚锚点 `7a1c7b5`）
2. 改 CSS + 改写测试 → `npm test` 全绿
3. 手机视口（390x844）实测：三按钮可见性、顶栏不破版、分支面板开合、文件抽屉开合
4. 桌面视口回归：三按钮照旧
5. CHANGELOG + 版本 4.2.0（新增手机端能力）
6. 合并回 main

## 部署

只改 CSS 和测试，两个端口都不需要重启，客户端刷新即可。
回滚：`git checkout 7a1c7b5 -- src/public/style.css test/git-branches.test.js`。
