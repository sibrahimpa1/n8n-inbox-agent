"""Builds workflow/inbox-agent.json, the n8n workflow you import.

The Code nodes get src/core.js pasted in, so the logic the tests and the demo
run is byte-for-byte the logic n8n runs. Settings (customers, products,
thresholds) are injected as a constant; in production, replace that with a
lookup against your CRM and price list.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = (ROOT / "src" / "core.js").read_text()
OUT = ROOT / "workflow" / "inbox-agent.json"

MODEL = "claude-opus-5-5"


def world_config():
    w = json.loads((ROOT / "data" / "world.json").read_text())
    return {k: w[k] for k in ("company", "customers", "suppliers", "products", "settings")}


def code(body, world=False):
    head = "// ---- src/core.js (generated, edit there) ----\n" + CORE + "\n// ---- node logic ----\n"
    if world:
        head += "const WORLD = " + json.dumps(world_config(), indent=1) + ";\n"
    return head + body


NORMALIZE = """
// Accepts the Gmail Trigger's output (simple: false) or the replay fixtures.
return $('Gmail Trigger').all().map((item) => {
  const j = item.json;
  const email = j.from && j.from.text ? {
    id: j.id, message_id: j.messageId, from: j.from.text, subject: j.subject, received: j.date,
    text: j.text || '', headers: j.headers || {},
    attachments: (j.attachmentTexts || []),
  } : j;
  return { json: normalize(email) };
});
"""

PRESCREEN = """
const state = $getWorkflowStaticData('global');
state.seen = state.seen || [];
const out = [];
for (const item of $input.all()) {
  const msg = item.json;
  const screen = prescreen(msg, state.seen, WORLD);
  state.seen.push(msg.message_id);
  if (state.seen.length > 5000) state.seen = state.seen.slice(-5000);
  out.push({ json: Object.assign({}, msg, { screen }) });
}
return out;
"""

DECIDE = """
// The sheet was read when this run started; POs logged earlier in the same run
// are remembered too, so a PO resent minutes later is not confirmed twice.
const state = $getWorkflowStaticData('global');
state.pos = state.pos || [];
const sheet = $('Read Orders sheet').all().map((i) => i.json);
return $input.all().map((item, i) => {
  const orders = sheet.concat(state.pos.filter((p) => !sheet.some((r) => r.po === p.po)));
  const msg = $('Pre-screen').itemMatching(i).json;
  let model;
  if (item.json.error) model = { error: String(item.json.error.message || item.json.error) };
  else {
    try { model = JSON.parse(item.json.content[0].text); }
    catch (e) { model = { error: 'model reply was not valid JSON' }; }
  }
  const d = decide(msg, msg.screen, model, { orders }, WORLD);
  if (d.route === 'orders' && !d.duplicate) state.pos.push({ po: d.record.key, status: 'New' });
  return { json: Object.assign({ message_id: msg.message_id, sender: msg.sender, subject: msg.subject }, d) };
});
"""

SYSTEM = ("You read one email sent to a dental supply distributor's shared inbox. Classify it as purchase_order, "
          "quote_request, support, order_status, invoice, payment_change or other, give a confidence from 0 to 1, "
          "extract the fields for that type exactly as written (never guess prices or dates), and draft a short, "
          "friendly reply that uses only facts in the email. Never offer discounts or promise delivery dates.")

SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["type", "confidence", "summary", "fields", "reply"],
    "properties": {
        "type": {"enum": ["purchase_order", "quote_request", "support", "order_status", "invoice", "payment_change", "other"]},
        "confidence": {"type": "number"}, "summary": {"type": "string"},
        "fields": {"type": "object"}, "reply": {"type": ["string", "null"]},
    },
}


def node(name, type_, pos, params, version=1, **extra):
    n = {"id": name.lower().replace(" ", "-").replace(":", "").replace("?", ""), "name": name, "type": type_,
         "typeVersion": version, "position": pos, "parameters": params}
    n.update(extra)
    return n


def cond(left, right):
    return {"conditions": {"options": {"caseSensitive": True, "typeValidation": "strict"}, "combinator": "and",
                           "conditions": [{"leftValue": left, "rightValue": right,
                                           "operator": {"type": "string", "operation": "equals"}}]}}


ROUTES = ["orders", "quotes", "support", "status", "accounts", "review", "error"]


def build():
    body = ("={{ JSON.stringify({ model: '" + MODEL + "', max_tokens: 1200, system: " + json.dumps(SYSTEM) +
            ", output_config: { effort: 'low', format: { type: 'json_schema', schema: " + json.dumps(SCHEMA) + " } },"
            " messages: [{ role: 'user', content: 'From: ' + $json.from + '\\nSubject: ' + $json.subject + '\\n\\n' + $json.text"
            " + $json.attachments.map(a => '\\n\\n[Attachment ' + a.name + ']\\n' + a.text).join('') }] }) }}")
    nodes = [
        node("Gmail Trigger", "n8n-nodes-base.gmailTrigger", [0, 300],
             {"pollTimes": {"item": [{"mode": "everyMinute"}]}, "simple": False, "filters": {"labelIds": ["INBOX"]},
              "options": {"downloadAttachments": True}}, 1.2, credentials={"gmailOAuth2": {"id": "GMAIL", "name": "Shared inbox"}}),
        node("Read Orders sheet", "n8n-nodes-base.googleSheets", [220, 300],
             {"operation": "read", "documentId": {"__rl": True, "mode": "id", "value": "ORDERS_SHEET_ID"},
              "sheetName": {"__rl": True, "mode": "name", "value": "Orders"}}, 4.5, executeOnce=True, alwaysOutputData=True,
             credentials={"googleSheetsOAuth2Api": {"id": "SHEETS", "name": "Ops sheets"}}),
        node("Normalize", "n8n-nodes-base.code", [440, 300], {"jsCode": code(NORMALIZE)}, 2),
        node("Pre-screen", "n8n-nodes-base.code", [660, 300], {"jsCode": code(PRESCREEN, world=True)}, 2),
        node("Needs the model?", "n8n-nodes-base.if", [880, 300], cond("={{ $json.screen.action }}", "continue"), 2.2),
        node("Archive or skip", "n8n-nodes-base.gmail", [1100, 520],
             {"operation": "addLabels", "messageId": "={{ $json.id }}", "labelIds": ["Label_Skipped"]}, 2.1,
             credentials={"gmailOAuth2": {"id": "GMAIL", "name": "Shared inbox"}}),
        node("Claude: read email", "n8n-nodes-base.httpRequest", [1100, 300],
             {"method": "POST", "url": "https://api.anthropic.com/v1/messages", "authentication": "genericCredentialType",
              "genericAuthType": "httpHeaderAuth", "sendHeaders": True,
              "headerParameters": {"parameters": [{"name": "anthropic-version", "value": "2023-06-01"},
                                                   {"name": "anthropic-beta", "value": "server-side-fallback-2026-07-01"}]},
              "sendBody": True, "specifyBody": "json", "jsonBody": body, "options": {"timeout": 60000}}, 4.2,
             retryOnFail=True, maxTries=3, waitBetweenTries=2000, onError="continueErrorOutput",
             credentials={"httpHeaderAuth": {"id": "ANTHROPIC", "name": "Anthropic API key (x-api-key)"}}),
        node("Decide", "n8n-nodes-base.code", [1320, 300], {"jsCode": code(DECIDE, world=True)}, 2),
        node("Route", "n8n-nodes-base.switch", [1540, 300],
             {"rules": {"values": [dict(cond("={{ $json.route }}", r), renameOutput=True, outputKey=r) for r in ROUTES]},
              "options": {"fallbackOutput": "none"}}, 3.2),
        node("Orders sheet: upsert", "n8n-nodes-base.googleSheets", [1780, 0],
             {"operation": "appendOrUpdate", "documentId": {"__rl": True, "mode": "id", "value": "ORDERS_SHEET_ID"},
              "sheetName": {"__rl": True, "mode": "name", "value": "Orders"},
              "columns": {"mappingMode": "defineBelow", "matchingColumns": ["po"],
                          "value": {c: "={{ $json.record.row." + c + " }}" for c in ("po", "customer", "total", "lines", "requested", "status", "source")}}},
             4.5, retryOnFail=True, maxTries=3, waitBetweenTries=1500, onError="continueErrorOutput",
             credentials={"googleSheetsOAuth2Api": {"id": "SHEETS", "name": "Ops sheets"}}),
        node("HubSpot: create deal", "n8n-nodes-base.hubspot", [1780, 140],
             {"resource": "deal", "operation": "create", "stage": "appointmentscheduled",
              "additionalFields": {"dealName": "={{ $json.record.row.name }}", "amount": "={{ $json.record.row.amount }}"}}, 2.1,
             retryOnFail=True, maxTries=3, onError="continueErrorOutput",
             credentials={"hubspotOAuth2Api": {"id": "HUBSPOT", "name": "HubSpot"}}),
        node("Helpdesk: create ticket", "n8n-nodes-base.httpRequest", [1780, 280],
             {"method": "POST", "url": "https://helpdesk.example/api/tickets", "sendBody": True, "specifyBody": "json",
              "jsonBody": "={{ JSON.stringify($json.record.row) }}"}, 4.2, retryOnFail=True, maxTries=3, onError="continueErrorOutput"),
        node("AP inbox: append", "n8n-nodes-base.googleSheets", [1780, 560],
             {"operation": "append", "documentId": {"__rl": True, "mode": "id", "value": "ORDERS_SHEET_ID"},
              "sheetName": {"__rl": True, "mode": "name", "value": "AP inbox"},
              "columns": {"mappingMode": "defineBelow",
                          "value": {c: "={{ $json.record.row." + c + " }}" for c in ("invoice", "supplier", "amount", "due")}}}, 4.5,
             credentials={"googleSheetsOAuth2Api": {"id": "SHEETS", "name": "Ops sheets"}}),
        node("Review queue: append", "n8n-nodes-base.googleSheets", [1780, 700],
             {"operation": "append", "documentId": {"__rl": True, "mode": "id", "value": "ORDERS_SHEET_ID"},
              "sheetName": {"__rl": True, "mode": "name", "value": "Review"},
              "columns": {"mappingMode": "defineBelow",
                          "value": {"message_id": "={{ $json.message_id }}", "from": "={{ $json.sender }}", "subject": "={{ $json.subject }}",
                                    "why": "={{ $json.issues.join('; ') }}"}}}, 4.5,
             credentials={"googleSheetsOAuth2Api": {"id": "SHEETS", "name": "Ops sheets"}}),
        node("Error queue: append", "n8n-nodes-base.googleSheets", [1780, 860],
             {"operation": "append", "documentId": {"__rl": True, "mode": "id", "value": "ORDERS_SHEET_ID"},
              "sheetName": {"__rl": True, "mode": "name", "value": "Errors"},
              "columns": {"mappingMode": "defineBelow",
                          "value": {"message_id": "={{ $json.message_id }}", "error": "={{ $json.issues ? $json.issues.join('; ') : $json.error.message }}"}}}, 4.5,
             credentials={"googleSheetsOAuth2Api": {"id": "SHEETS", "name": "Ops sheets"}}),
        node("Has a draft?", "n8n-nodes-base.if", [2020, 200], cond("={{ $json.draft ? 'yes' : 'no' }}", "yes"), 2.2),
        node("Gmail: save draft", "n8n-nodes-base.gmail", [2240, 200],
             {"resource": "draft", "operation": "create", "subject": "={{ $json.draft.subject }}", "message": "={{ $json.draft.text }}",
              "options": {"sendTo": "={{ $json.draft.to }}", "threadId": "={{ $json.message_id }}"}}, 2.1,
             credentials={"gmailOAuth2": {"id": "GMAIL", "name": "Shared inbox"}}),
    ]

    def to(*names):
        return [[{"node": n, "type": "main", "index": 0} for n in names]]

    conn = {
        "Gmail Trigger": {"main": to("Read Orders sheet")},
        "Read Orders sheet": {"main": to("Normalize")},
        "Normalize": {"main": to("Pre-screen")},
        "Pre-screen": {"main": to("Needs the model?")},
        "Needs the model?": {"main": to("Claude: read email") + to("Archive or skip")},
        "Claude: read email": {"main": to("Decide") + to("Decide")},  # error output still decides (route: error)
        "Decide": {"main": to("Route")},
        "Route": {"main": to("Orders sheet: upsert") + to("HubSpot: create deal") + to("Helpdesk: create ticket")
                  + to("Has a draft?") + to("AP inbox: append") + to("Review queue: append") + to("Error queue: append")},
        "Orders sheet: upsert": {"main": to("Has a draft?") + to("Error queue: append")},
        "HubSpot: create deal": {"main": to("Has a draft?") + to("Error queue: append")},
        "Helpdesk: create ticket": {"main": to("Has a draft?") + to("Error queue: append")},
        "Has a draft?": {"main": to("Gmail: save draft") + [[]]},
    }
    wf = {"name": "Shared inbox agent (orders@)", "nodes": nodes, "connections": conn, "active": False,
          "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "Europe/Berlin"},
          "pinData": {}, "meta": {"templateCredsSetupCompleted": False},
          "tags": [{"name": "inbox"}, {"name": "claude"}]}
    OUT.write_text(json.dumps(wf, indent=2) + "\n")
    return wf


if __name__ == "__main__":
    build()
    print(f"wrote {OUT.relative_to(ROOT)}")
