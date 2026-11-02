# rs_flow_coding（Flow Coding）

按 APP 汇总 draw.io 流程图与 Feat 档案的桌面工具：颜色状态统计、内嵌 draw.io 实时编辑、Feat Markdown 编辑、节点标签与 Feat 联动、用户与 Agent 加锁协作、SQLite 历史快照与版本对比。

技术栈：Tauri 2 + Rust（rusqlite / roxmltree / notify）+ 原生 JS；编辑器为离线 draw.io webapp（embed 模式）；Markdown 编辑为 CodeMirror 6 + marked。

## 准备与运行

```bash
python scripts/fetch_drawio.py --proxy http://127.0.0.1:11809   # 下载并裁剪 draw.io 到 ui/drawio（约 56MB，不入库），并注入 flow_bridge.js
cd src-tauri && cargo run                                        # 启动 App
cargo build --release                                            # 发布版；flowctl.exe 同时产出
```

Agent 通过 PATH 调用 `flowctl`：发布版编译后把 `src-tauri\target\release\flowctl.exe` 复制到 `%USERPROFILE%\.cargo\bin\`（已在用户 PATH）。

`ui/vendor/vendor.js`（CodeMirror + marked 打包结果）已入库；升级依赖时运行 `python scripts/build_vendor.py`（需要 Node，用 esbuild 打包 `scripts/vendor_entry.js`）。

首次启动点「项目根」填入项目目录（每行一个），再点「全量扫描」。之后「刷新」只读取已发现的目录，不再遍历整个仓库。

单实例运行：再次双击 exe 只会把已打开的窗口调到前面。启动失败时弹窗显示错误原因。

## 文件约定

- 流程图：`<app>/docs/flow/<模块>.drawio`，未压缩 XML（App 内保存强制 `compressXml=false`）。
- Feat 档案：`<app>/docs/feat/Feat_YYMMDD_N_<名称>.md`。
- APP 识别：`docs/flow` 或 `docs/feat` 的上两级目录为 APP，APP 的父目录以 `group_` 开头时作为分组。
- 数据目录：`%APPDATA%\rs_flow_coding\`（`config.json`、`flow.db`、`locks\`）；环境变量 `FLOW_CODING_HOME` 可覆盖。

## 节点颜色状态

| 颜色 | 识别（fillColor） | 状态 | 谁标记 | 之后变成 |
| --- | --- | --- | --- | --- |
| 无色 | 空 / `#FFFFFF` | 已实现 | - | - |
| 黄 | `#FFF2CC` | 起草待审 | Agent | 同意 → 绿；不同意 → 红 |
| 灰虚线 | `#F5F5F5` + `dashed=1` | 计划删除 | Agent | 同意 → 绿虚线；不同意 → 无色 |
| 红 | `#F8CECC` | 有问题（写在节点里或便签连到节点） | 用户 | Agent 修正后 → 黄 |
| 蓝 | `#DAE8FC` | 用户的想法或改动 | 用户 | 可行 → 黄；不可行 → 保持蓝 + 便签写原因 |
| 绿 | `#D5E8D4` | 已确认，下一轮执行 | 用户 | Agent 改完代码 → 无色 |
| 绿虚线 | `#D5E8D4` + `dashed=1` | 确认删除 | 用户 | Agent 删除节点与对应代码 |
| 其他 | 其他颜色 | 未识别 | - | 改成上表颜色 |

不计入统计：连线、便签（`shape=note`）、文本、泳道、分组。顶部「待你审」= 黄 + 灰虚线；「待 Agent」= 红 + 蓝 + 绿 + 绿虚线。

## Feat 联动

