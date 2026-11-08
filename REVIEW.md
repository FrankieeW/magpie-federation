# Code Review 报告 · magpie-route-inspector

- **日期**：2026-11-08
- **范围**：全部 15 个文件（lib/ 3、ui/ 3、page/ 2、scripts/ 1、test/ 1、根配置 3）
- **测试**：`bun test` — **5 通过 / 0 失败，59 断言**（Bun 1.3.14）
- **总体评价**：⭐⭐⭐⭐½ 代码质量整体很高。安全设计（token、Host 校验、凭据脱敏、DNS rebinding 防护、CSP）明显经过深思熟虑，错误状态机（forbidden/offline/incompatible/error）贯穿前后端，UI 对"未知"信息的诚实标注非常出色。以下是发现的问题，按严重程度排列。

---

## 🔴 需要修复

### R1. `page/boot.js` 传入的 `theme` 参数从未被 `ui/` 消费
- **位置**：[page/boot.js:34](page/boot.js#L34) 设置 `target.searchParams.set('theme', ...)`，但 [ui/app.js](ui/app.js) 与 [ui/index.html](ui/index.html) 从未读取 URL 中的 `theme` 参数。主题切换仅靠 `data-theme`（跟随系统/手动），插件宿主传递的深浅色偏好被静默丢弃。
- **建议**：在 `app.js` 初始化时读取 `new URLSearchParams(location.search).get('theme')`，映射为 `data-theme` 并同步 `themeIndex`；或从 boot.js 移除该参数。

### R2. `boot.js` 的 6 秒失败定时器无法取消
- **位置**：[page/boot.js:35](page/boot.js#L35)。`setTimeout(() => fail('插件服务未响应…'), 6000)` 在 `location.replace()` 后不会清理。若跳转被浏览器阻止或延迟，用户会看到误导性的错误信息叠加在正常流程上。
- **建议**：保存 timer id，在页面卸载（`pagehide`）时 `clearTimeout`；或改用 `location.replace` 的返回后检查。

---

## 🟡 建议改进

### Y1. README 缺少配置文件格式的任何说明
- [README.md](README.md) 是目标文档，但服务端配置文件 `~/.config/magpie-route-inspector/config.json` 的 schema（`remotes[].id/name/url/key/keyEnv/accountAliases`）只存在于 [lib/config.mjs](lib/config.mjs) 的校验逻辑里。用户不读源码无法知道如何配置远端——而这是使用本插件的第一步。
- **建议**：README 增加"配置"一节，给出最小示例和环境变量引用方式。

### Y2. `config.mjs` 与 `remote.mjs` 的边界分支缺乏测试
- 现有测试 ([test/backend.test.mjs](test/backend.test.mjs)) 覆盖了主路径与关键安全行为，但未覆盖：`keyEnv` 解析、`url` 携带凭据/查询/非 `/v1` 路径的拒绝、配置 >1 MiB、远端响应 >8 MiB、非 JSON 响应、超时路径、`route: null` 会话（README 验收标准 4 的一半）。
- **建议**：`parseConfig` 是纯函数，补一组表驱动的单元测试成本很低、收益高。

### Y3. `index.mjs` 单例忽略后续调用的 `options`
- [index.mjs:8-14](index.mjs#L8-L14)：`server()` 首次调用后缓存 promise，若 Magpie 以不同 `options.port` 再次调用（如用户改插件设置），旧的 port 会继续生效且新参数被静默忽略。
- **建议**：至少在 options 变化时重启服务，或记录警告。

### Y4. `boot.js` 对 `magpie.service` 为对象类型的处理
- [page/boot.js:25](page/boot.js#L25) 只处理 `service` 为字符串的情况；若宿主提供对象形式的 service 描述（未来版本可能），会走 `else` 分支做 hostname 判断，行为语义不明确。
- **建议**：对非字符串且非空值给出显式错误。

### Y5. `Vary: Origin` 仅在 `origin === "null"` 时设置
- [lib/server.mjs:27](lib/server.mjs#L27)。对于携带其他 Origin 的请求，响应未声明对 Origin 的依赖，理论上可能被中间缓存误用。因为所有响应均为 `no-store`，实际风险极低，但把 `vary` 移到无条件设置更严谨。

### Y6. 仓库尚未 `git init`
- 当前目录不是 Git 仓库，无法追踪演进历史。README 中引用的 issue（#2114/#2110/#1192/#2347）驱动的工作流建议尽早建立版本控制。

---

## 🟢 值得肯定的亮点

| 方面 | 说明 |
| --- | --- |
| **安全设计** | 随机 32 字节 token + `timingSafeEqual` 比较（[server.mjs:11-16](lib/server.mjs#L11-L16)）；Host 白名单阻断 DNS rebinding（[server.mjs:62-65](lib/server.mjs#L62-L65)）；`redirect: "manual"` 防重定向泄漏（[remote.mjs:78](lib/remote.mjs#L78)，测试用 sink 验证未泄漏）；CSP `default-src 'none'` 起步 |
| **凭据脱敏** | [remote.mjs:7-15](lib/remote.mjs#L7-L15) 多层替换：API key、账号→别名、邮箱、Bearer；测试断言 secret/account 均不出现在响应体 |
| **费用语义诚实** | 区分 unknown / known-zero / estimated，并注释了 Go 侧 JSON 字段遮蔽导致归因不可恢复的根因（[remote.mjs:49-51](lib/remote.mjs#L49-L51)），UI 明示"不去重、不求和" |
| **健壮的轮询** | 指数退避 + 快速空响应节流（[app.js:362-369](ui/app.js#L362-L369)）；seq 回退计数提示远端重启；pagehide/pageshow 正确暂停恢复（bfcache 感知） |
| **XSS 防护** | UI 全部使用 `textContent` 构造节点，无任何 `innerHTML`；token 为纯 hex 安全嵌入属性 |
| **状态机一致性** | forbidden/offline/incompatible/error 四态在服务端错误、远端 HTTP 状态码、前端 UI 标签三处一一对应 |
| **配置热恢复** | 配置损坏返回 503 且不崩溃，修复后自动恢复（有测试覆盖） |

---

## 结论

当前实现与 README 中 P0 目标一致且质量良好，可在补上 R1/R2 后作为可用版本。Y1（配置文档）是发布前最影响可用性的一项。建议下一步：修复 R1/R2 → 补 README 配置节 → `git init` 并提交基线。
