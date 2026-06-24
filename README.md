# yo-agent

一个自研的**通用 agent 引擎**（TypeScript / Node 单栈）。

一句话定位：一个 agent 内核（agent loop + 工具调用 + 上下文管理 + MCP），
**既能当编程 agent**（读写代码、跑命令、diff 审批，对标 Claude Code / Codex / opencode），
**又能挂接聊天平台**（QQ / Telegram / Discord 等，对标 AstrBot / nanobot / openclaw）。

> 与 [`yo-aichat`](../yo-aichat) 的关系：yo-aichat 是 BYOK 对话 + 远程操控第三方 CLI agent 的客户端；
> yo-agent 是可被其 bridge 驱动、也可独立运行的**自研 agent 本体**。

---

## 当前状态

🔬 **调研 + 设计阶段**。尚无可运行代码。

- 竞品调研：见 [`docs/research/`](docs/research/)（逐个 agent 的拆解）+ [`docs/research/_LANDSCAPE.md`](docs/research/_LANDSCAPE.md)（横向综述）。
- 全面设计：见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 规划结构（设计阶段会细化）

```
yo-agent/
├─ docs/
│  ├─ DESIGN.md            # ★ 全面设计（单一事实源）
│  └─ research/            # 竞品逐个调研 + 横向综述
└─ (实现代码：设计定稿后搭建)
```

## 工具链

- **Node ≥ 20 / TypeScript ≥ 5**（设计定稿后确定具体版本与构建链）。
