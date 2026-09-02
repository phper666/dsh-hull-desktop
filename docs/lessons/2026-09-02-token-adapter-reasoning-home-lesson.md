# Token 平台适配器经验：opencode reasoning 语义 + home 约定坑

> 日期：2026-09-02 · 项目：dsh-hull-desktop（tokens 视图 16 平台扩展）
> 三硬标准：可复用（后续加平台适配器必遇）/ 非显而易见（源码级踩坑）/ 有代价（主力平台系统性低估 900 万 token）

## 1. opencode token-history 的 reasoning 语义（最容易错）

`~/.opencode/token-history/YYYY-MM.json` 的 `byModel[model].{output, reasoning}`：
- **output 不含 reasoning**（本机实证 241/869 条 reasoning > output，如 output=2073 / reasoning=176576）
- `totals.total` = input + output（排除 cache、排除 reasoning）

**坑**：若按 anthropic 直觉「output 含 thinking、reasoning 仅分解」实现 `outputTokens=output, reasoningTokens=reasoning`，则聚合层 totalTokens（=input+output+cache）会把 reasoning 全排除 → 推理重模型（deepseek-v4-flash 等）系统性少计。

**正确映射**：`outputTokens = output + reasoning; reasoningTokens = reasoning`（与 claude/codex 语义对齐）。
⚠️ 但**不能**反向改聚合层 totalTokens 加 reasoning——codex 的 output_tokens 已含 reasoning，聚合层加会双计 codex。即：每平台适配器负责对齐「output 含 reasoning」语义，聚合层保持 `input+output+cache`。

**验证方法**：本机数据断言 `outputTokens >= reasoningTokens` 占比（修复后 1026/1026 = 100%）。

## 2. create<Platform>Source(home) 的 home 约定（集成级 bug）

**坑**：部分 adapter 把 home 参数当「数据根目录」，另一些当「父根（homedir）」——`platformSources()` 集成按 `createSource(home=homedir())` 调用时，前者递归扫**整个 ~**（cline 实测卡死），opencode 读错目录。

**约定**：统一 `create<Platform>Source(home = homedir())` = 父根，adapter 内部 `join(home, 平台子路径)`。所有平台注册表调用方一致传父根。

## 3. macOS EPERM：不能宽扫 `~/Library/Application Support`

**坑**：roo 最初 `listFiles` 宽扫整个 `~/Library/Application Support` → 递归到 TCC 保护目录（AddressBook）→ `EPERM: operation not permitted`，整个平台 listFiles 抛错 → 0 记录（有数据的平台也被吞）。

**修复**：① 收窄到已知编辑器具体 globalStorage 路径（Code/Cursor/Windsurf/Trae* 逐个 existsSync）；② 所有 walk 递归 `readdirSync` try/catch——单子目录 EPERM/ENOENT 跳过继续，不整体抛。

## 4. 平台适配器注册表模式要点（复用 checklist）

- 每平台独立文件，导出 `parse*` + `create<Platform>Source(home?)`（统一父根约定）
- SQLite 只读：`node:sqlite DatabaseSync(readOnly:true)`，**只 SELECT 所需列**（不拉正文/内容列——隐私红线 + 大库性能），表名单白名单（不扫全库）
- 防御式：表/列缺失 → 返回 [] / 0，不抛；单源失败隔离（listFiles/parse 失败只记 error，不影响他源）
- `num()` 用 `Number(v)` 转换（接受数字字符串），不要 `typeof === 'number'` 严格校验（未知 schema 平台可能存字符串）
