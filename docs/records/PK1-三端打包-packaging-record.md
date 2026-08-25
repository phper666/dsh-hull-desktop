# packaging 三端打包实现记录

> 关联：设计 docs/design/PK1-三端打包-packaging-design.md · 共识 v1.1（docs/spec/共识-Hull桌面壳-三端打包.md）
> 子需求：PK1（electron-builder 配置+打包）/ PK2（捆绑 node）/ PK3（自动更新+平台适配）

## 判级

- 复杂（跨平台构建/分发/捆绑 node/更新）→ 技术方案 + 完整实现纪律

## 实现清单

| 文件 | 变更 | 归属 |
|:-----|:-----|:-----|
| electron-builder.yml | 三平台 target（mac dmg+zip / win nsis+portable / linux AppImage+deb）+ per-platform extraResources 捆绑 node + publish GitHub provider + mac.identity null | PK1/PK3 |
| package.json | electron-builder devDep + pack/pack:mac/win/linux 脚本 + repository 字段 | PK1/PK3 |
| scripts/fetch-node.mjs | 平台参数化（darwin/win zip/linux tar.xz + SHASUMS 校验 + 版本文件） | PK2 |
| src/overlay/extractNode.ts（新） | 从包 resources/node 解压到 userData（win node.exe/linux bin/node 分支 + 幂等） | PK2 |
| src/main/index.ts | InstallFlow 注入 extractBundledNode(process.resourcesPath)；adapter owner 修正 phper666 | PK2/PK3 |

## 实现 vs 方案偏离

| 方案 | 实现 | 处理 |
|:-----|:-----|:-----|
| §2 决策 3 node 放 resources | 实现用 electron-builder extraResources per-platform 映射（`${os}` 命名差异 mac/win/linux 与 node.org darwin/win32 不同，显式分平台写） | 实现细化 |
| §4.4 publish 源 | 方案 generic；用户拍板 A（GitHub Releases）→ 实现改 GitHub provider | 用户决策 |
| mac.identity | 方案未明；实现设 null（不签名 CON-R-packaging-005） | 实现补齐 |

## 验证

| 项 | 结果 |
|:---|:-----|
| unit | 645/645 绿（640 既有 + 5 extractNode 新增） |
| integration | 8/8 绿 |
| mac 打包 | ✅ dmg（167M）+ zip（170M）+ node 捆绑 + latest-mac.yml 生成 |
| fetch-node darwin 回归 | ✅ 下载+SHA256+解压+版本文件 |
| typecheck | tsc --noEmit 无错 |

## 关键决策

- **electron-builder 三平台 target**（mac dmg+zip / win nsis+portable / linux AppImage+deb）
- **三端捆绑 node**（fetch-node 参数化 + extraResources + extractNode 解压）
- **自动更新 GitHub Releases**（用户拍板 A；adapter 修正 phper666/dsh-hull-desktop）
- **暂不签名**（mac.identity null，CON-R-packaging-005）

## 遗留/待拍板

- **publish url 占位已替换**：GitHub Releases 发布需首次 `gh release create` 或 electron-builder --publish；发布动作未做（用户手动发布时执行）
- **Win/Linux 实测**：配置 + fetch-node 分支代码就绪（CON-R-packaging-007），需对应平台打包实测（本机仅验证 mac + fetch-node darwin 回归）
- **author 字段缺失**：electron-builder 告警非阻断，可后续补
- 三端平台适配检查：代码平台无关（electron 抽象），托盘/路径无 darwin/win32/linux 分支需改
