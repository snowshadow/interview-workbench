# Release checklist

- [ ] 仓库中没有真实简历、转录、候选人姓名、截图、日志或 API Key
- [ ] `.env` 未被提交，公开文档只引用 `.env.example`
- [ ] 使用合成数据完成 UI 截图、issue 和演示
- [ ] `npm ci` 成功
- [ ] `npm run release:check` 全部通过
- [ ] `npm audit --omit=dev` 无已知生产依赖漏洞
- [ ] 从空数据目录完成一次首次启动
- [ ] 从旧 JSON 样例完成一次迁移并核对数量
- [ ] 完整备份导出后可在空目录恢复，附件可预览
- [ ] ASR 断线重连、LLM 超时重试和进程重启恢复均完成验证
- [ ] 本机模式只监听 loopback
- [ ] 远程模式启用 token、Origin 白名单和 HTTPS 反向代理
- [ ] 已阅读并更新 `SECURITY.md`、`PRIVACY.md` 和 provider 数据流说明
- [ ] 已确定公开仓库地址、维护者安全联系方式和首个版本号
