# @local/dsh-auto-review-zh

> **English**: A Host-only DeepSeek Harness plugin that makes the experimental **Auto review** permission preset report in Simplified Chinese — the consent prompt shown when it asks whether to allow a denied tool call, and the reviewer's own deny reason.

让实验性的「自动审查」（Auto review）权限档在向用户征求同意时一律显示中文。

## 解决什么

`@deepseek-ai/dsh-experimental-auto-review` 会在每次受支持工具调用前做一次模型审查；在 `ask` 审批策略下，被拒绝的调用会交给用户决定。该提示有两处英文：

1. 固定提示文案是 `displayReason` 的 en/zh 双语文案，按**当前界面语言**解析，因此英文界面显示英文；
2. 可选的 reviewer `reason` 由一次模型调用产生，其固定 `REVIEW_POLICY` 系统提示是英文，因此中文界面下理由仍是英文。

## 怎么做

Host-only 插件，注册两个置前（`prepend`）瀑布监听器，除此之外不改动任何审批请求或模型调用：

- `approval/request`：命中自动审查询问时，把 `displayReason` 的 en/zh 槽位都改写为中文（理由保留），因此无论界面语言，询问文案都是中文；
- `llm/stream`：命中 reviewer 调用（`system` 以 `REVIEW_POLICY` 开头）时，用**同一请求 + 一条语言要求**重新发起该调用，让拒绝理由用简体中文书写。

**为什么不是原地追加**：出厂实现在 `classifyRisk` 里用 `deepFreeze({ ... system: REVIEW_POLICY ... })` 构造请求（`lib/index.js:400-414`），`deepFreeze` 会冻结根对象本身（`dsh-util-values` 的 `Object.freeze(node)`）；瀑布监听器也无法替换默认 `next` 闭包引用的那个对象。因此本插件改为**替换这次调用**：新建请求对象（原字段原样保留，含 `signal`，取消仍可传播）并通过同一 `llm` 服务再派发一次。这次再派发会回到本监听器，此时要求已在 `system` 中，于是 `next()` 继续，retry、stream invariant、routing 等下游监听器仍各运行一次，真正的模型请求也只有一次。已在 profile 里的 `@local/dsh-go-session-context` 同样会为这个被冻结的 reviewer 请求重新派发（`{...options, temperature: 1}`），两者叠加后 `temperature=1`、语言要求恰好一次、适配器只派发一次。

两个监听器对不属于自己的请求一律 `return next()`；自身异常被吞掉并记 warning，且回退到出厂调用，绝不会让审批或模型调用失败。审计理由 `reason` 不改写，会话日志保持原样。替换出来的请求会被 `Object.freeze`（它的字段都来自已冻结的原始请求），保持出厂的“输入不可变”契约；每个原始请求对象最多替换 3 次（`MAX_REPLACEMENTS`），既让同一信封被再次派发时仍然生效，又杜绝病态再派发导致的递归。

## 配置

`cordis.patch.yml` 的行配置（两个开关默认 `true`）：

```yaml
- insert:
    - id: auto-review-zh
      name: '@local/dsh-auto-review-zh'
      config:
        promptChinese: true    # 询问用户是否同意时显示中文
        reviewerChinese: true  # 让评审模型用中文写理由
```

## 安装与验证

```powershell
git clone https://github.com/XavierMarquis93/dsh-plugin-auto-review-zh.git
```

然后用 `plugin_manager` 的 `install_bundle` 指向该目录（不要在 profile 目录手写 `package.json` 或跑 pnpm）。离线验证：

```powershell
node test/verify.mjs   # 或 npm test
```

60 项检查覆盖：开关解析、询问文案与理由提取、两个监听器的注册与顺序（含"后续转发者看到的是改写后的文案"）、**与出厂一致的冻结请求**下替换请求的完整字段/信号/一次性再派发、下游监听器仍各跑一次、无 llm 服务或服务抛错时回退、非自动审查请求不被改动，以及包元数据（locale/icon/patch）。上游指纹（`REVIEW_POLICY` 前缀、`deepFreeze({`、询问理由与显示文案前缀）对照已解包的 asar 源码；路径缺失时会打印 SKIP 而不是静默通过。

## 已知限制

- 是否是中文由本插件决定，不再跟随界面语言：英文界面下该提示同样是中文（这正是"必须显示中文"的要求）。
- reviewer 的语言要求是提示词层面的约束，模型理论上仍可能返回英文理由；此时固定文案仍是中文，理由原样附在后面。
- 只有“手工 `llm.stream(options)`”的调用会被识别并替换；若某个调用方走 `prepareCall().stream()`（绑定适配器代次的预准备路径），替换会退化为一次未预准备的分发。出厂的 reviewer 调用不走这条路径（`auto-review:414` 是普通 `stream`），因此对本插件无影响。
- 修改插件代码后需要重启 DSH 才会加载新模块（运行中的进程仍是安装时加载的那一代 JS）。
- 端到端效果（真实触发一次自动审查拒绝并看到提示）需要在重启后由实际审批交互确认；离线验证不能代替它。

## 兼容性

- 针对 DSH `0.2.1-rc.2` 的 `@deepseek-ai/dsh-experimental-auto-review`、`@deepseek-ai/dsh-user-approval`、`@deepseek-ai/dsh-llm` 行为编写。上游若改动审查询问文案或 reviewer 调用方式，需要同步；`test/verify.mjs` 的上游指纹检查会在本机存在 `.recon` 解包源码时报警（无该目录时显示 SKIP）。
- 已在 Windows 11 + DSH 桌面端实测：真实拒绝 → 中文审批条 → 用户拒绝，审查理由为中文，审批结果正确落盘。
- Host-only：没有 UI 代码、没有运行时依赖、不修改任何会话事件或审计理由。
