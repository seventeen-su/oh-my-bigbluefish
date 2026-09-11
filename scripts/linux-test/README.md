# Linux 真机验证脚本（开发用）

这套脚本用来在**真实 Linux** 上验证 OMB 的平台层（`substrate/`）。它们不是测试套件的一部分，
而是"把仓库搬到一台真 Linux 机器上跑一遍"的自动化：本机是 Windows，平台层（bwrap 通道、POSIX
只读、路径口径、三线布局）在 Windows 上永远验不到真实行为——2026-09 的两次真机实测都因此抓到了
Windows 上不可能暴露的缺陷（见下）。

## 为什么需要它们（真机抓到过的缺陷）

| 缺陷 | Windows 上能否发现 | 症状 |
|---|---|---|
| `bwrapArgs` 里 `--tmpfs /tmp` 把私有 temp 的**绑定源**清空 | 否 | bwrap 整体失败，自检只报"未产出结果文件"，通道静默失效 |
| `--ro-bind <scriptDir>` 写在可写绑定**之后**，把 `writableDirs` 重新挂成只读 | 否 | 候选脚本写结果文件 `EROFS`；"自己把自己的写权限抹掉" |
| `flushPendingNotifications` 的 TDZ（启动校验的 `.then` 先于声明执行） | 否 | 未处理拒绝：`Cannot access ... before initialization` |

## 用法（PVE 上的临时 LXC，用后销毁）

```bash
# 0. 前置：本机 ssh 配好了 $OMB_LINUX_HOST（见 ~/.ssh/config 与 ~/.ssh/README.md）

# 1. 在 PVE 宿主上创建并配置临时容器（Debian 13、非特权、nesting+keyctl）
ssh $OMB_LINUX_HOST "bash -s 9001" < scripts/linux-test/pve-provision.sh

# 2. 容器内装 Node（与开发机同 major；顺带自检 --permission 可用性）
ssh $OMB_LINUX_HOST "pct push 9001 /root/ct-node.sh /root/ct-node.sh && pct exec 9001 -- bash /root/ct-node.sh 24"

# 3. 把仓库同步进容器（git clone 或 tar 增量；容器内 /root/omb）
#    ★ 关键一步：初始化三线布局 —— 缺了它，认知运行时会**永久停在 boot gate**
#      （"仅命令模式"），于是所有走 prepareTurn 的用例（hook-*/smoke-session/no-double-loop）
#      全部以 5s 超时告终，看起来像"Linux 挂了"，其实是**测试夹具缺运行产物**。
ssh $OMB_LINUX_HOST "pct exec 9001 -- env PATH=/usr/local/bin:/usr/bin:/bin bash -c 'cd /root/omb && pnpm init-three-line'"

# 4. 平台层探针（通道自检 / 只读施加 / 真实受限执行）
ssh $OMB_LINUX_HOST "pct push 9001 /root/linux-probe.sh /root/linux-probe.sh --perms 755 && \
  pct exec 9001 -- env PATH=/usr/local/bin:/usr/bin:/bin bash /root/linux-probe.sh"

# 5. 全量测试套件
ssh $OMB_LINUX_HOST "pct exec 9001 -- bash /root/run-suite.sh"
#    单文件/子集：pct exec 9001 -- bash /root/sub-suite.sh tests/m8/hook-context.test.ts
#    失败归因：  pct exec 9001 -- bash /root/analyze.sh

# 6. 收尾：销毁容器（不污染宿主）
ssh $OMB_LINUX_HOST "pct stop 9001 --skiplock 1; pct destroy 9001 --purge 1"
```

## 注意事项（踩过的）

- **`pct exec` 的 PATH 可能是空的**：所有命令都要显式 `env PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`。
- **脚本从 Windows 传过去会带 CRLF**：`ssh $OMB_LINUX_HOST "tr -d '\r' > /root/x.sh"` 先归一化，否则报 `$'\r': command not found`。
- **容器内是 root**：POSIX 权限位只读对本进程不生效（`CAP_DAC_OVERRIDE`），`readOnly.isReadOnly()` 走
  模式位判定，写探测必然成功——这是平台提供者已如实标注的语义，不是缺陷。
- `bwrap-diag.sh` 是当时定位两个 bwrap 缺陷用的对照实验（保留作回归排查的起点）。
