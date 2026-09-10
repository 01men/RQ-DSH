import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "../../../platform-core/dist/ids.js";
const DEPT_META = [
  { id: "rd", label: "\u7814\u53D1\u90E8", icon: "\u{1F52C}", theme: "\u6DF1\u7A7A\u84DD \xB7 \u9879\u76EE\u5DE5\u7A0B\u98CE", collab: "\u4EFB\u52A1\u9A71\u52A8 \xB7 \u8BC4\u5BA1\u534F\u540C", acts: ["rd"], colors: { accent: "#4f46e5", soft: "#e0e7ff", deep: "#3730a3" } },
  { id: "mfg", label: "\u5236\u9020\u90E8", icon: "\u{1F3ED}", theme: "\u5DE5\u4E1A\u9752 \xB7 \u4EA7\u7EBF\u5B9E\u65F6\u98CE", collab: "\u5F02\u5E38\u9A71\u52A8 \xB7 \u5DE5\u5355\u95ED\u73AF", acts: ["mfg", "scm"], colors: { accent: "#0f766e", soft: "#ccfbf1", deep: "#115e59" } },
  { id: "sales", label: "\u9500\u552E\u90E8", icon: "\u{1F4BC}", theme: "\u6696\u9633\u6A59 \xB7 \u8D62\u5355\u4F5C\u6218\u98CE", collab: "\u5BA2\u6237\u9A71\u52A8 \xB7 \u670D\u52A1\u4E00\u4F53", acts: ["svc", "mkt"], colors: { accent: "#ea580c", soft: "#ffedd5", deep: "#9a3412" } },
  { id: "strategy", label: "\u6218\u7565\u90E8", icon: "\u{1F9ED}", theme: "\u6DF1\u7D2B \xB7 \u6D1E\u5BDF\u7814\u5224\u98CE", collab: "\u60C5\u62A5\u9A71\u52A8 \xB7 \u7814\u5224\u5171\u521B", acts: ["mgmt"], colors: { accent: "#7c3aed", soft: "#ede9fe", deep: "#5b21b6" } },
  { id: "fin", label: "\u8D22\u52A1\u90E8", icon: "\u{1F4B3}", theme: "\u58A8\u7EFF\u91D1 \xB7 \u4E25\u8C28\u5408\u89C4\u98CE", collab: "\u6D41\u7A0B\u9A71\u52A8 \xB7 \u5BA1\u6279\u7559\u75D5", acts: ["fin"], colors: { accent: "#047857", soft: "#d1fae5", deep: "#064e3b" } }
];
function mapOps(labels) {
  return labels.map((label, index) => {
    const style = label.includes("\u9489\u9489") ? "dd" : "primary";
    let action = "ack";
    if (/生成任务卡|确认派单|确认返修|拉评审会|生成申报方案|生成专项报告|查看进度|发起调整流程|生成诊断/.test(label)) action = "task.create";
    else if (/提交审批|推送钉钉卡片审批|推送客户钉钉|推送钉钉给/.test(label)) action = "approval.request";
    else if (/推送钉钉卡片$/.test(label)) action = "dd.push";
    return { id: `op${index + 1}`, label, style, action, ...action === "approval.request" ? { risk: "high" } : {} };
  });
}
const DEMO_ORG_ID = "demo-org";
function seedPanel(ctx, autoDemo = false) {
  const logger = ctx.logger("panel-seed");
  if (ctx.panel.deptConfigs().count() > 0) {
    if (autoDemo) seedDemoContent(ctx, logger);
    return;
  }
  const iam = ctx.reflect.get("iam", false);
  for (const meta of DEPT_META) {
    const matchedOrg = iam?.orgs().findOne((org) => org.name === meta.label);
    ctx.panel.deptConfigs().insert({ id: meta.id, ...meta, agents: [], kpis: [], widgets: [], ...matchedOrg ? { orgId: matchedOrg.id } : {} });
  }
  const rootOrg = iam?.orgs().find((org) => org.parentId === null).at(0) ?? (autoDemo ? { id: DEMO_ORG_ID } : void 0);
  if (rootOrg) seedActivations(ctx, rootOrg.id);
  logger.info("\u9762\u677F\u57FA\u7EBF\uFF1A\u4E94\u90E8\u95E8\u9AA8\u67B6 + \u5185\u7F6E\u884C\u4E1A\u6FC0\u6D3B\uFF08QB01/GCJX\uFF09\u5B8C\u6210");
  if (process.env.DEMO_SEED !== "1" && !autoDemo) return;
  seedDemoContent(ctx, logger);
}
function seedActivations(ctx, orgId) {
  for (const code of ["QB01", "GCJX"]) {
    if (ctx.panel.activations().findOne((item) => item.orgId === orgId && item.code === code)) continue;
    ctx.panel.activations().insert({
      id: newId("act"),
      code,
      orgId,
      status: "active",
      activatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      activatedBy: "seed\uFF08\u5185\u7F6E\u8D44\u4EA7\u5305\u9ED8\u8BA4\u6388\u6743\uFF09"
    });
  }
}
function seedDemoContent(ctx, logger) {
  const demoPath = join(dirname(fileURLToPath(import.meta.url)), "demo-content.json");
  const demo = JSON.parse(readFileSync(demoPath, "utf8"));
  const iam = ctx.reflect.get("iam", false);
  const demoOrgId = iam?.orgs().find((org) => org.parentId === null).at(0)?.id ?? DEMO_ORG_ID;
  seedActivations(ctx, demoOrgId);
  for (const [deptId, content] of Object.entries(demo.depts)) {
    const config = ctx.panel.deptConfigs().get(deptId);
    if (!config) continue;
    const alreadySeeded = ctx.panel.channels().find((item) => item.dept === deptId).length > 0;
    if (config.agents.length === 0 && config.kpis.length === 0) {
      const agents = content.agents.map((agent) => ({
        name: agent.n,
        desc: agent.d,
        icon: agent.icon,
        ...agent.busy ? { busy: true } : {}
      }));
      const kpis = content.kpis.map(([label, value]) => ({ label, value, source: "mock" }));
      const widgets = content.widgets.map((widget, index) => ({
        id: `w${index + 1}`,
        type: widget.t,
        title: widget.title,
        ...widget.live ? { live: true } : {},
        // 治理硬性 DoD：演示看板全部带「模拟数据」来源徽标，绝不冒充真实业务面
        source: "mock",
        rows: widget.rows
      }));
      ctx.panel.deptConfigs().update(config.id, { agents, kpis, widgets });
    }
    if (alreadySeeded) continue;
    for (const [name] of content.chans) {
      ctx.panel.channels().insert({ id: newId("pchan"), dept: deptId, name, createdBy: "seed" });
    }
    const channels = ctx.panel.channels().find((item) => item.dept === deptId);
    const mainChannel = channels.at(0);
    for (const msg of content.msgs) {
      if (!mainChannel) break;
      const ddSync = msg.dd === "origin" ? "origin" : msg.dd === true ? "sent" : "none";
      const senderType = msg.t === "sys" ? "system" : msg.t === "agent" ? "agent" : "human";
      try {
        ctx.panel.messages().insert({
          id: newId("pmsg"),
          channelId: mainChannel.id,
          dept: deptId,
          senderType,
          ...msg.n ? { senderName: msg.n } : {},
          ...msg.icon ? { senderIcon: msg.icon } : {},
          text: msg.x,
          mentions: [...msg.x.matchAll(/@([\p{L}\p{N}·]{2,20})/gu)].map((m) => m[1]),
          ...msg.card ? { card: { title: msg.card.t, ops: mapOps(msg.card.ops), done: [] } } : {},
          ddSync,
          agentName: senderType === "agent" ? msg.n : void 0
        });
      } catch (error) {
        logger.warn(`\u6F14\u793A\u6D88\u606F\u64AD\u79CD\u8DF3\u8FC7\uFF08${deptId}\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const demoTasks = [
      ["rd", "\u4F4E\u6E29\u542F\u52A8\u9700\u6C42\u62C6\u89E3\uFF08V2.5-REQ-018\uFF09", "doing", "QB01-B-1-1"],
      ["rd", "!482 \u7535\u673A\u9A71\u52A8\u8FC7\u6D41\u4FDD\u62A4\u8BC4\u5BA1", "review"],
      ["mfg", "WO-2611 \u98CE\u6247\u7EC4\u4EF6 \xD73200", "doing"],
      ["mfg", "3# \u51B2\u5E8A\u6CB9\u6E29\u5F02\u5E38\u7EF4\u4FEE\u5DE5\u5355\uFF08WX-0912\uFF09", "todo", "QB01-A-2-5"],
      ["mfg", "M-2207 \u7269\u6599\u7F3A\u53E3\u8865\u9F50", "todo", "QB01-G-4-1"],
      ["sales", "QT-2689 \u5EF6\u4FDD\u6253\u5305\u7248\u62A5\u4EF7\u5BA1\u6279", "review"],
      ["sales", "SV-3318 \u51B0\u7BB1\u5F02\u54CD\u5DE5\u5355\u95ED\u73AF", "doing", "QB01-F-3-1"],
      ["strategy", "\u8BBE\u5907\u8054\u7F51\u7387 52%\u219260% Q4 \u4E13\u9879\u7ACB\u9879", "todo", "QB01-B-2-1"],
      ["strategy", "\u8BD5\u70B9\u7533\u62A5\u4E00\u9875\u7EB8\u7B80\u62A5\uFF08\u5468\u4E94\u7ECF\u8425\u4F1A\uFF09", "doing"],
      ["fin", "\u5236\u9020\u8D39\u7528\u644A\u9500\u8C03\u6574\u6D41\u7A0B", "review", "QB01-H-5-3"],
      ["fin", "8 \u5F20\u5355\u636E\u9884\u5BA1\u9000\u56DE\u590D\u6838", "todo"]
    ];
    for (const [dept, title, lane, sceneCode] of demoTasks) {
      if (dept !== deptId) continue;
      ctx.panel.tasks().insert({
        id: newId("ptask"),
        dept: deptId,
        title,
        lane,
        assigneeType: "human",
        ...sceneCode ? { sceneCode } : {},
        createdBy: "seed"
      });
    }
    const demoArtifacts = [
      ["rd", "diagnosis", "V2.5 \u4F4E\u6E29\u542F\u52A8\u9700\u6C42\u62C6\u89E3\u7EAA\u8981", "6 \u4EFB\u52A1 / 34 \u4EBA\u65E5 / \u5173\u952E\u8DEF\u5F84\u53EF\u9760\u6027\u8BD5\u9A8C 10 \u5929"],
      ["mfg", "order", "\u7EF4\u4FEE\u5DE5\u5355 WX-0912", "3# \u51B2\u5E8A\u6DB2\u538B\u6CB9\u6E29\u8D85\u9608\u503C\uFF1B\u5BF9\u5E94 QB01-A-2-5 \u5EFA\u8BAE\u5217\u5165\u6539\u9020\u6E05\u5355"],
      ["sales", "quote", "\u62A5\u4EF7\u5355 QT-2688 / QT-2689", "\u6807\u51C6\u7248 \xA5118\u4E07\uFF08\u6BDB\u5229 31.2%\uFF09\xB7 \u5EF6\u4FDD\u6253\u5305\u7248 \xA5128\u4E07\uFF08\u6BDB\u5229 33.5%\uFF09"],
      ["strategy", "report", "\u653F\u7B56\u7533\u62A5\u53EF\u884C\u6027\u521D\u5224", "\u5339\u914D\u5EA6 92%\uFF1B\u7F3A\u53E3\uFF1A\u8BBE\u5907\u8054\u7F51\u7387 52%\u219260%\uFF1B\u6295\u5165\u4EA7\u51FA\u6BD4 1:2.4"],
      ["fin", "report", "\u9884\u7B97\u504F\u5DEE\u5206\u6790 \xB7 \u5236\u9020\u8D39\u7528", "78% \u6267\u884C\u9886\u5148\u8FDB\u5EA6 10pp\uFF1B\u4E3B\u56E0 8 \u6708\u8BBE\u5907\u5927\u4FEE\u4E00\u6B21\u6027\u8BA1\u5165 \xA556 \u4E07"]
    ];
    for (const [dept, kind, title, contentText] of demoArtifacts) {
      if (dept !== deptId) continue;
      ctx.panel.artifacts().insert({
        id: newId("part"),
        dept: deptId,
        kind,
        title,
        content: contentText ?? "",
        createdBy: "seed"
      });
    }
  }
  logger.info("\u9762\u677F\u6F14\u793A\u6570\u636E\u521D\u59CB\u5316\u5B8C\u6210\uFF08\u4E94\u90E8\u95E8\u9891\u9053/\u4F1A\u8BDD/\u4EFB\u52A1/\u77E5\u8BC6/\u770B\u677F\uFF09");
}
export {
  DEMO_ORG_ID,
  seedPanel
};
