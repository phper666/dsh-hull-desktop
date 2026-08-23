# S2 skills 操作 实现记录（评审修复波）

> 判级：复杂+安全敏感（renderer 不可信边界：路径白名单/单飞互斥/staging 原子替换，Q-038）
> 事实源：契约 `docs/api/feishu-s2-skills-api-contract.md`、设计 §4.1/§4.2/D2-D5
> 本记录覆盖：oracle review 7 项修复（2🔴+5🟡）+ 4 项⚪低危登记。全程 TDD（先测后修）。

## 修复清单（7/7 完成）

| # | 级别 | 问题 | 修复 | 回归测试 |
|---|---|---|---|---|
| 🔴1 | HIGH | `restoreFromTrash` 绕过单飞锁 + trash.json parser 不可信未校验 originalPath | `SkillsOps.restoreFromTrash`：先 `trash.findEntry` 映射 trashId→originalPath → `isWithinRoots` 白名单校验 → `guard(originalPath)` 单飞锁（finally release）→ 再 restore | SkillsOps.test.ts ×2：restore 进行中同路径再 restore → `skills-op-in-progress`；originalPath=/etc/evil → `validation-error` |
| 🔴2 | HIGH | `parseGithubSource` subPath 捕获 `..` 段，join(repoDest) 逃逸 staging（恶意 SKILL.md metadata.source） | ① subPath 段白名单：含 ``..``/`.`/空段 → `SkillValidationError`（clone 不发起）；② 纵深防御：realpath(payload) 必须落于 realpath(repoDest) 域内 | UpgradeExecutor.test.ts：`…/tree/main/../../evil` → validation-error 且 cloneCalled=false |
| 🟡3 | MED | computeDirHash/computeSize 跟随目录 symlink → 循环内无限递归悬挂 | hash.ts walk：lstat 判定 symlink 一律跳过不跟随；TrashManager.computeSize 同样 lstat+skip | hash.test.ts + TrashManager.test.ts 各 1：循环目录终止不悬挂 |
| 🟡4 | MED | symlink 路径升级 rename 别名→独立副本（SSOT 留旧内容，下次扫描重复） | 门面 upgrade 守卫链加 `pathInfo.isSymlink` → `validation-error` 拒绝（symlink skill 经 SSOT 原路径升级）；disable 已有 lstat 分发保持 SSOT | SkillsOps.test.ts：symlink 升级拒绝且链接与 SSOT 完好 |
| 🟡5 | MED | 回滚自身失败被外层 catch 包装成 `rolledBack=true`（虚报已回滚） | 内层回滚 rename try/catch → `SkillsIoError`(skills-io-error)+手动处理提示+manifest 条目保留供自愈；**外层 catch 补 SkillsIoError 直通重抛**（否则仍被包装——实现期发现并修复） | UpgradeExecutor.test.ts：mock 双 rename 失败 → skills-io-error、原路径空缺、manifest 留 1 条、selfHeal 还原成功 |
| 🟡6 | MED | 实目录 disable 用 renameSync，跨卷 EXDEV 报原始错误 | 改用 `moveSync`（EXDEV → copy+verify+delete 降级）；SkillFsOps.moveSync 类型放宽 `void \| Promise<void>`（测试门控需要） | DisableManager.test.ts：mock EXDEV → 降级 copy+delete，禁用成功 |
| 🟡7 | MED | 升级成功后 lock 未 bump + loadLock 进程内缓存 → 重扫永远 upgradable 无限提示 | Scanner 增加 `applyRemoteHashOverride(name, hash)`（hashOverrides Map 参与远端哈希推导）；门面 upgrade 成功后回写 newHash → 重扫收敛 latest | SkillsOps.test.ts：升级→重扫 upgradable=latest |

## 验证结果

- `npx tsc --noEmit`：0 错误
- `npm run test:unit`：**573/573 pass**（基线 564 + 新增 9 项评审回归）
- e2e 未动（纯主进程逻辑，单元级已覆盖，无廉价 e2e 增量）

### 实现期额外发现并修复

- 🔴1 单飞测试初版按 `to` 匹配 trash 门控 moveSync——误捕 remove 的入 trash 搬移造成死锁；改为按 `from`（out-of-trash）匹配，仅门控 restore 搬移
- 🟡5 测试初版缺 gitClone runner 走真实网络 clone 必败；补 fake cloner + rename mock 区分「②新版就位失败」与「回滚失败」（`.backup$` from 判定）

## ⚪ 低危登记（本轮不修）

1. **UpgradeExecutor.selfHeal 清空 manifest 连带 skipped 条目**：「原路径占用」的 backup 残留条目被一并 wipe，下次启动不再尝试自愈（backup 目录仍在盘上）。改进：仅移除已还原条目，skipped 保留重试。影响小（有 warn 日志留痕），登记待后续。
2. **TrashManager.moveToTrash 索引写在 move 之后**：move 成功与 saveIndex 之间崩溃 → 盘上有孤儿 trash 目录但索引无条目（不可恢复入口）。TTL 惰性清理只删索引已知条目，孤儿目录永久残留占空间。概率极低（本地单进程窗口毫秒级），note only。
3. **src/main/index.ts 无生产 npxUpdate runner 注入**：生产环境 upgrade 只走 git-staging 分级（npxUpdate 仅测试注入）。O-2（`npx skills update` 单路径语义）待实测后决定接线，intentional deferral。
4. **OperationLog lastIndexOf('/') mkdir 不兼容 Windows**：日志目录创建用字符串 lastIndexOf('/') 截断，Windows 反斜杠路径会 mkdir 失败。项目 darwin-only（CON-R001 壳随 dsh macOS），fine as-is。

## 文件变更

- src/skills/SkillFsOps.ts — moveSync 签名放宽（Promise 门控）
- src/skills/hash.ts — walk lstat+symlink skip（🟡3）
- src/skills/SkillsScanner.ts — applyRemoteHashOverride + hashOverrides 推导（🟡7）
- src/skills/ops/SkillsOps.ts — restoreFromTrash 锁+白名单（🔴1）、upgrade symlink 拒绝（🟡4）、升级后哈希回写（🟡7）
- src/skills/ops/UpgradeExecutor.ts — subPath 白名单+realpath 域校验（🔴2）、回滚失败 SkillsIoError+外层直通（🟡5）
- src/skills/ops/DisableManager.ts — disable 实目录 moveSync（🟡6）
- src/skills/ops/TrashManager.ts — computeSize lstat skip（🟡3）、findEntry 导出、move await
- 测试：SkillsOps/UpgradeExecutor/DisableManager/TrashManager/hash 五个 .test.ts 共 +9 用例

## 核验记录

- Semgrep p/default 210 rules × 32 files（src/skills + main + preload）：0 findings（2026-08-23 交付核验补扫）
