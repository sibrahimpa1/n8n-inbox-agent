// The whole workflow run as one function, for the live demo. It calls the same
// core.js functions the n8n Code nodes call, in the same order; tests/test_parity.py
// checks it against a replay of workflow/inbox-agent.json.
(function (root) {
  "use strict";
  var C = typeof module !== "undefined" && module.exports ? require("./core.js") : root.InboxCore;

  var ROUTE_NODE = { orders: "Orders sheet: upsert", quotes: "HubSpot: create deal", support: "Helpdesk: create ticket",
    accounts: "AP inbox: append", review: "Review queue: append", error: "Error queue: append" };

  function runInbox(emails, recorded, world, opts) {
    opts = opts || {};
    var failures = opts.failures || {};
    var seen = [], pos = [], out = [];
    var sheet = JSON.parse(JSON.stringify(world.orders_sheet));
    emails.forEach(function (e) {
      var msg = C.normalize(e);
      var screen = C.prescreen(msg, seen, world);
      seen.push(msg.message_id);
      var path = ["Gmail Trigger", "Read Orders sheet", "Normalize", "Pre-screen", "Needs the model?"];
      if (screen.action !== "continue") {
        path.push("Archive or skip");
        out.push({ id: e.id, msg: msg, screen: screen, route: screen.action === "archive" ? "archived" : "skipped", path: path, issues: [], flags: [screen.reason], draft: null });
        return;
      }
      var rec = recorded[e.id];
      var attempts = { "Claude: read email": rec && !rec.error ? 1 : 3 };
      var model = rec ? rec : { error: "model reply was not valid JSON" };
      path.push("Claude: read email", "Decide", "Route");
      var known = sheet.concat(pos.filter(function (p) { return !sheet.some(function (r) { return r.po === p.po; }); }));
      var d = C.decide(msg, screen, model, { orders: known }, world);
      if (d.route === "orders" && !d.duplicate) pos.push({ po: d.record.key, status: "New" });
      var node = ROUTE_NODE[d.route];
      if (node) path.push(node);
      var fail = failures[node + "|" + msg.message_id] || 0;
      if (fail) attempts[node] = Math.min(fail + 1, 3);
      if (fail >= 3) { d.issues.push(node + ": HTTP 429"); d.route = "error"; d.draft = null; path.push("Error queue: append"); }
      if (d.draft && ["orders", "quotes", "support", "status"].indexOf(d.route) >= 0) path.push("Has a draft?", "Gmail: save draft");
      else if (["orders", "quotes", "support", "status"].indexOf(d.route) >= 0) path.push("Has a draft?");
      out.push(Object.assign({ msg: msg, screen: screen, path: path, attempts: attempts }, d));
    });
    return out;
  }

  var api = { runInbox: runInbox, ROUTE_NODE: ROUTE_NODE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.InboxPipeline = api;
})(this);
