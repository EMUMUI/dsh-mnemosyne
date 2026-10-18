# Mnemosyne · 给 DSH 装上人脑式长期记忆

> 一个 DeepSeek Harness 插件：会学习、会遗忘、会筛选，还会随着使用慢慢调成适合你的样子。

[English](./README.md)

大多数"记忆"插件只是一个带 save 按钮的向量库。Mnemosyne 复刻的是让人类记忆真正好用的四件事，以及把它们串成一个闭环的机制：

| 人脑能力 | Mnemosyne 的做法 |
| --- | --- |
| **记忆** | 每轮对话结束后自动学习（偏好、事实、决定、教训、可复用的成功命令），落盘到一个原子写入的 JSON 文件，重启不丢。 |
| **学习** | 你反复说过的偏好会沉淀成"按主题归档"的用户画像：重述=加固，改口=用新的替代旧的，而不是堆一堆互相矛盾的话。 |
| **遗忘** | 艾宾浩斯式指数衰减，越重要、被回想越多的事忘得越慢；"睡眠"周期把旧对话压缩成摘要；强度低于阈值的记忆会被遗忘（占位消失、记录保留、可恢复），而不是被删掉。 |
| **筛选** | 每轮开始前注入一小块工作记忆：长期偏好 + 此刻真正相关的几条记忆 + 最近脉络。刚刚注入过的记忆会被"习惯化"压制，不会每轮都来烦你。 |
| **自我升级** | 每轮注入后判断你是接受还是纠正，据此在硬边界内调整召回阈值、半衰期和注入量。用得越久，越合拍。 |

## 安装

Mnemosyne 是一个 DSH **bundle**：安装后会在该 profile 的配置里插入一行，所有会话自动生效。

```bash
# 从本地目录安装
dsh plugin --profile web add file:/绝对路径/dsh-mnemosyne

# 或直接从 GitHub 安装
dsh plugin --profile web add github:EMUMUI/dsh-mnemosyne
```

装完重启 DSH（或重载应用）。无其他服务依赖、零运行时依赖，Node 22.19+ / 24+ 均可。

确认它活着：

```
mnemosyne_stats       # 计数、文件路径、当前调参
mnemosyne_health      # 它有多懂你？下一步会调整什么？
```

## 会话里长什么样

每轮的第一步之前（且只在有内容可说时），会追加一条 user 角色的消息：

```
[M]
【Mnemosyne 长期记忆 · plugin:mnemosyne】
以下是你对这个用户的长期记忆（由 Mnemosyne 自动维护）。它不是用户本次说的话；
与当前任务无关时请忽略，不要向用户复述本段，也不要说"根据我的记忆"。
若记忆与用户当前要求冲突，以当前要求为准，并可用 mnemosyne_remember 更新记忆。

【长期偏好 · 用户明确设定，优先遵守】
- [sema-0688e679] 以后所有回复都用中文，简洁一点。

【相关记忆 · 可能相关，仅供参考】
- [epis-508748b8] 部署脚本在 scripts/deploy.ps1，服务器是 Windows。

【最近对话脉络】
- [recent-1767225600000] 安装依赖，然后跑一下构建。
```

它是一条真实入库的消息，`source.kind = 'plugin:mnemosyne'`，会话日志里看得到，GUI 会标注来源是插件——永远不会被误认为是你说的话。长度受 `workingSetMaxChars` 约束。

系统提示里还会加一小节，告诉模型**怎么用**记忆：当前要求优先于记忆；听到长期偏好就调 `mnemosyne_remember`；被问到以前的事先 `mnemosyne_recall`；绝不存密钥。

## 工具

