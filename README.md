# magpie-federation

把远端 Magpie 的各家供应商分别接入本机的原生供应商列表，保留服务器、供应商和模型的归属。MCP 接入资源库，可以整台服务器接入，也可以按远端 MCP 的工具命名空间拆开。

例如远端 `netcup` 同时配置了 `codex` 和 `deepseek`，本机将看到两个独立供应商。

```text
供应商
  Codex · netcup
    codex/gpt-5
    codex/gpt-5-mini
  DeepSeek · netcup
    deepseek/deepseek-chat
  路由组 · netcup
    group/smart

资源库 / MCP
  mf-netcup-mcp-<hash>          # 整台接入
  或
  mf-netcup-mcp-docs-<hash>     # 按命名空间接入
  mf-netcup-mcp-github-<hash>
```

每个供应商使用 Magpie 原生的供应商行和编辑页，展开后查看自己的模型。折叠是原生界面的查看状态，所有已导入模型都可以正常调用。模型名字也带远端供应商 id 和服务器 id，同名模型可以区分来源。路由组使用独立的来源入口，仍由远端执行路由。

包内的命令发现远端目录，为各家供应商生成独立的 Magpie 插件钩子，并通过 `magpie plugin add` 注册。钩子使用宿主的账号接口启用受管理的本机连接。本机供应商 id 的形式是 `mf-<server>-<provider>-<hash>`，模型 API id 保留远端的 `<provider>/<model>`。插件通过远端网关调用。

## 连接服务器

需要 Bun 和 Magpie。当前开发验证使用 Magpie 0.1.3302。

从仓库运行。

```sh
bun install
export NETCUP_MAGPIE_KEY='远端 Magpie 的网关密钥'
bun run connect netcup url=https://magpie.example.com keyEnv=NETCUP_MAGPIE_KEY name=netcup
```

安装包提供 `magpie-federation` 命令，对应的调用方式如下。

```sh
magpie-federation connect netcup url=https://magpie.example.com keyEnv=NETCUP_MAGPIE_KEY
magpie-federation sync
```

`connect` 保存这台服务器并同步目录。`sync` 重新发现配置中的所有服务器，生成各家供应商的入口。注册过程中失败可以再次运行 `sync`，继续完成已经记录的操作。

可选参数如下。

| 参数 | 行为 |
| --- | --- |
| `name=netcup` | 服务器的显示名称，默认使用服务器 id |
| `providers=codex,deepseek,group` | 只导入这些远端供应商，省略时导入目录中的所有来源 |
| `mcp=hub` | 默认值，将远端 MCP hub 接入一个资源库条目 |
| `mcp=servers` | 按远端 hub 暴露的工具命名空间分别接入资源库 |
| `mcp=off` | 只接入模型供应商 |

远端通过 `/v1` 的 `mcp_hub` 声明 MCP 能力。没有开启 hub 的服务器可以正常导入模型供应商。MCP 首次接入时不分配 Agent，在 Magpie 资源库里选择使用它的 Agent，并使用原生工具开关。

`mcp=servers` 使用远端工具名 `<namespace>__<tool>` 中第一个 `__` 之前的部分分组。它保留远端暴露的命名空间和工具名。命名空间含有 `__` 或被远端截短时，可用 `mcp=hub` 保留完整 hub。

## 配置

配置文件为 `$XDG_CONFIG_HOME/magpie-federation/config.json`，默认路径是 `~/.config/magpie-federation/config.json`。可用 `MAGPIE_FEDERATION_CONFIG` 指定其他文件。

```json
{
  "port": 3487,
  "servers": [
    {
      "id": "netcup",
      "name": "netcup",
      "url": "https://magpie.example.com",
      "keyEnv": "NETCUP_MAGPIE_KEY",
      "mcp": "hub"
    }
  ]
}
```

`keyEnv` 从插件宿主的环境读取。图形界面启动的 Magpie 需要继承这个环境变量。也可以在权限为 `600` 的配置文件中使用 `key` 字段保存网关密钥。命令生成配置和插件文件时使用 `600` 权限，MCP 本机连接令牌由命令随机生成。

公网地址使用 HTTPS。HTTP 只接受回环、内网和 Tailscale 地址。远端请求拒绝重定向，避免把网关密钥带到其他地址。

模型目录保留远端报告的上下文长度、输出上限、输入输出模态、推理档位、服务档位和价格。对话请求按模型的 `native_endpoints` 选择 Chat Completions、Responses 或 Anthropic Messages，并保持响应流、会话标识及远端模型 id。实际供应商账号仍由远端选择。

MCP 使用只监听 `127.0.0.1` 的转发服务，随 Magpie 插件宿主运行。资源库条目用随机令牌连接这个服务，远端网关密钥由服务读取。按命名空间接入时，工具列表及调用都限制在对应命名空间。

## 升级已有配置

配置解析器接受旧版的 `remotes` 数组，可将原配置复制到新配置路径后执行 `sync`。旧版的观测、账号别名和 peer 写入配置不参与新的供应商接入。

使用新入口替代已有的 Remote magpie 时，先为 Agent 选择新导入的具体供应商和模型，再从 Magpie 移除旧入口。本插件通过独立的供应商 id 接入，内置 `remote-magpie` preset 的实现由 Magpie 管理。

生成的连接插件引用当前安装目录。移动仓库或升级安装路径后，重新执行 `sync` 更新引用。

## 开发验证

```sh
bun run typecheck
bun test
bun run e2e
```

端到端检查创建两套独立的 `HOME` 和 `XDG_*` 目录，关闭沙箱自动更新，启动两台真实 Magpie，并使用本机已有的 Bun。两台上游供应商提供同名模型，用于验证导入后身份各自独立、调用到达相应供应商。另有两个测试 MCP，用于验证分组目录和实际工具调用。检查结束后关闭沙箱进程。

历史路由观测代码保留在源码中供参考。发布文件由 `package.json` 的 `files` 指定，插件入口和包清单仅接入供应商及 MCP。
