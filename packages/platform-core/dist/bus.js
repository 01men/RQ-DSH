import { Service } from "@deepseek-ai/cordis";
const PlatformEvents = {
  UserFrozen: "iam.user.frozen",
  UserActivated: "iam.user.activated",
  OrgChanged: "iam.org.changed",
  PermissionChanged: "iam.permission.changed",
  TokenIssued: "authn.token.issued",
  TokenRevoked: "authn.token.revoked",
  McpDeployed: "mcp.deployed",
  McpOfflined: "mcp.offlined",
  McpUnhealthy: "mcp.unhealthy",
  McpInvoked: "mcp.invoked",
  // 连接器纳管（open-connector 融合；前缀已在本文件预留清单）
  ConnectorGatewayChanged: "connector.gateway.changed",
  ConnectorGatewaySynced: "connector.gateway.synced",
  ConnectorGatewayUnhealthy: "connector.gateway.unhealthy",
  ConnectorConnected: "connector.connected",
  ConnectorDisconnected: "connector.disconnected",
  ConnectorInvoked: "connector.invoked",
  ConnectorPermGroupChanged: "connector.permgroup.changed",
  NasRegistered: "nas.registered",
  NasOnlined: "nas.onlined",
  NasOfflined: "nas.offlined",
  SkillSubmitted: "skill.submitted",
  SkillPublished: "skill.published",
  SkillDeprecated: "skill.deprecated",
  SkillInstalled: "skill.installed",
  SkillUpdated: "skill.updated",
  SkillPackageReplaced: "skill.package_replaced",
  AgentRegistered: "agent.registered",
  AgentOnlined: "agent.onlined",
  AgentOfflined: "agent.offlined",
  AppRegistered: "app.registered",
  AppOnlined: "app.onlined",
  AppOfflined: "app.offlined",
  AppUpdated: "app.updated",
  AppArchived: "app.archived",
  OidcAuthorizeGranted: "oidc.authorize.granted",
  OidcAuthorizeDenied: "oidc.authorize.denied",
  EntryTicketRedeemed: "authn.entryticket.redeemed",
  ApprovalCreated: "approval.created",
  ApprovalDecided: "approval.decided",
  AlertFired: "audit.alert.fired",
  ConnectorSynced: "iam.connector.synced",
  PluginSubmitted: "market.plugin.submitted",
  PluginListed: "market.plugin.listed",
  PluginInstalledEvent: "market.plugin.installed",
  WalletChanged: "wallet.balance.changed",
  LedgerSettled: "billing.ledger.settled",
  ConnectCodeCreated: "connect.code.created",
  ConnectClientEnrolled: "connect.client.enrolled",
  ConnectClientDisabled: "connect.client.disabled",
  UpdateAvailable: "platform.update.available",
  UpdateApplied: "platform.update.applied",
  // 前端行为埋点（WP-03/D3）：独立于 usage 计量管道，audit/看板订阅
  BehaviorRecorded: "behavior.recorded",
  // 部门面板（plugin-panel-core）：消息/任务/行业激活 + 场景图谱热刷新（review-dsh-agent-panel-v2）
  PanelMessageCreated: "panel.message.created",
  PanelCardAction: "panel.card.action",
  PanelTaskUpdated: "panel.task.updated",
  PanelIndustryActivated: "panel.industry.activated",
  ScenegraphUpdated: "scenegraph.updated",
  // 钉钉桥接（plugin-dingtalk-bridge）：出向投递回执（面板据此更新 ddSync 状态）
  DingtalkDelivered: "dingtalk-bridge.delivered"
};
const PLATFORM_RESERVED_PREFIXES = [
  "iam.",
  "authn.",
  "oidc.",
  "mcp.",
  "nas.",
  "audit.",
  "skill.",
  "agent.",
  "app.",
  "usage.",
  "billing.",
  "model.",
  "market.",
  "developer.",
  "wallet.",
  "platform.",
  "approval.",
  "connector.",
  "console.",
  "connect.",
  "behavior.",
  // 部门面板 / 场景图谱 / 钉钉桥接（review-dsh-agent-panel-v2 Phase 0）
  "panel.",
  "scenegraph.",
  "dingtalk-bridge."
];
class PlatformBusService extends Service {
  static provide = "platformBus";
  listeners = /* @__PURE__ */ new Map();
  wildcard = /* @__PURE__ */ new Set();
  seq = 0;
  ring = [];
  constructor(ctx) {
    super(ctx, "platformBus");
  }
  on(event, cb) {
    const set = this.listeners.get(event) ?? /* @__PURE__ */ new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => set.delete(cb);
  }
  onAny(cb) {
    this.wildcard.add(cb);
    return () => this.wildcard.delete(cb);
  }
  emit(name, payload, options = {}) {
    const source = options.source;
    if (source !== void 0 && source.startsWith("plugin:")) {
      if (!name.startsWith(`${source}:`)) {
        throw new Error(`[bus] \u63D2\u4EF6 ${source} \u4E0D\u5F97\u53D1\u5C04\u975E\u81EA\u6709\u547D\u540D\u7A7A\u95F4\u4E8B\u4EF6\uFF1A${name}\uFF08\u5141\u8BB8\u524D\u7F00 ${source}:\uFF09`);
      }
      if (PLATFORM_RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        throw new Error(`[bus] \u63D2\u4EF6 ${source} \u4E0D\u5F97\u53D1\u5C04\u5E73\u53F0\u4FDD\u7559\u547D\u540D\u7A7A\u95F4\u4E8B\u4EF6\uFF1A${name}`);
      }
    } else if (name.startsWith("plugin:")) {
      const pluginId = name.slice(0, name.indexOf(":", 8) === -1 ? name.length : name.indexOf(":", 8));
      throw new Error(`[bus] \u63D2\u4EF6\u547D\u540D\u7A7A\u95F4\u4E8B\u4EF6 ${name} \u5FC5\u987B\u643A\u5E26\u6765\u6E90\uFF08source: plugin:\u2026\uFF0C\u671F\u671B ${pluginId}\uFF09`);
    }
    const event = { id: ++this.seq, name, payload, at: (/* @__PURE__ */ new Date()).toISOString(), ...source !== void 0 ? { source } : {} };
    this.ring.push(event);
    if (this.ring.length > 300) this.ring.shift();
    for (const cb of this.listeners.get(name) ?? []) {
      try {
        cb(payload, event);
      } catch (error) {
        console.error(`[bus] \u76D1\u542C\u5668\u5904\u7406 ${name} \u5F02\u5E38`, error);
      }
    }
    for (const cb of this.wildcard) {
      try {
        cb(payload, event);
      } catch (error) {
        console.error(`[bus] \u901A\u914D\u76D1\u542C\u5668\u5904\u7406 ${name} \u5F02\u5E38`, error);
      }
    }
    return event;
  }
  /** 最近事件（平台事件流展示用）。 */
  recent(limit = 50) {
    return this.ring.slice(-limit).reverse();
  }
}
export {
  PlatformBusService,
  PlatformEvents
};