- 左侧树每个 APP 分「流程图」「Feat」两组；Feat 行显示编号、状态、§3.1 任务进度（完成/取消计为完成）、挂接节点数，全部节点无色时标「可关闭」。点「+」新建 Feat（编号 = 今天日期 + 当天序号）。
- 流程图与 Feat 档案可左右分栏同时显示，中间拖动调整宽度；Feat 栏有源码 / 分屏 / 预览三种模式，同样实时保存、加锁。
- Feat 档案 Ctrl+Z 撤销、Ctrl+Y 重做；预览模式下最后点过 Feat 栏时也生效。撤销历史按档案独立，切换档案后清空；Agent 改动同步进来后不会被撤销。
- 关联方式：节点外层 `<object>` 上写 `tags="Feat_YYMMDD_N"`（可多个，空格分隔）。在流程图中选中节点，点底部常驻状态栏「挂到 Feat_xxx」或「从 Feat_xxx 摘除」。
- 打开 Feat：高亮同 APP 下挂了该编号的节点，「关联节点」列表按图分组，点击定位到节点。Feat 编号仅在各自 APP 内有效；跨 APP 同号标签不会高亮或允许新增挂接，底部会显示所属 APP，残留标签可摘除。
- 点击节点：挂了 1 个 Feat 直接打开；挂了多个时弹列表选择，可按 Esc、点取消或点弹窗外关闭。打开后定位档案中引用该节点的位置。节点右上角蓝色书签显示挂接 Feat 数量（超过 9 显示 9+），角标不写入流程图文件。
- 档案中用 `<图名>.drawio#<节点id>` 引用节点，预览里可点击跳转；「插入节点引用」把当前选中节点插入光标处。

## 状态与收纳

- Chart 与 Feat 分组使用图标、加粗标题和数量徽标。开启/启用条目不额外显示状态，关闭/废弃/停用条目灰显；右键条目打开状态菜单（也支持 Shift+F10），Chart 停用后收纳，可重新启用；收纳的 Feat 可重新开启，恢复时选择需求、开发或测试阶段。
- Feat 以 Markdown 档案头的「状态」和「关闭」日期为真源：`已关闭`、`已废弃`进入收纳区；开发完成、测试完成不会自动关闭。Feat 的「关闭 / 废弃」不在 App 内写文件：菜单弹窗显示未完成任务、非无色节点数量和对应命令（`/smallcat-feat-5-close <编号>`、`/smallcat-feat-drop <编号> <原因>`），复制到 Agent 会话执行，由 skill 同步发布说明、CHANGELOG、README 并提交；后端也拒绝直接写「已关闭」「已废弃」。
- Chart 停用信息保存在各 APP 的 `docs/flow/.flow-coding.json`，按含扩展名的文件名记录 `status: "disabled"` 与 RFC3339 `disabled_at`；未记录的图默认启用，重新启用移除对应记录。此文件随项目 Git 同步。
- 收纳保留文件原路径及节点标签。关闭 Feat 不会停用关联图；停用 Chart 不再计入 APP 与顶部待办，原图、历史快照及 Feat 关联仍保留，可继续查看。
- 收纳区默认折叠，展开后按关闭/停用年份分组；每组先显示 20 项，点「再显示」继续。搜索默认匹配活跃项，勾选「搜索含历史」可查收纳内容。
- 侧栏折叠、收纳区展开及历史筛选偏好写入本机 `%APPDATA%\rs_flow_coding\config.json` 的 `sidebar`；搜索词不持久化。SQLite `flow.db` 继续保存本机图历史和统计。
- 状态变更遵守编辑锁；Feat 在确认期间内容变化会拒绝覆盖，停止编辑后刷新重试。元数据损坏直接提示错误，不会静默视为全部启用。

## 窗口、主题与大纲

- 点流程图栏或 Feat 栏右上角「⧉」弹为独立窗口；每类最多一个，之后在主窗口树中点同类文件会切换到对应独立窗口。关闭独立窗口后，再点树恢复在主窗口打开。关闭主窗口会退出整个应用。
- 两个窗口之间仍可点关联节点定位、点节点打开 Feat、插入选中节点引用；流程图高亮跟随当前 Feat。
- 拖动左侧树右边界调整宽度（200–640px），下次打开保留；双击边界恢复默认宽度。
- 点侧栏主题按钮循环「自动 → 浅色 → 深色」，覆盖树、Markdown 源码/预览与 draw.io；独立窗口同步主题。
- Feat 内容区左侧显示 1–4 级标题大纲，点标题定位源码与预览，滚动正文时大纲跟随；点「大纲」可收起，正文与大纲分别滚动。
- 节点信息与挂/摘按钮固定在流程图底部，选中/取消节点不会改变编辑区高度。

