const CONSOLE_BASE = "/gate01";
const FEEDBACK_ENDPOINT = `${CONSOLE_BASE}/api/usage/feedback`;
const SLOT_TOOLVIEW = "tool.call.toolview";
const SLOT_ASSISTANT_ACTIONS = "conversation.chat.assistant-actions";
const SLOT_OVERLAY = "shell.overlay";
const SLOT_SETTINGS = "settings.section";
const SLOT_VIEW = "conversation.view";
const LINK_ENDPOINT = `${CONSOLE_BASE}/rqcard/link`;
const PANEL_URL = `${CONSOLE_BASE}/panel/`;
const PANEL_EMBED_URL = `${PANEL_URL}?embed=1`;
const RQCARD_CALL_HEADER = "x-rqcard-call";
const FEEDBACK_ENTRY_ID = "rq-feedback";
const TOOLVIEW_ENTRY_PREFIX = "rq-tool-";
const DEGRADED_BADGE_ID = "rq-card-degraded";
const UNLINKED_BADGE_ID = "rq-card-unlinked";
export {
  CONSOLE_BASE,
  DEGRADED_BADGE_ID,
  FEEDBACK_ENDPOINT,
  FEEDBACK_ENTRY_ID,
  LINK_ENDPOINT,
  PANEL_EMBED_URL,
  PANEL_URL,
  RQCARD_CALL_HEADER,
  SLOT_ASSISTANT_ACTIONS,
  SLOT_OVERLAY,
  SLOT_SETTINGS,
  SLOT_TOOLVIEW,
  SLOT_VIEW,
  TOOLVIEW_ENTRY_PREFIX,
  UNLINKED_BADGE_ID
};
