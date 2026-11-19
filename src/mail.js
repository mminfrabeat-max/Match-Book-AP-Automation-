// Mail Agent + Teams notifications. Every message an agent wants to send lands in the outbox first.
// Delivery: Teams via an incoming-webhook URL (TEAMS_WEBHOOK_URL) when set; e-mail is recorded as a draft
// (sending through Microsoft Graph is a later step). Nothing is sent to vendors without the AP team.
import * as people from "./people.js";

export function init(state) { state.outbox ??= []; state.mailSeq ??= 0; }

const DEDUP_HOURS = 20, OUTBOX_MAX = 3000;
export function queue(state, msg) {
  const to = [].concat(msg.to).filter(Boolean);
  const m = { id: `MSG-${String(++state.mailSeq).padStart(4, "0")}`, at: new Date().toISOString(), channel: msg.channel || "Teams", to,
    toNames: to.map(t => (t.includes("@") ? t : people.name(t))), subject: msg.subject || "", text: msg.text, ref: msg.ref || null, agent: msg.agent || "Mail Agent",
    status: "QUEUED" };
  // de-duplicate monitor alerts: the same message to the same people within DEDUP_HOURS stays one message;
  // after that it goes out again as a reminder
  const since = Date.now() - DEDUP_HOURS * 3600_000;
  const dup = state.outbox.find(x => Date.parse(x.at) >= since && x.subject === m.subject && x.channel === m.channel && x.to.join() === m.to.join() && x.text === m.text);
  if (dup) return dup;
  state.outbox.unshift(m);
  if (state.outbox.length > OUTBOX_MAX) state.outbox.length = OUTBOX_MAX;      // oldest messages drop off
  if (m.channel.startsWith("Teams") && process.env.TEAMS_WEBHOOK_URL) { m.status = "SENDING TO TEAMS"; postTeams(m); }
  else if (m.channel.startsWith("Teams")) m.status = "SHOWN IN APP";
  else m.status = "DRAFT";
  return m;
}

// ---------- Teams: Adaptive Card, posted through a Teams "Workflows" webhook (or a classic incoming webhook) ----------
let app = { name: "Match Book", url: "http://localhost:3100" };
export function configure(o) { app = { ...app, ...o }; }

export function teamsCard(m) {
  const link = `${app.url}/#${m.ref?.invoice ? "invoices" : "messages"}`;
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
        body: [
          { type: "TextBlock", text: app.name, size: "Small", weight: "Bolder", color: "Accent", spacing: "None" },
          { type: "TextBlock", text: m.subject || m.agent, size: "Medium", weight: "Bolder", wrap: true },
          { type: "TextBlock", text: m.text, wrap: true, spacing: "Small" },
          { type: "FactSet", facts: [{ title: "For", value: m.toNames.join(", ") || "-" }, { title: "From", value: m.agent },
            ...(m.ref?.invoice ? [{ title: "Invoice", value: m.ref.invoice }] : []), { title: "When", value: new Date(m.at).toLocaleString("en-IN") }] },
        ],
        actions: [{ type: "Action.OpenUrl", title: `Open in ${app.name}`, url: link }],
      },
    }],
  };
}

// posts one at a time with a short gap, so a burst of alerts does not hit the workflow's throttling
let chain = Promise.resolve();
export function postTeams(m, url = process.env.TEAMS_WEBHOOK_URL) {
  chain = chain.then(async () => {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(teamsCard(m)), signal: AbortSignal.timeout(20_000) });
      m.status = res.ok ? "SENT TO TEAMS" : `TEAMS ERROR ${res.status}`;
      if (!res.ok) m.error = (await res.text().catch(() => "")).slice(0, 200);
    } catch (e) { m.status = "TEAMS ERROR"; m.error = e.message; }
    await new Promise(r => setTimeout(r, 1200));
  });
  return chain;
}

export function markSent(state, id) {
  const m = state.outbox.find(x => x.id === id);
  if (!m) throw new Error("No such message");
  m.status = "SENT (marked by user)"; m.sentAt = new Date().toISOString();
  return m;
}
