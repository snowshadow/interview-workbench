# 架构

## 目标

面试工作台采用单用户、本地优先架构。核心原则是：候选人数据落在本机；外部 provider 只接收完成当前动作所需的数据；实时转录和 AI 分析互不阻塞；服务重启不能丢失已提交任务或错误推进分析游标。

## 组件

```text
浏览器 (React + Web Audio)
  |-- 采集：麦克风，或麦克风 + 共享窗口音频混流
  |-- REST：场次、简历、JD、备份、分析任务
  |-- WebSocket：16kHz PCM 音频与实时转录
  v
Node 服务 (Express + ws)
  |-- 安全边界：来源、令牌、安全响应头
  |-- SQLite 数据仓库：场次、转录、卡片、任务
  |-- 附件存储：PDF/DOC/DOCX
  |-- 分析任务服务：幂等、重试、恢复、并发
  |-- ASR 服务适配器：火山引擎协议
  `-- LLM 服务适配器：兼容 OpenAI 的接口

AI 编程助手 (Codex / Claude Code / WorkBuddy)
  |-- Agent Skill：筛选、准备、创建、总结
  `-- 标准输入输出 MCP：分页读取场次并回写 Markdown 产物
        `-- REST API -> SQLite 数据仓库
```

## 数据模型

- `interviews`：场次元数据、状态、时间、准备材料和分析游标
- `transcript_lines`：按场次和位置递增保存的确定转录
- `analysis_cards`：前端展示的追问卡片
- `analysis_jobs`：持久化任务状态、尝试次数、输入和结果
- `attachments`：文件元数据；二进制保存在 `attachments/`
- `jd_library` / `status_options`：可复用 JD 和自定义状态
- `interview_artifacts`：筛选、准备、总结等可回写 Markdown 产物
- `harness_sessions`：场次与 Codex、Claude Code、WorkBuddy 等会话的关联
- `provider_settings`：网页保存的 ASR、LLM 配置；密钥不进入 JSON 导出

SQLite 启用 WAL、外键和 busy timeout。进程 umask 为 `077`，数据库、附件、备份和日志使用仅当前用户可读写的权限。

Provider 配置按“网页保存值优先、环境变量回退”的顺序合并。保存后直接更新 provider 共享配置对象，新建 ASR 会话和后续 LLM 任务立即使用新值，不需要重启服务。监听地址、端口、数据目录、访问令牌等启动参数仍只由环境变量控制。

## 分析状态机

```text
queued -> running -> done
                   -> retrying -> running
                   -> error -> queued (manual retry)
                   -> cancelled
```

同一场次、片段边界和转录文本生成固定幂等键。只有任务到达 `done` 后，`last_processed_line_count` 才推进到卡片的 `segment_end`。失败、取消或进程重启都不会跳过转录片段。

## Provider 边界

ASR provider 负责凭证判断、上游连接、协议编解码、重连和标准化转录结果。核心服务只创建会话。

浏览器会议声音模式使用 Screen Capture API 请求用户选择窗口或屏幕，只提取音频轨，与麦克风在 Web Audio 中混为单声道 PCM。共享视频轨仅用于维持浏览器授权，不读取、不上传、不保存；停止面试或连接异常时会同时释放麦克风和共享流。

LLM provider 负责构造受限提示词、网络超时、响应解析和 Markdown 白名单清洗。简历、JD 和转录均按不可信资料处理，不能改变系统指令或输出格式。

新增 provider 时应实现同等接口并增加协议、错误分类和数据边界测试，不应把供应商逻辑放回 `server/index.js`。

## 安全边界

- 默认监听 `127.0.0.1`
- 非 loopback 地址必须设置 `WORKBENCH_ACCESS_TOKEN`
- HTTP 使用 Bearer token；浏览器 WebSocket 使用认证子协议
- Origin 白名单同时保护 REST 和 WebSocket
- 静态页面和 API 设置 CSP、Permissions Policy、禁止嵌入和 MIME sniffing
- 日志按大小轮转并脱敏，不记录转录、简历、候选人姓名或 API Key
- 删除场次后，对应附件不能继续通过公开 URL 读取

这是单用户安全模型，不应被误当作多租户身份与权限系统。

## 恢复与兼容

首次发现旧 JSON 存储时，系统先复制备份，再事务性迁移到 SQLite。完整导入会先创建当前 SQLite 快照，然后替换数据。旧 JSON 不会被自动删除。

## 目录职责

```text
server/config.js                 环境配置与部署约束
server/security.js               HTTP/WebSocket 安全边界
server/storage/                  SQLite repository 和迁移
server/services/                 持久化业务任务
server/providers/asr/            ASR adapters
server/providers/llm/            LLM adapters
mcp/server.mjs                   本地 stdio MCP 与工作台 REST 适配
skills/                           跨 Harness 的通用 Agent Skills
src/api.js                       浏览器 API、认证和 WebSocket 接入
src/interview-domain.js          场次状态、排序和日期等纯领域函数
src/components/                  场次库和通用工作台组件
src/App.jsx                      主工作流状态与交互编排
test/                            存储、任务、安全和 provider 测试
```

前端已拆出 API、场次领域逻辑、场次库和通用组件。下一阶段可以继续按 `resume-pane`、`assistant-pane`、`transcript-pane` 和对应 hooks 拆分，但不应在拆分时改变持久化协议。
