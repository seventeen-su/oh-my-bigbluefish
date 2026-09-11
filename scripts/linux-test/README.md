# Linux 真机验证脚本（开发用）

这套脚本用来在**真实 Linux** 上验证 OMB 的平台层（`substrate/`）。它们不是测试套件的一部分，
而是"把仓库搬到一台真 Linux 机器上跑一遍"的自动化：开发机是 Windows，平台层（bwrap 通道、POSIX
只读、路径口径、三线布局）在 Windows 上永远验不到真实行为——2026-09 的真机实测因此抓到了一批
Windows 上不可能暴露的缺陷（见下）。

## 环境无关（脚本不绑定任何具体主机）

目标机器与容器 ID 都由环境变量给出，**不写死任何主机名、地址或私钥路径**：

```bash
export OMB_LINUX_HOST=<ssh 别名：一台能创建 LXC 容器的 Linux 宿主>
export OMB_CTID=9001                 # 临时容器 ID（用后销毁）
export OMB_REPO_URL=git@github.com:seventeen-su/oh-my-bigbluefish.git
```

宿主侧前置：`pct`/`pveam` 可用（Proxmox VE 系 LXC）、有 Debian 13 模板或可下载、
容器可访问外网（装 Node 与项目依赖）。

## 为什么需要它们（真机抓到过的缺陷）

| 缺陷 | Windows 上能否发现 | 症状 |
|---|---|---|
| `bwrapArgs` 里 `--tmpfs /tmp` 把私有 temp 的**绑定源**清空 | 否 | bwrap 整体失败，自检只报"未产出结果文件"，通道静默失效 |
| `--ro-bind <scriptDir>` 写在可写绑定**之后**，把 `writableDirs` 重新挂成只读 | 否 | 候选脚本写结果文件 `EROFS`："自己把自己的写权限抹掉" |
| `flushPendingNotifications` 的 TDZ（启动校验的 `.then` 先于声明执行） | 否 | 未处理拒绝：`Cannot access ... before initialization` |
| `checkpoint.list()` 无 tie-break：同毫秒两条记录的顺序取决于文件系统枚举顺序 | 否（NTFS 恰好好看） | 同一份代码在两平台给出不同顺序，`latest()` 可能取错 |
| 测试夹具硬编码 Windows 只读机制与 `EPERM/EACCES` 拒绝码 | 否 | Linux 上 fixture 直接崩，或把"正确拒绝"判成失败 |

## 用法

```bash
# 1. 在宿主上创建并配置临时容器（Debian 13、非特权、nesting+keyctl）
ssh "$OMB_LINUX_HOST" "CTID=$OMB_CTID bash -s" < scripts/linux-test/provision-container.sh

# 2. 容器内装 Node（与开发机同 major；顺带自检 --permission 可用性）
scp scripts/linux-test/install-node.sh "$OMB_LINUX_HOST:/root/"
ssh "$OMB_LINUX_HOST" "pct push $OMB_CTID /root/install-node.sh /root/install-node.sh && \
  pct exec $OMB_CTID -- bash /root/install-node.sh 24"

# 3. 把仓库同步进容器（clone 或 tar 增量；容器内 /root/omb）
#    ★ 关键一步：初始化三线布局 —— 缺了它，认知运行时会**永久停在 boot gate**（"仅命令模式"），
#      于是所有走 prepareTurn 的用例（hook-*/smoke-session/no-double-loop）全部以超时告终，
#      看起来像"Linux 挂了"，其实是**测试夹具缺运行产物**。
ssh "$OMB_LINUX_HOST" "pct exec $OMB_CTID -- env PATH=/usr/local/bin:/usr/bin:/bin \
  bash -c 'cd /root/omb && pnpm init-three-line'"

# 4. 平台层探针（通道自检 / 只读施加 / 真实受限执行）+ 工具脚本
for f in linux-probe.sh run-suite.sh sub-suite.sh analyze-failures.sh show-failure.sh; do
  scp "scripts/linux-test/$f" "$OMB_LINUX_HOST:/root/$f"
done
ssh "$OMB_LINUX_HOST" "pct exec $OMB_CTID -- env PATH=/usr/local/bin:/usr/bin:/bin bash /root/linux-probe.sh"

# 5. 全量套件 / 单文件 / 失败归因
ssh "$OMB_LINUX_HOST" "pct exec $OMB_CTID -- bash /root/run-suite.sh"
ssh "$OMB_LINUX_HOST" "pct exec $OMB_CTID -- bash /root/sub-suite.sh tests/m8/hook-context.test.ts"
ssh "$OMB_LINUX_HOST" "pct exec $OMB_CTID -- bash /root/analyze-failures.sh"

# 6. 收尾：销毁容器（不污染宿主）
ssh "$OMB_LINUX_HOST" "pct stop $OMB_CTID --skiplock 1; pct destroy $OMB_CTID --purge 1"
```

## 注意事项（踩过的）

- **`pct exec` 的 PATH 可能是空的**：所有命令都要显式 `env PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`。
- **脚本从 Windows 传过去会带 CRLF**：先 `tr -d '\r' > /root/x.sh` 归一化，否则报 `$'\r': command not found`。
- **容器内是 root**：POSIX 权限位只读对本进程不生效（`CAP_DAC_OVERRIDE`）——`readOnly.isReadOnly()`
  走模式位判定，写探测必然成功。这是平台提供者已如实标注的语义，不是缺陷；测试侧由
  `tests/helpers/sandbox-scripts.ts` 的 `readOnlyEnforced()` 显式分支处理。
- `bwrap-diag.sh` 是当时定位两个 bwrap 缺陷用的对照实验（保留作回归排查的起点）。
