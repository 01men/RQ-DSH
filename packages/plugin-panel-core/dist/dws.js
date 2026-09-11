import { spawn } from "node:child_process";
const INSTALL_CMD = "npm install -g dingtalk-workspace-cli";
const INSTALL_HINT = `\u672A\u68C0\u6D4B\u5230 dws CLI\uFF08\u9489\u9489\u5B98\u65B9\u547D\u4EE4\u884C\uFF09\u3002\u4E00\u952E\u5B89\u88C5\uFF08\u672C\u9762\u677F\u6309\u94AE\uFF09\u6216\u624B\u52A8\u6267\u884C\uFF1A${INSTALL_CMD}\uFF1B\u5B89\u88C5\u540E\u5728\u7EC8\u7AEF\u6267\u884C dws login \u5B8C\u6210\u9489\u9489\u6388\u6743\u3002`;
const SPAWN_TIMEOUT_MS = 2e4;
const INSTALL_TIMEOUT_MS = 24e4;
const OUTPUT_CAP = 8e3;
function dwsBinding(ctx) {
  return ctx.opsStorage.collection("panel:dingtalk");
}
function readBinding(ctx) {
  return dwsBinding(ctx).get("dws");
}
const quote = (value) => /[^\w@%+=:,./-]/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
function exec(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const line = [command, ...args.map(quote)].join(" ");
    const child = spawn(line, [], {
      shell: true,
      windowsHide: true,
      env: { ...process.env }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: stdout.slice(-OUTPUT_CAP), stderr: stderr.slice(-OUTPUT_CAP) });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      finish(false);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += String(error);
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}
class DwsCli {
  versionCache;
  ctx;
  constructor(ctx) {
    this.ctx = ctx;
  }
  async probe(force = false) {
    const cached = this.versionCache;
    if (!force && cached && Date.now() - cached.at < 3e4) return cached;
    const result = await exec("dws", ["--version"], 1e4);
    const version = result.ok ? result.stdout.trim().split(/\r?\n/)[0]?.trim() : void 0;
    const probed = { at: Date.now(), installed: result.ok && Boolean(version), version };
    this.versionCache = probed;
    return probed;
  }
  /** 状态面（面板 pill/绑定弹窗消费）。 */
  async status() {
    const { installed, version } = await this.probe();
    const binding = readBinding(this.ctx);
    return {
      installed,
      ...version ? { version } : {},
      mode: "dws-cli",
      bound: Boolean(binding?.group),
      ...binding?.group ? { group: binding.group } : {},
      installHint: installed ? "" : INSTALL_HINT
    };
  }
  /** 一键安装（npm 全局装官方 CLI）；已装则直接返回成功。耗时长，调用面须放行 panel.config.write。 */
  async install() {
    const { installed, version } = await this.probe(true);
    if (installed) return { ok: true, message: `dws CLI \u5DF2\u5B89\u88C5\uFF08${version}\uFF09\uFF0C\u65E0\u9700\u91CD\u590D\u5B89\u88C5` };
    const result = await exec(INSTALL_CMD, [], INSTALL_TIMEOUT_MS);
    const tail = (result.stdout + result.stderr).trim().split(/\r?\n/).slice(-6).join("\n");
    const after = await this.probe(true);
    if (after.installed) {
      return { ok: true, message: `dws CLI \u5B89\u88C5\u5B8C\u6210\uFF08${after.version}\uFF09\u3002\u8BF7\u5728\u7EC8\u7AEF\u6267\u884C dws login \u5B8C\u6210\u9489\u9489\u6388\u6743\u540E\u56DE\u6765\u7ED1\u7FA4` };
    }
    return {
      ok: false,
      message: `dws CLI \u81EA\u52A8\u5B89\u88C5\u5931\u8D25\uFF08npm \u9000\u51FA\u7801\u975E 0\uFF09\u3002\u8BF7\u624B\u52A8\u6267\u884C\uFF1A${INSTALL_CMD}
${tail}`
    };
  }
  /** 绑定/换绑目标群（存群名或会话 ID，投递时由 dws 解析）。 */
  bind(group, boundBy) {
    const trimmed = group.trim();
    if (!trimmed) throw new Error("\u7FA4\u540D/\u4F1A\u8BDD ID \u5FC5\u586B");
    const collection = dwsBinding(this.ctx);
    const existing = collection.get("dws");
    const record = existing ? collection.update("dws", { group: trimmed, boundAt: (/* @__PURE__ */ new Date()).toISOString(), boundBy }) : collection.insert({ id: "dws", group: trimmed, boundAt: (/* @__PURE__ */ new Date()).toISOString(), boundBy });
    return record;
  }
  unbind() {
    const binding = readBinding(this.ctx);
    if (binding) dwsBinding(this.ctx).remove("dws");
  }
  /**
   * 出向投递：dws chat +send-to-group --group <群> --content <文本>（--format json 结构化判果）。
   * 失败抛错（调用方落 audit/事件留痕），绝不静默。
   */
  async sendToGroup(text, group) {
    const { installed, version } = await this.probe();
    if (!installed) throw new Error(`dws CLI \u672A\u5B89\u88C5\uFF0C\u65E0\u6CD5\u6295\u9012\u3002${INSTALL_HINT}`);
    const target = group?.trim() || readBinding(this.ctx)?.group;
    if (!target) throw new Error("\u672A\u7ED1\u5B9A\u9489\u9489\u7FA4\uFF1A\u8BF7\u5148\u5728\u9762\u677F\u300C\u9489\u9489\u300D\u7ED1\u5B9A\u76EE\u6807\u7FA4");
    const result = await exec("dws", ["chat", "+send-to-group", "--group", target, "--content", text, "--format", "json"], SPAWN_TIMEOUT_MS);
    if (!result.ok) {
      const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-4).join("\uFF1B");
      throw new Error(`dws \u6295\u9012\u5931\u8D25\uFF1A${tail || "dws \u547D\u4EE4\u9000\u51FA\u7801\u975E 0\uFF08\u8BF7\u68C0\u67E5 dws login \u6388\u6743\u6001\u4E0E\u7FA4\u540D\uFF09"}`);
    }
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed && parsed.ok === false) {
        const reason = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
        throw new Error(`dws \u6295\u9012\u5931\u8D25\uFF1A${reason ?? "CLI \u8FD4\u56DE ok:false"}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
      } else {
        throw error;
      }
    }
    return { group: target, ...version ? { version } : {} };
  }
  /**
   * 入向拉取：dws chat +chat-messages 读绑定群最新消息（默认当前时间向前 --limit 条）。
   * 返回归一化消息（createTime 按 dws 输出的本地时区解析为 ISO）；失败抛错，绝不静默。
   */
  async pullLatestMessages(limit = 20, group) {
    const { installed } = await this.probe();
    if (!installed) throw new Error(`dws CLI \u672A\u5B89\u88C5\uFF0C\u65E0\u6CD5\u62C9\u53D6\u3002${INSTALL_HINT}`);
    const target = group?.trim() || readBinding(this.ctx)?.group;
    if (!target) throw new Error("\u672A\u7ED1\u5B9A\u9489\u9489\u7FA4\uFF1A\u8BF7\u5148\u5728\u9762\u677F\u300C\u9489\u9489\u300D\u7ED1\u5B9A\u76EE\u6807\u7FA4");
    const capped = Math.min(Math.max(Math.floor(limit) || 20, 1), 50);
    const result = await exec("dws", ["chat", "+chat-messages", "--group", target, "--limit", String(capped), "--no-reactions", "--format", "json"], SPAWN_TIMEOUT_MS);
    if (!result.ok) {
      const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-4).join("\uFF1B");
      throw new Error(`dws \u62C9\u53D6\u5931\u8D25\uFF1A${tail || "dws \u547D\u4EE4\u9000\u51FA\u7801\u975E 0\uFF08\u8BF7\u68C0\u67E5 dws login \u6388\u6743\u6001\u4E0E\u7FA4\u540D\uFF09"}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("dws \u62C9\u53D6\u5931\u8D25\uFF1ACLI \u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u8F93\u51FA\uFF08\u8BF7\u68C0\u67E5 dws \u7248\u672C \u22651.0\uFF09");
    }
    if (parsed && parsed.ok === false) {
      const reason = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
      throw new Error(`dws \u62C9\u53D6\u5931\u8D25\uFF1A${reason ?? "CLI \u8FD4\u56DE ok:false"}`);
    }
    return (parsed.messages ?? []).filter((m) => m.messageId && (m.text ?? "").trim()).map((m) => ({
      messageId: String(m.messageId),
      sender: String(m.sender ?? "\u9489\u9489\u6210\u5458"),
      text: String(m.text ?? "").trim(),
      // dws createTime 为 "YYYY-MM-DD HH:mm:ss" 本地时区形态 → 按本地时区解析
      createdAt: new Date(String(m.createTime ?? "").replace(" ", "T")).toISOString()
    }));
  }
}
export {
  DwsCli,
  dwsBinding
};
