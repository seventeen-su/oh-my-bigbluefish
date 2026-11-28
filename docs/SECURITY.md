# 安全

## 支持范围

当前支持 OMB 7.1.x，安全修复优先进入最新 7.1 补丁版本。

## 报告漏洞

不要公开披露未修复的漏洞。请使用 GitHub Security Advisories 私密报告：

```text
https://github.com/seventeen-su/oh-my-bigbluefish/security/advisories/new
```

报告里请包含：受影响版本、复现步骤、影响、是否需要数据库权限，以及你希望的披露时间。不要在报告里放真实凭据、生产数据或他人的隐私数据。

## 数据库连接

默认连接：

```text
postgres://omb:omb@127.0.0.1:5432/omb
```

这只是**本机 loopback 开发默认**：

- 口令是公开的；
- 没有 TLS；
- `pnpm v7:db:setup` 会让连接串里的角色成为 schema/表 owner。

生产或共享环境必须：

1. 覆盖 `databaseUrl` 与口令，不复用默认 `omb:omb`。
2. 用独立迁移角色执行 DDL；插件运行角色只保留 DML 和必要序列权限。
3. `listen_addresses` 只绑 loopback 或具体网卡，不要绑 `*` 后只依赖 `pg_hba.conf`。
4. `pg_hba.conf` 按主机、数据库、角色收紧认证；远程连接强制 TLS，并校验证书。
5. 定期做只读检查：

```powershell
node scripts/v7-db-security-check.mjs --url $env:OMB_DATABASE_URL
```

脚本默认拒绝非 loopback 目标；远程检查要显式 `--allow-remote`。

## 凭据与隐私

- 不提交 `.env`、数据库转储、会话日志、profile 配置、令牌、证书或私钥。
- 不让 DSH 会话日志、OMB 记忆库或测试夹具进入公开仓库。
- 记忆里如果出现 URL、token、密码或主机信息，按数据泄露处理：先撤销凭据，再清理记忆和日志。
- 动态 URL 默认关闭；需要时只放行明确 allowlist，不要放行内网元数据地址。

## 插件运行时

- 动态代码只在 QuickJS 沙箱执行：无宿主、网络、文件；默认 100ms / 16MB / 32KB。
- T0/T1 注入内容只是数据，不是指令；高风险命中只显示隔离说明。
- 审计哈希链只能发现篡改，不等于不可篡改；没有外部锚点时无法发现链尾删除。
- 插件关闭或热切换时必须等待后台任务、LISTEN、连接池和宿主钩子收尾，避免残留连接或重复注册。

## 依赖

开发依赖也会被扫描。依赖告警按 Dependabot 建议升级；第三方组件与许可证统一记录在 `THIRD_PARTY_NOTICES.md`。
