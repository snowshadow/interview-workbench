# AI 编程助手接入

面试工作台提供本地标准输入输出 MCP 服务和四个可移植的 Agent Skill。Codex、Claude Code、WorkBuddy 等 AI 编程助手可以读取面试上下文、创建场次、分段读取长转录，并把 Markdown 产物写回工作台，不再需要手动导出。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `list_interviews` | 查找场次，不加载简历和转录等隐私内容 |
| `get_interview_context` | 读取 JD、简历分析、备注、追问、面试产物和关联会话 |
| `get_transcript_chunk` | 按时间顺序分段读取转录 |
| `create_interview` | 创建场次，并可附加本地简历 |
| `save_interview_artifact` | 保存或覆盖筛选报告、面试准备和面试总结 |
| `link_harness_session` | 把 AI 编程助手会话与面试场次关联 |
| `update_interview_status` | 仅在用户明确同意后更新面试状态 |

使用 MCP 前需要先启动工作台服务：

```bash
npm run build
npm start
```

下面的命令必须使用仓库的绝对路径。

## Codex

```bash
codex mcp add interview-workbench \
  --env WORKBENCH_URL=http://127.0.0.1:8787 \
  -- node /absolute/path/to/interview-workbench/mcp/server.mjs

node scripts/install-skills.mjs codex
```

当环境中存在 `CODEX_THREAD_ID` 时，新建面试和保存产物会自动关联当前 Codex 会话。

## Claude Code

```bash
claude mcp add --scope user interview-workbench \
  -e WORKBENCH_URL=http://127.0.0.1:8787 \
  -- node /absolute/path/to/interview-workbench/mcp/server.mjs

node scripts/install-skills.mjs claude
```

也可以把 Skill 安装到当前项目的 `.claude/skills/` 目录。

## WorkBuddy 和其他 AI 编程助手

新建一个本地 **MCP + CLI** 连接器：

```text
命令：node
参数：/absolute/path/to/interview-workbench/mcp/server.mjs
环境变量：WORKBENCH_URL=http://127.0.0.1:8787
```

再通过对应产品的本地 Skill 功能导入 `skills/` 下的文件夹。如果产品接受技能目录路径，也可以安装一份副本：

```bash
node scripts/install-skills.mjs custom --target-dir /path/to/harness/skills
```

## 访问令牌

工作台监听非本机地址时，需要把同一令牌传给 MCP 进程。不要把令牌写进 Skill 文件：

```text
WORKBENCH_ACCESS_TOKEN=your-local-secret
```

标准输入输出 MCP 服务不会额外开放网络端口。它通过工作台 REST API 访问数据，因此仍受现有监听地址、来源限制和访问令牌规则保护。

## 无导出面试总结

面试结束后，要求 AI 编程助手为指定候选人或场次运行 `interview-summary`。Skill 会：

1. 找到准确的面试场次；
2. 读取 JD、简历分析、面试准备、备注和 AI 追问；
3. 分段读取完整转录；
4. 生成基于证据的面试报告；
5. 把报告保存为 `interview-summary` 面试产物。

除非用户明确确认新的状态，否则 Skill 不会自动修改面试状态。
