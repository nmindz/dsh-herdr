# dsh-herdr

DeepSeek Harness 的 Herdr 状态集成插件。插件运行在 DSH TUI 进程内部，把该进程中的 root agent 与子 agent 聚合成当前 Herdr pane 的语义状态。

## 状态映射

| DSH 进程状态 | Herdr 状态 |
| --- | --- |
| 任一 agent 有未处理审批 | `blocked` |
| 无待审批，任一 agent 正在运行 | `working` |
| 存在 agent，且全部空闲 | `idle` |
| 最后一个 agent 已销毁或插件卸载 | `release-agent` |

插件监听 `agent/created`、`agent/status`、`agent/disposed` 和 `session/event`。恢复已有会话时会折叠历史中的 `approval/asked` / `approval/decided`，避免重启后丢失待审批状态。

## 前置要求

- DeepSeek Harness `0.1.0-rc.6`
- Node.js `22.19+` 或 `24+`
- Herdr 管理的 pane（进程环境包含 `HERDR_ENV=1` 与 `HERDR_PANE_ID`）

插件优先调用 `HERDR_BIN_PATH` 指定的 Herdr 可执行文件；未运行在 Herdr pane 内时自动禁用，不影响 DSH。

## 本地构建与安装

```sh
npm install
npm run check
npm pack --ignore-scripts
dsh plugin --profile tui add ./lbryany-dsh-herdr-0.1.0.tgz
dsh --profile tui
```

如果 TUI profile 使用其他名字，请替换命令中的 `tui`。

发布到 GitHub 后可直接安装：

```sh
dsh plugin --profile tui add github:Lbryany/dsh-herdr
```

## 验证

在 Herdr pane 内启动 DSH TUI，然后从另一个 pane 查看：

```sh
herdr agent list
```

DSH 开始处理消息时应显示 `working`，等待工具审批时显示 `blocked`，完成后显示 `idle` 或 Herdr 根据可见性派生的 `done`。

## 设计说明

- 状态报告带单调递增的 `--seq`，并串行执行，防止旧子进程覆盖新状态。
- Herdr 命令默认 3 秒超时；上报失败只记录警告，不阻塞 DSH agent。
- 多个 DSH TUI 进程分别继承自己的 `HERDR_PANE_ID`，无需跨进程协调。

## License

[MIT](./LICENSE)
