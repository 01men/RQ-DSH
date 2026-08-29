#!/usr/bin/env bash
# 端口占用守卫（systemd ExecStartPre 用，测试报告 DEF-04）。
#
# 背景：2026-08 功能性测试发现 7300 端口曾被脱离 systemd 的手工进程长期占用，
# 导致 systemctl restart 后新进程无法绑定端口、变更不生效（孤儿进程抢端口）。
# 本脚本在服务启动前检测目标端口：空闲则放行；被占用则拒绝启动并给出处置指引，
# 由 systemd 明确报错，避免「重启成功但旧进程仍在服务」的静默失效。
#
# 用法：ExecStartPre=/opt/ops-platform/scripts/guard-port.sh 7300
set -euo pipefail

PORT="${1:-7300}"

if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
  echo "[guard-port] 用法：guard-port.sh <端口号>" >&2
  exit 2
fi

# 优先 ss，退化用 lsof；两者都不可用时放行（不阻塞启动，仅失去防护）。
# 注意：systemd 默认 PATH 不含 /usr/sbin（RHEL 系 ss 所在目录），必须按绝对路径探测，
# 否则守卫会走「均不可用」分支被静默跳过（2026-08 二次巡检实测发现并修复）。
holder=""
SS_BIN=""
for p in /usr/sbin/ss /usr/bin/ss /bin/ss /sbin/ss; do
  if [[ -x "$p" ]]; then SS_BIN="$p"; break; fi
done
if [[ -n "$SS_BIN" ]]; then
  holder="$("$SS_BIN" -tlnpH "sport = :$PORT" 2>/dev/null | grep -oP 'users:\(\("\K[^"]+' | head -1 || true)"
elif command -v lsof >/dev/null 2>&1 || [[ -x /usr/sbin/lsof ]]; then
  LSOF_BIN="$(command -v lsof || true)"; LSOF_BIN="${LSOF_BIN:-/usr/sbin/lsof}"
  holder="$("$LSOF_BIN" -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  holder="${holder:+pid ${holder}}"
else
  echo "[guard-port] ss/lsof 均不可用，跳过端口占用检测" >&2
  exit 0
fi

if [[ -z "$holder" ]]; then
  echo "[guard-port] 端口 $PORT 空闲，允许启动"
  exit 0
fi

echo "[guard-port] 端口 $PORT 已被占用（${holder}）。" >&2
echo "[guard-port] 很可能是脱离 systemd 的孤儿进程。请先确认并结束它（kill <pid>），再 systemctl restart；" >&2
echo "[guard-port] 切勿绕过 systemd 手工拉起服务（会造成本次故障：重启不生效、变更丢失）。" >&2
exit 1
