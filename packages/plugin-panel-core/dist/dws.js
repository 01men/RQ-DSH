import { spawn } from "node:child_process";
const INSTALL_CMD = "npm install -g dingtalk-workspace-cli";
const INSTALL_HINT = `\u672A\u68C0\u6D4B\u5230 dws CLI\uFF08\u9489\u9489\u5B98\u65B9\u547D\u4EE4\u884C\uFF09\u3002\u4E00\u952E\u5B89\u88C5\uFF08\u672C\u9762\u677F\u6309\u94AE\uFF09\u6216\u624B\u52A8\u6267\u884C\uFF1A${INSTALL_CMD}\uFF1B\u5B89\u88C5\u540E\u5728\u9762\u677F\u300C\u9489\u9489\u8FDE\u63A5\u300D\u53D1\u8D77\u767B\u5F55\uFF08\u8BBE\u5907\u7801\u6388\u6743\uFF09\u5B8C\u6210\u9489\u9489\u6388\u6743\u3002`;
const SPAWN_TIMEOUT_MS = 2e4;
const INSTALL_TIMEOUT_MS = 24e4;
const OUTPUT_CAP = 8e3;
const LOGIN_TIMEOUT_MS = 96e4;
const LOGIN_INFO_WAIT_MS = 25e3;
const AUTH_CACHE_MS = 15e3;
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
function parseDeviceFlowOutput(text) {
  const link = text.match(/link:\s*(https?:\/\/\S+)/)?.[1];
  const userCode = text.match(/authorization code:\s*([A-Za-z0-9-]+)/i)?.[1] ?? text.match(/user_code=([A-Za-z0-9-]+)/)?.[1];
  const expiresInSeconds = Number(text.match(/expire in (\d+) seconds/i)?.[1] ?? 0) || void 0;
  const combined = text.match(/https?:\/\/\S*user_code=[A-Za-z0-9-]+/)?.[0];
  if (link && userCode) return { link, userCode, verifyUrl: `${link}?user_code=${userCode}`, ...expiresInSeconds ? { expiresInSeconds } : {} };
  if (combined) return { verifyUrl: combined, ...userCode ? { userCode } : {}, ...expiresInSeconds ? { expiresInSeconds } : {} };
  return {
    ...link ? { link } : {},
    ...userCode ? { userCode } : {},
    ...expiresInSeconds ? { expiresInSeconds } : {}
  };
}
function parseAuthStatus(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed?.authenticated !== true) return { authenticated: false, ...text.trim() ? { raw: text.slice(-400) } : {} };
    return {
      authenticated: true,
      ...parsed.corp_name ? { corpName: parsed.corp_name } : {},
      ...parsed.user_name ? { userName: parsed.user_name } : {},
      ...parsed.user_id !== void 0 ? { userId: String(parsed.user_id) } : {},
      ...parsed.expires_at ? { expiresAt: parsed.expires_at } : {}
    };
  } catch {
    return { authenticated: false, ...text.trim() ? { raw: text.slice(-400) } : {} };
  }
}
class DwsCli {
  versionCache;
  authCache;
  /** 进行中的设备流登录会话（同机同时至多一个；重发即顶掉旧会话）。 */
  loginSession;
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
  /**
   * 授权态探测（dws auth status）。未装/未登录/输出异常一律 authenticated:false + raw 尾部，
   * 绝不把「探测失败」粉饰成「已登录」或反之。结果缓存 15s；登录终态判定走 force。
   */
  async authStatus(force = false) {
    const cached = this.authCache;
    if (!force && cached && Date.now() - cached.at < AUTH_CACHE_MS) return cached.auth;
    const result = await exec("dws", ["auth", "status", "--format", "json", "--timeout", "15"], 2e4);
    const auth = parseAuthStatus(result.stdout || result.stderr);
    this.authCache = { at: Date.now(), auth };
    return auth;
  }
  /** 状态面（面板 pill/绑定弹窗消费）。 */
  async status() {
    const { installed, version } = await this.probe();
    const binding = readBinding(this.ctx);
    const auth = installed ? await this.authStatus().catch(() => ({ authenticated: false })) : { authenticated: false };
    return {
      installed,
      ...version ? { version } : {},
      mode: "dws-cli",
      bound: Boolean(binding?.group),
      ...binding?.group ? { group: binding.group } : {},
      installHint: installed ? "" : INSTALL_HINT,
      auth
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
      return { ok: true, message: `dws CLI \u5B89\u88C5\u5B8C\u6210\uFF08${after.version}\uFF09\u3002\u53EF\u5728\u9762\u677F\u300C\u9489\u9489\u8FDE\u63A5\u300D\u76F4\u63A5\u53D1\u8D77\u767B\u5F55\uFF08\u8BBE\u5907\u7801\u6388\u6743\uFF09\uFF0C\u6216\u7EC8\u7AEF\u6267\u884C dws auth login` };
    }
    return {
      ok: false,
      message: `dws CLI \u81EA\u52A8\u5B89\u88C5\u5931\u8D25\uFF08npm \u9000\u51FA\u7801\u975E 0\uFF09\u3002\u8BF7\u624B\u52A8\u6267\u884C\uFF1A${INSTALL_CMD}
${tail}`
    };
  }
  // -- 登录授权面（2026-09-11 用户需求：面板代发起 dws 登录，未登录弹激活指令） ---------------
  /**
   * 代发起登录（dws auth login --device 设备流）：CLI 在本机起轮询、打印激活指令（授权链接 +
   * 用户码），面板把指令弹给用户；用户任意设备上完成授权后 CLI 轮询拿到 token，本机登录态生效。
   * 已登录 → already:true 幂等短路；已有进行中会话 → 直接复用（幂等，不重复起进程）。
   */
  async startLogin() {
    const auth = await this.authStatus(true);
    if (auth.authenticated) return { started: false, already: true, auth };
    const existing = this.loginSession;
    if (existing && !existing.exited) {
      const info2 = parseDeviceFlowOutput(existing.stdout);
      if (info2.verifyUrl) {
        return { started: true, verifyUrl: info2.verifyUrl, ...info2.userCode ? { userCode: info2.userCode } : {}, ...info2.expiresInSeconds ? { expiresInSeconds: info2.expiresInSeconds } : {} };
      }
      const waited = await this.waitForLoginInfo(existing);
      if (waited.verifyUrl) return { started: true, verifyUrl: waited.verifyUrl, ...waited.userCode ? { userCode: waited.userCode } : {}, ...waited.expiresInSeconds ? { expiresInSeconds: waited.expiresInSeconds } : {} };
      if (!existing.exited) return { started: false, message: "dws \u767B\u5F55\u8FDB\u7A0B\u5728\u4F4D\u4F46\u6FC0\u6D3B\u6307\u4EE4\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u5728\u72B6\u6001\u8F6E\u8BE2\u4E2D\u91CD\u8BD5" };
    }
    this.cancelLogin();
    const { installed } = await this.probe();
    if (!installed) return { started: false, message: INSTALL_HINT };
    const session = { stdout: "", stderr: "", startedAt: Date.now(), exited: false, exitOk: false };
    const line = ["dws", "auth", "login", "--device"].join(" ");
    const child = spawn(line, [], { shell: true, windowsHide: true, env: { ...process.env } });
    session.child = child;
    child.stdout?.on("data", (chunk) => {
      session.stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      session.stderr += String(chunk);
    });
    child.on("error", (error) => {
      session.stderr += String(error);
      session.exited = true;
    });
    child.on("close", (code) => {
      session.exited = true;
      session.exitOk = code === 0;
    });
    session.timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      session.exited = true;
    }, LOGIN_TIMEOUT_MS);
    this.loginSession = session;
    const info = await this.waitForLoginInfo(session);
    if (info.verifyUrl) {
      return { started: true, verifyUrl: info.verifyUrl, ...info.userCode ? { userCode: info.userCode } : {}, ...info.expiresInSeconds ? { expiresInSeconds: info.expiresInSeconds } : {} };
    }
    if (session.exited) {
      const tail = (session.stderr || session.stdout).trim().split(/\r?\n/).slice(-4).join("\uFF1B");
      this.loginSession = void 0;
      return { started: false, message: `dws \u767B\u5F55\u8FDB\u7A0B\u542F\u52A8\u5931\u8D25\uFF1A${tail || "\u9000\u51FA\u7801\u975E 0"}` };
    }
    return { started: false, message: "dws \u767B\u5F55\u8FDB\u7A0B\u5DF2\u542F\u52A8\u4F46\u6FC0\u6D3B\u6307\u4EE4\u8FDF\u8FDF\u672A\u8F93\u51FA\uFF08\u8BF7\u68C0\u67E5 dws \u7248\u672C \u22651.0\uFF09\uFF0C\u7A0D\u540E\u53EF\u5728\u72B6\u6001\u9762\u91CD\u8BD5" };
  }
  /** 等激活指令出现在输出缓冲（300ms 步进，至多 LOGIN_INFO_WAIT_MS）。 */
  waitForLoginInfo(session) {
    return new Promise((resolve) => {
      const deadline = Date.now() + LOGIN_INFO_WAIT_MS;
      const step = () => {
        const info = parseDeviceFlowOutput(session.stdout);
        if (info.verifyUrl) return resolve(info);
        if (session.exited || Date.now() > deadline) return resolve(info);
        setTimeout(step, 300);
      };
      step();
    });
  }
  /**
   * 登录会话状态（前端 3s 轮询）：进程在位 → active + 激活指令；进程退出 → force 复核授权态
   * 并就地消费会话（成功/失败都给终态，不悬挂）。
   */
  async loginState() {
    const session = this.loginSession;
    const auth = await this.authStatus(session?.exited === true);
    if (!session) return { active: false, authenticated: auth.authenticated, auth };
    const info = parseDeviceFlowOutput(session.stdout);
    if (!session.exited) {
      return { active: true, authenticated: auth.authenticated, ...info.verifyUrl ? { verifyUrl: info.verifyUrl } : {}, ...info.userCode ? { userCode: info.userCode } : {}, ...info.expiresInSeconds ? { expiresInSeconds: info.expiresInSeconds } : {}, auth };
    }
    this.loginSession = void 0;
    clearTimeout(session.timer);
    if (auth.authenticated) return { active: false, authenticated: true, auth };
    const tail = (session.stderr || session.stdout).trim().split(/\r?\n/).slice(-3).join("\uFF1B");
    return { active: false, authenticated: false, auth, message: session.exitOk ? "dws \u767B\u5F55\u8FDB\u7A0B\u5DF2\u7ED3\u675F\u4F46\u6388\u6743\u6001\u672A\u751F\u6548\uFF08\u53EF\u80FD\u6388\u6743\u7801\u8FC7\u671F\uFF09\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77" : `dws \u767B\u5F55\u672A\u5B8C\u6210\uFF1A${tail || "\u8FDB\u7A0B\u975E\u6B63\u5E38\u9000\u51FA\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77"}` };
  }
  /** 取消进行中的登录（杀进程 + 清理；无会话为幂等 no-op）。 */
  cancelLogin() {
    const session = this.loginSession;
    if (!session) return;
    this.loginSession = void 0;
    clearTimeout(session.timer);
    try {
      session.child?.kill();
    } catch {
    }
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
    const target = group?.trim() || readBinding(this.ctx)?.group;
    if (!target) throw new Error("\u672A\u7ED1\u5B9A\u9489\u9489\u7FA4\uFF1A\u8BF7\u5148\u5728\u9762\u677F\u300C\u9489\u9489\u300D\u7ED1\u5B9A\u76EE\u6807\u7FA4");
    const { installed, version } = await this.probe();
    if (!installed) throw new Error(`dws CLI \u672A\u5B89\u88C5\uFF0C\u65E0\u6CD5\u6295\u9012\u3002${INSTALL_HINT}`);
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
  dwsBinding,
  parseAuthStatus,
  parseDeviceFlowOutput
};
