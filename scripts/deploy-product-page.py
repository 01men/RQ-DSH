#!/usr/bin/env python
"""把重写后的产品页单文件定向部署到测试环境 mdzx.fun:8801（避开部署树其它在途脏文件）。

沿用既有约定（见 D:/DSH-07/daily-sync-deploy.py 的 mac 目标）：
  主机/账号/密码、远端目录 /Users/xiaodaoqin/ops-platform-test、
  目标 = packages/plugin-console/public/{产品.html, product.html}（控制台静态根）
只同步这一个文件，不做全树比对（工作区尚有其它未提交 WIP）。

流程：本地 md5（\\r 归一）→ 远端先备份 → SFTP 上传 → 远端 md5 复核 → 不一致即失败退出。
"""
import hashlib
import posixpath
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST, USER, PWD = "mdzx.fun", "xiaodaoqin", "201314"
REMOTE = "/Users/xiaodaoqin/ops-platform-test"
SRC = "D:/DSH-RQ/产品.html"
# 控制台静态根下的三个路径（外加仓库根副本）。
# 注意第三项：宿主静态层不解码 pathname，浏览器请求 /%E4%BA%A7%E5%93%81.html 时
# 它找的是**字面名为 %E4%BA%A7%E5%93%81.html 的文件**——三个副本必须同步更新，
# 否则编码形态路径会一直吐旧内容（2026-09-18 实测踩到）。
TARGETS = [
    "packages/plugin-console/public/产品.html",
    "packages/plugin-console/public/product.html",
    "packages/plugin-console/public/%E4%BA%A7%E5%93%81.html",
    "产品.html",
]
BACKUP = "backup-product-page-20260918"


def md5_normalized(data: bytes) -> str:
    return hashlib.md5(data.replace(b"\r", b"")).hexdigest()


def main() -> int:
    with open(SRC, "rb") as f:
        payload = f.read()
    local = md5_normalized(payload)
    print(f"local  {SRC}  {len(payload)} bytes  md5={local}")

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PWD, timeout=25)

    def run(cmd, timeout=120):
        _, o, e = c.exec_command(cmd, timeout=timeout)
        return o.read().decode(errors="replace"), e.read().decode(errors="replace")

    sftp = c.open_sftp()

    # 1) 远端备份现有副本
    o, e = run(f"mkdir -p {REMOTE}/{BACKUP} && ls -la {REMOTE}/{BACKUP}")
    print(f"backup dir ready: {o.strip().splitlines()[-1] if o.strip() else '(new)'}")
    for rel in TARGETS:
        rp = posixpath.join(REMOTE, rel)
        try:
            data = sftp.open(rp, "rb").read()
        except IOError:
            print(f"  (skip backup, not present) {rel}")
            continue
        bname = rel.replace("/", "__")
        with sftp.open(f"{REMOTE}/{BACKUP}/{bname}", "wb") as fh:
            fh.write(data)
        print(f"  backed up {rel}  ({len(data)} bytes, md5={md5_normalized(data)})")

    # 2) 上传
    for rel in TARGETS:
        rp = posixpath.join(REMOTE, rel)
        with sftp.open(rp, "wb") as fh:
            fh.write(payload)
        print(f"  uploaded -> {rel}")

    sftp.close()

    # 3) 远端 md5 复核（BSD md5 -q；与本地同样做 \r 归一再算）
    print("\n--- verify ---")
    ok = True
    for rel in TARGETS:
        rp = posixpath.join(REMOTE, rel)
        o, e = run(f"cd {REMOTE} && tr -d '\\r' < '{rel}' | md5 -q")
        digest = o.strip().splitlines()[-1] if o.strip() else ""
        match = digest == local
        ok = ok and match
        print(f"  {'OK  ' if match else 'FAIL'} {rel}  remote={digest}")

    c.close()
    print("\nRESULT:", "ALL MATCH" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())