| 工具 | 作用 |
| --- | --- |
| `mnemosyne_remember` | 存一条偏好 / 事实 / 决定 / 教训 / 命令。同主题自动替代，近义自动加固。 |
| `mnemosyne_recall` | 按语义检索；`includeForgotten: true` 可以挖出已经淡忘的记忆。 |
| `mnemosyne_profile` | 关于你的长期画像：硬性偏好、固定事实、契合度。 |
| `mnemosyne_update` | 按 id 改写 / 固定 / 调权重 / 遗忘 / 丢弃 / 恢复。 |
| `mnemosyne_forget` | 遗忘（可恢复）或彻底丢弃——按 id 或按查询。 |
| `mnemosyne_consolidate` | 立刻跑一次"睡眠"整理；`preview: true` 只预览。 |
| `mnemosyne_health` | 契合度、薄弱环节、自我调参下一步会怎么走。 |
| `mnemosyne_sessions` | 学习日志里的近期活动。 |
| `mnemosyne_commands` | 从成功的 shell 调用里学到的命令模式。 |
| `mnemosyne_stats` | 计数、文件路径、当前调参。 |

```jsonc
// 例子：教它一条长期规则
{ "content": "所有代码注释用英文，但我看的文档请用中文", "kind": "preference" }
```

## 记忆模型简述

- **强度**随每次有效回想增长，边际递减（`增益 / (1 + 0.6·回想次数)`）且有上限，避免某条记忆永远霸榜。
- **衰减**是指数的。有效半衰期 = `halfLifeDays × (1 + 2·重要性) × 1.55^log2(强度+1)`：重要的事和反复遇见过的事更难忘（间隔效应）。
- **遗忘**发生在衰减后强度低于 `salienceFloor` 时；被 pin 的记忆豁免。被遗忘的记忆退出活跃区但保留 `keepForgottenDays` 天，显式召回仍能捞回来。
- **整合**（"睡眠"周期）把待处理的对话压缩成摘要记忆，跑一遍衰减，并执行容量上限。
- **筛选**按 相关性 0.55 + 重要性 0.25 + 强度 0.2 排序，对刚注入过的记忆施加习惯化惩罚。
- **自我调参**根据"被接受 / 被纠正"的比例，在硬边界内移动 `recallThreshold`、`halfLifeDays`、`salienceFloor`、`reinforceGainMul`、`learnedInject`。每次调整都会记录触发它的观测数据。

## 配置

所有选项都在 [`cordis.patch.yml`](./cordis.patch.yml) 里注释好了，默认值开箱即用。最常改的几个：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `autoLearn` | `true` | 是否自动从对话里学习。 |
| `halfLifeDays` | `21` | 基础半衰期；`0` 表示永不遗忘。 |
| `workingSetMaxChars` | `2200` | 注入预算。 |
| `privacyMode` | `'excerpt'` | `'excerpt'` \| `'excerpt-free'` \| `'full'`。 |
| `redactSecrets` | `true` | 入库前抹掉凭据。 |
| `perProjectPreferences` | `false` | 偏好是否按仓库隔离。 |
| `memoryFile` | `~/.dsh/mnemosyne/<profile>.json` | 记忆文件位置。 |

## 隐私

- 默认**永不**原样保存你说的话，只保存脱敏后的短摘录。
- 凭据（`ghp_…`、`github_pat_…`、`sk-…`、AWS key、JWT、`api-key`/`password` 赋值、私钥块）在存储边界统一抹除，任何写入路径都绕不过去。
- 全部内容就是本地一个 `0600` 权限的文件。删掉它，记忆就没了。

## 开发

```bash
node --test "tests/**/*.test.js"   # 48 个单元测试，零依赖
node scripts/demo.mjs              # 生动演示三个月的记忆演化
```

```
index.js            插件入口：配置、brain、host、工具、提示词小节
lib/host.js         会话观测、轮次生命周期、注入、反馈闭环
lib/render.js       注入块 / 系统提示小节 / 状态行
lib/writer.js       每个记忆文件一个写入者（热重载、重复挂载安全）
src/brain.js        工具、钩子、测试共用的高层操作
src/tools.js        十个工具定义
src/config.js       默认值、校验、路径解析
src/core/           text / decay / store / patterns / learn / recall / self
vendor/             本地精简版 `defineTool`（树外插件无法 import @deepseek-ai/dsh-tools）
```

## 许可证

MIT © EMUMUI
