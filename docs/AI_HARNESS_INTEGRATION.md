# AI 编程助手接入

面试工作台提供本地标准输入输出 MCP 服务和四个可移植的 Agent Skill。Codex、Claude Code、WorkBuddy 等 AI 编程助手可以读取应聘流程与单轮面试上下文、安排下一轮、分段读取长转录，并把 Markdown 产物写回工作台，不再需要手动导出。

多轮面试采用两层模型：`Application` 表示“候选人 × 岗位”的一次应聘流程，`InterviewRound` 表示一面、二面、终面或加面。简历和 JD 属于 Application；时间、目标、转录、追问与单轮结论属于 InterviewRound。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `list_applications` | 查找应聘流程，不加载简历、轮次详情和转录 |
| `get_application_context` | 读取共享资料、轮次列表、跨轮摘要、未验证项和流程级产物 |
| `list_interviews` | 查找单轮面试，不加载简历和转录等隐私内容 |
| `get_interview_context` | 读取指定单轮的准备、备注、追问、产物和关联会话 |
| `get_transcript_chunk` | 按时间顺序分段读取指定单轮的转录 |
| `create_interview` | 兼容入口：创建应聘流程及首轮，并可附加本地简历 |
| `create_interview_round` | 在已有应聘流程下安排下一轮，不重复简历和 JD |
| `save_application_artifact` | 保存或覆盖跨轮交接、流程汇总和最终结论 |
| `save_interview_artifact` | 保存或覆盖单轮准备和单轮总结 |
| `link_harness_session` | 把 AI 编程助手会话与指定单轮关联 |
| `update_application_status` | 仅在用户明确同意后更新应聘流程的招聘状态 |
| `update_interview_round` | 更新单轮的时间、时长、生命周期、重点或结果 |
| `update_interview_status` | 兼容旧调用：通过轮次 ID 更新所属流程的招聘状态 |

`create_interview_round` 接收 `applicationId`、`roundLabel`、`scheduledAt`、`durationMinutes`、`roundFocus` 和可选的 `roundStatus`，调用 `POST /api/applications/:id/rounds`。`durationMinutes` 是 1–1440 的整数，省略时为 60。未传 `roundStatus` 时，工作台根据 `scheduledAt` 推导为“待安排”或“已安排”。轮次状态只描述机械生命周期：待安排、已安排、进行中、已结束、已取消；本轮结论写入 `outcome`，两者都不代表 Application 的最终招聘状态。

`list_interviews` 分别使用 `applicationStatus` 和 `roundStatus` 过滤招聘状态与轮次生命周期；旧参数 `status` 只作为 `applicationStatus` 的兼容别名。

旧版把“未面”“已安排”“一面通过”等轮次信息写进 Application 状态的数据仍可读取和筛选，但不能继续新建或覆盖写入。自定义流程状态仍可使用；排期写 `roundStatus`，本轮结论写 `outcome`。

`save_application_artifact` 和 `save_interview_artifact` 通过 `includeInCrossRoundContext` 明确声明产物是否自动进入后续轮次上下文。新的自定义 `kind` 必须显式传入该字段，已有产物更新时省略则保留原值。单轮详细报告 `interview-summary` 默认排除，精简交接 `round-handoff` 默认纳入，避免下一轮重复注入两份同源内容。新调用应使用 `update_application_status` 更新招聘状态，用 `update_interview_round` 更新轮次；`update_interview_status` 只为旧客户端保留。

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

当环境中存在 `CODEX_THREAD_ID` 时，新建首轮和保存产物会记录当前 Codex 会话；单轮会话关联仍保存在具体 InterviewRound 上。

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

## 单轮总结与跨轮交接

一轮面试结束后，要求 AI 编程助手为指定轮次运行 `interview-summary`。Skill 会：

1. 找到准确的应聘流程与轮次；
2. 读取共享资料和该轮准备、备注与 AI 追问；
3. 分段读取该轮完整转录；
4. 生成基于证据的面试报告；
5. 把报告保存为该轮的 `interview-summary`，并把精简交接保存为 `round-handoff`；只有后者自动进入下一轮上下文。

安排下一轮时，先用 `get_application_context` 读取此前各轮形成的**已确认事实、未验证风险、矛盾点和下一轮目标**，再将新的准备稿保存到新轮次。跨轮上下文默认不拼接所有历史转录；只有摘要无法支撑判断时，才用 `get_transcript_chunk` 定向读取某一轮的相关内容。需要持续维护的跨轮交接内容通过 `save_application_artifact` 回写到 Application。

除非用户明确确认新的招聘状态，否则 Skill 不会自动修改 Application 状态。Round 的机械生命周期由工作台操作推进。
