# rs_flow_coding（Flow Coding）

按 APP 汇总 draw.io 流程图的桌面工具：颜色状态统计、内嵌 draw.io 实时编辑、用户与 Agent 加锁协作、SQLite 历史快照与版本对比。

技术栈：Tauri 2 + Rust（rusqlite / roxmltree / notify）+ 原生 JS；编辑器为离线 draw.io webapp（embed 模式）。

## 准备与运行

```bash
python scripts/fetch_drawio.py --proxy http://127.0.0.1:11809   # 下载并裁剪 draw.io 到 ui/drawio（约 56MB，不入库）
cd src-tauri && cargo run                                        # 启动 App
cargo build --release                                            # 发布版；flowctl.exe 同时产出
```

首次启动点「项目根」填入项目目录（每行一个），再点「全量扫描」。之后「刷新」只读取已发现的 `docs/flow` 目录，不再遍历整个仓库。

## 文件约定

- 流程图：`<app>/docs/flow/<模块>.drawio`，未压缩 XML（App 内保存强制 `compressXml=false`）。
- APP 识别：`docs/flow` 的上两级目录为 APP，APP 的父目录以 `group_` 开头时作为分组。
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

## 加锁协作

- App 内每次改动立即写盘（无未保存状态），首次改动加用户锁，停止编辑 3 秒释放；用户锁 60 秒无心跳失效。
- Agent 改图必须：

```bash
flowctl lock <file> --wait 30
```

  编辑文件后：

```bash
flowctl unlock <file>
```

  `lock` 被用户持有时等待至超时，失败退出码 2；`unlock` 先校验 XML，损坏时不释放锁。Agent 锁 10 分钟失效。
- Agent 持锁期间 App 转只读遮罩；释放后自动合并磁盘最新内容，不需要重新打开。
- 其他命令：`flowctl status <file>`、`flowctl stats <file|dir>...`、`flowctl nodes <file> [--status review]`、`flowctl new <dir> <name>`。

## 历史

每次写盘（用户保存、Agent unlock、外部改动、扫描）内容变化即记一条快照，同内容不重复。历史面板勾选两个快照对比：按节点 id 列出新增、删除、文字变化、状态变化（如 黄 → 绿）；可只读查看旧版或回滚（回滚本身也是一条快照）。

## 开发

```bash
cd src-tauri && cargo test --lib                         # 单元测试
python scripts/dev_server.py --samples tests/samples     # 浏览器预览（注入 Tauri 模拟层）
```

## 变更记录

2026-10-30 | 0.1.0 | 首版：APP 汇总与颜色统计、draw.io 内嵌实时编辑、用户/Agent 加锁、SQLite 历史快照与对比、flowctl CLI