## 加锁协作

- App 内每次改动立即写盘（无未保存状态），首次改动加用户锁，停止编辑 3 秒释放；用户锁 60 秒无心跳失效。流程图与 Feat 档案同口径。
- Agent 改图或改 Feat 档案必须：

```bash
flowctl lock <file> --wait 30
```

  编辑文件后：

```bash
flowctl unlock <file>
```

  `lock` 被用户持有时等待至超时，失败退出码 2；`.drawio` 的 `unlock` 先校验 XML，损坏时不释放锁。Agent 锁 10 分钟失效。
- Agent 持锁期间 App 转只读遮罩；释放后自动合并磁盘最新内容，不需要重新打开。
- 其他命令：`flowctl status <file>`、`flowctl stats <file|dir>...`、`flowctl nodes <file> [--status review]`、`flowctl new <dir> <name>`。
- Feat 命令：`flowctl feat <feat.md> [--status s]` 列出同 APP 流程图中挂了该编号的节点；`flowctl check <feat.md>` 为关闭门槛，挂接节点全部无色退出码 0，没有挂接节点或仍有非无色节点退出码 3。

## 历史

每次写盘（用户保存、Agent unlock、外部改动、扫描）内容变化即记一条快照，同内容不重复。历史面板勾选两个快照对比：按节点 id 列出新增、删除、文字变化、状态变化（如 黄 → 绿）；可只读查看旧版或回滚（回滚本身也是一条快照）。

## 开发

```bash
cd src-tauri && cargo test --lib                         # 单元测试
python scripts/dev_server.py --samples tests/samples     # 浏览器预览（注入 Tauri 模拟层）
```

APP 文件夹行：双击名称直接原位编辑本机显示名，Enter 或失焦保存，Esc 取消；清空或填回原名恢复默认。灰色小字保留原目录名，宽度不足时省略。整行不换行，固定依次显示起草待审、待 Agent 实现（绿色确认与确认删除合计）、有问题三个统计，其他非零状态按剩余宽度显示。点击左侧小三角折叠/展开，磁盘目录与引用路径保持原样。

## 变更记录

2026-10-30 | 0.1.0 | 首版：APP 汇总与颜色统计、draw.io 内嵌实时编辑、用户/Agent 加锁、SQLite 历史快照与对比、flowctl CLI
2026-11-02 | 0.2.0 | Feat 联动：树分流程图/Feat 两组、Feat Markdown 实时编辑与加锁、流程图与 Feat 分栏、节点 tags 关联与多 Feat 选择、flowctl feat/check
2026-11-02 | 0.2.1 | 单实例运行（重复启动激活已有窗口）、启动失败弹窗；Feat 档案 Ctrl+Z / Ctrl+Y 撤销重做
2026-11-02 | 0.2.2 | 流程图/Feat 独立窗口与跨窗口联动、侧栏宽度拖动记忆、全界面深色主题、底部常驻节点栏、同 APP 标签关联校验、节点书签计数、多 Feat 选择 Esc 取消、Feat 标题大纲与滚动定位
2026-11-02 | 0.2.2 | Feat 开启/关闭/废弃、Chart 启用/停用、按年份折叠收纳、历史搜索与分批显示；项目状态与本机侧栏偏好分开持久化，启用图参与日常待办统计
2026-11-02 | 0.2.2 | 侧栏状态操作改为条目右键菜单，移除行尾三个点和开启标识，收纳条目灰显；Chart/Feat 增加分组图标、加粗标题和数量徽标
2026-11-02 | 0.2.2 | APP 文件夹支持本机显示别名、灰色小字原目录名、重启记忆和清空恢复；名称双击编辑与小三角折叠分开处理
2026-11-02 | 0.2.2 | Feat 关闭/废弃改为弹窗提示并复制 skill 命令，后端拒绝直接写归档状态；README 补充 flowctl 安装位置
2026-11-02 | 0.2.2 | APP 名称改为原位编辑，移除改名提示 tooltip；目录行保持单行并优先显示待审、待实现、有问题统计，其余状态按宽度显示
