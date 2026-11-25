(function () {
  "use strict";
  var D = window.MAILROOM, C = window.InboxCore, P = window.InboxPipeline;
  var W0 = D.world;
  var USERS = W0.users;
  var ROUTES = {
    orders: ["Orders", "#0f5257"], quotes: ["Quotes", "#4a3a8c"], support: ["Support", "#e8701a"], status: ["Order status", "#2c5e8a"],
    accounts: ["Accounts", "#8a7428"], review: ["Needs a person", "#6b2d5c"], error: ["Errors", "#b23a2b"],
    done: ["No action", "#9a968c"], archived: ["Archived", "#9a968c"], skipped: ["Skipped", "#9a968c"],
  };
  var S = {
    as: "mia", settings: JSON.parse(JSON.stringify(W0.settings)), overrides: {}, drafts: {}, resolved: {}, log: [],
    route: "inbox", folder: "all", mail: null, node: null, sheet: "Orders",
  };
  var R = [];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function $(s) { return document.querySelector(s); }
  function hhmm(iso) { return iso ? iso.slice(11, 16) : ""; }
  function fromName(f) { return String(f).split("<")[0].trim() || f; }
  function slug(n) { return n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
  function byId(id) { return R.filter(function (r) { return r.id === id; })[0]; }
  function email(id) { return D.emails.filter(function (e) { return e.id === id; })[0]; }
  function isLead() { return USERS[S.as].role === "lead"; }
  function toast(t) { var el = $("#toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.remove("show"); }, 2300); }
  function tag(route) { var r = ROUTES[route] || [route]; return '<span class="tag t-' + route + '">' + esc(r[0]) + "</span>"; }
  function log(what) { S.log.unshift({ who: USERS[S.as].name, what: what, at: new Date().toTimeString().slice(0, 5) }); }

  function compute() {
    var world = Object.assign({}, W0, { settings: S.settings });
    var rec = Object.assign({}, D.recorded, S.overrides);
    R = P.runInbox(D.emails, rec, world, { failures: D.failures });
    R.forEach(function (r) {
      if (r.draft && !S.drafts[r.id]) S.drafts[r.id] = { state: "awaiting approval", text: r.draft.text };
      if (r.draft && S.drafts[r.id] && S.drafts[r.id].base !== r.draft.text) { S.drafts[r.id].text = S.drafts[r.id].edited ? S.drafts[r.id].text : r.draft.text; S.drafts[r.id].base = r.draft.text; }
    });
  }

  function folderOf(r) { return r.route; }
  function inFolder(r, f) {
    if (f === "all") return true;
    if (f === "drafts") return r.draft && S.drafts[r.id] && S.drafts[r.id].state === "awaiting approval";
    if (f === "skipped") return r.route === "skipped" || r.route === "archived" || r.route === "done";
    return r.route === f;
  }

  // ---------- routing ----------
  function parse() {
    var h = location.hash.replace(/^#/, ""), q = "";
    if (h.indexOf("?") >= 0) { q = h.split("?")[1]; h = h.split("?")[0]; }
    var as = (q.match(/as=(\w+)/) || [])[1];
    if (as && USERS[as]) S.as = as;
    var p = (h || "inbox").split("/");
    S.route = p[0];
    if (p[0] === "inbox") { S.folder = p[1] || S.folder || "all"; S.mail = S.mail && inFolder(byId(S.mail), S.folder) ? S.mail : null; }
    if (p[0] === "mail") { S.route = "inbox"; S.mail = p[1]; if (!inFolder(byId(p[1]), S.folder)) S.folder = "all"; }
    if (p[0] === "node") { S.route = "workflow"; S.node = p.slice(1).join("/"); }
    if (p[0] === "workflow") S.node = S.node || null;
    if (p[0] === "sheets" && p[1]) S.sheet = decodeURIComponent(p[1]);
  }

  // ---------- top bar ----------
  function topbar() {
    var awaiting = R.filter(function (r) { return r.draft && S.drafts[r.id].state === "awaiting approval"; }).length;
    var review = R.filter(function (r) { return r.route === "review" && !S.resolved[r.id]; }).length;
    var errs = R.filter(function (r) { return r.route === "error"; }).length;
    var tabs = [["inbox", "Inbox"], ["approvals", "Approvals", awaiting], ["review", "Review", review], ["workflow", "Workflow"], ["sheets", "Sheets"], ["errors", "Errors", errs], ["evals", "Evals"], ["settings", "Settings"]];
    return '<header class="top"><div class="brand"><span class="stamp">@</span><div>Mailroom<small>' + esc(W0.inbox) + " · n8n + Claude</small></div></div><nav class=\"tabs\">" +
      tabs.map(function (t) { return '<a href="#' + t[0] + '" class="' + (S.route === t[0] ? "on" : "") + '">' + t[1] + (t[2] ? '<span class="n">' + t[2] + "</span>" : "") + "</a>"; }).join("") +
      '</nav><div class="who"><label for="as" class="sr">Signed in as</label><select id="as">' + Object.keys(USERS).map(function (u) {
        return '<option value="' + u + '"' + (u === S.as ? " selected" : "") + ">" + esc(USERS[u].name) + " · " + esc(USERS[u].title) + "</option>";
      }).join("") + "</select></div></header>";
  }

  // ---------- inbox ----------
  function inbox() {
    var folders = [["all", "All mail"], ["drafts", "Drafts to approve"], ["orders", "Orders"], ["quotes", "Quotes"], ["support", "Support"], ["status", "Order status"], ["accounts", "Accounts"], ["review", "Needs a person"], ["error", "Errors"], ["skipped", "Skipped & archived"]];
    var h = '<aside class="folders"><h4>' + esc(W0.inbox) + "</h4>" + folders.map(function (f) {
      var n = R.filter(function (r) { return inFolder(r, f[0]); }).length;
      var col = (ROUTES[f[0]] || [0, "#9a968c"])[1];
      return '<a href="#inbox/' + f[0] + '" class="' + (S.folder === f[0] ? "on" : "") + '"><span class="dot" style="background:' + (f[0] === "all" ? "#1b1f24" : f[0] === "drafts" ? "#2f7d4f" : col) + '"></span>' + f[1] + '<span class="c">' + n + "</span></a>";
    }).join("") + '<h4>Keys</h4><div class="small" style="padding:0 8px"><span class="kbd">j</span> <span class="kbd">k</span> next / previous<br><span class="kbd">a</span> approve draft<br><span class="kbd">g w</span> workflow</div></aside>';
    var list = R.filter(function (r) { return inFolder(r, S.folder); });
    h += '<div class="list" role="list">' + (list.length ? list.map(function (r) {
      var e = email(r.id), d = S.drafts[r.id];
      return '<a role="listitem" class="row' + (S.mail === r.id ? " on" : "") + '" href="#mail/' + r.id + '"><div class="r1"><span class="from">' + esc(fromName(e.from)) + '</span><span class="time">' + hhmm(e.received) + '</span></div><div class="subj">' + esc(e.subject) + '</div><div class="meta">' + tag(r.route) +
        (d && r.draft ? '<span class="tag t-draft">' + (d.state === "awaiting approval" ? "draft · " + r.draft.approver : d.state) + "</span>" : "") +
        (r.flags.some(function (f) { return /imitates|removed/.test(f); }) ? '<span class="tag t-flag">security</span>' : "") + "</div></a>";
    }).join("") : '<div class="empty"><h2>Nothing here</h2><p>This folder is empty right now.</p></div>') + "</div>";
    h += '<section class="read">' + (S.mail ? mailView(byId(S.mail)) : '<div class="empty"><h2>Pick an email</h2><p>Every email that reached orders@ this morning, with what the n8n workflow did to it. Start with <a href="#mail/E-01">the first purchase order</a> or the <a href="#inbox/drafts">drafts waiting for approval</a>.</p></div>') + "</section>";
    return '<div class="body">' + h + "</div>";
  }

  function pathHtml(r) {
    return '<div class="path">' + r.path.map(function (n, i) {
      var tries = r.attempts && r.attempts[n] > 1 ? '<span class="retry"> ×' + r.attempts[n] + "</span>" : "";
      return (i ? '<span class="arr">→</span>' : "") + '<a href="#node/' + slug(n) + '">' + esc(n) + tries + "</a>";
    }).join("") + "</div>";
  }

  function fieldsHtml(r) {
    var rec = (Object.assign({}, D.recorded, S.overrides))[r.id];
    if (!rec || rec.error) return "";
    var f = rec.fields || {}, h = '<dl class="facts"><dt>Read as</dt><dd>' + esc(rec.type.replace("_", " ")) + " · confidence " + rec.confidence + "</dd><dt>Summary</dt><dd>" + esc(rec.summary) + "</dd>";
    ["po_number", "ship_to", "requested_date", "total", "issue", "urgency", "invoice_number", "amount", "due", "customer_ask"].forEach(function (k) {
      if (f[k] != null) h += "<dt>" + k.replace(/_/g, " ") + "</dt><dd>" + esc(f[k]) + "</dd>";
    });
    h += "</dl>";
    if (f.lines && f.lines.length) {
      h += '<table class="lines"><tr><th>SKU</th><th>Product</th><th>Qty</th><th>Price in email</th><th>Price list</th><th></th></tr>' + f.lines.map(function (l) {
        var p = W0.products[l.sku];
        var ok = p && (l.unit_price == null || Math.abs(l.unit_price - p.price) < 0.005);
        return "<tr><td>" + esc(l.sku) + "</td><td>" + esc(p ? p.name : "unknown product") + "</td><td>" + l.qty + "</td><td>" + (l.unit_price != null ? l.unit_price.toFixed(2) : "—") + "</td><td>" + (p ? p.price.toFixed(2) : "—") + '</td><td class="' + (ok ? "ok" : "bad") + '">' + (ok ? "✓" : "✗") + "</td></tr>";
      }).join("") + "</table>";
    }
    return h;
  }

  function draftHtml(r) {
    var d = S.drafts[r.id], dr = r.draft;
    var can = dr.approver === "agent" || isLead();
    var h = '<div class="draft"><div class="dh"><b>Draft reply</b><span>to ' + esc(dr.to) + "</span><span>· written by " + (dr.by === "model" ? "Claude, checked by code" : "a safe template") + "</span><span style=\"margin-left:auto\">" + (dr.approver === "lead" ? "needs the operations lead" : "any agent can approve") + "</span></div>";
    if (dr.rejected) h += '<div class="why">Claude\'s draft was replaced: it ' + esc(dr.rejected) + ".</div>";
    if (d.state === "awaiting approval") {
      h += '<textarea id="draft-text" aria-label="Draft reply">' + esc(d.text) + '</textarea><div class="act"><button class="btn go" data-approve="' + r.id + '" ' + (can ? "" : "disabled") + '>Approve and send</button><button class="btn" data-discard="' + r.id + '">Discard</button>' +
        (can ? "" : '<span class="small">Over EUR ' + S.settings.lead_approval_over + ": switch to Tom Haller (operations lead) to approve.</span>") + '<span class="small" style="margin-left:auto">Saved as a Gmail draft; nothing is sent until someone approves.</span></div>';
    } else {
      h += '<div style="padding:12px 14px;white-space:pre-wrap">' + esc(d.text) + '</div><div class="act"><span class="tag ' + (d.state === "sent" ? "t-draft" : "t-skipped") + '">' + esc(d.state) + "</span><span class=\"small\">" + esc(d.note || "") + "</span></div>";
    }
    return h + "</div>";
  }

  function mailView(r) {
    if (!r) return '<div class="empty"><h2>Not found</h2></div>';
    var e = email(r.id);
    var h = "<h1>" + esc(e.subject) + '</h1><div class="hdr">' + esc(e.from) + " · " + e.received.replace("T", " ").slice(0, 16) + " · " + tag(r.route) + (e.note ? " · " + esc(e.note) : "") + "</div>";
    h += '<div class="mail">' + esc(r.msg.text) + "</div>";
    (r.msg.attachments || []).forEach(function (a) { if (a.text) h += '<div class="att"><b>📎 ' + esc(a.name) + "</b>\n" + esc(a.text) + "</div>"; });
    h += '<div class="sec"><h3>Path through the workflow</h3>' + pathHtml(r) + "</div>";
    if (r.issues.length || r.flags.length) h += '<div class="sec"><h3>Why</h3>' + r.issues.map(function (i) { return '<div class="issue">' + esc(i) + "</div>"; }).join("") + r.flags.map(function (f) { return '<div class="flag">' + esc(f) + "</div>"; }).join("") + "</div>";
    var fh = fieldsHtml(r);
    if (fh) h += '<div class="sec"><h3>What Claude read, and what code checked</h3>' + fh + "</div>";
    if (r.record) {
      var where = r.record.sheet ? "Google Sheets · " + r.record.sheet : r.record.system + " · " + r.record.object;
      h += '<div class="sec"><h3>Written to ' + esc(where) + '</h3><div class="att">' + esc(JSON.stringify(r.record.row, null, 1)) + "</div></div>";
    }
    if (r.lookup) h += '<div class="sec"><h3>Looked up in the Orders sheet</h3><div class="att">' + esc(JSON.stringify(r.lookup, null, 1)) + "</div></div>";
    if (r.draft) h += '<div class="sec"><h3>Reply</h3>' + draftHtml(r) + "</div>";
    if (r.route === "review") h += '<div class="sec"><h3>Your call</h3>' + reviewActions(r) + "</div>";
    if (r.route === "error") h += '<div class="sec"><h3>Error queue</h3><div class="act"><button class="btn warn" data-retry="' + r.id + '">Retry now</button> <span class="small">The workflow already tried 3 times, 2 seconds apart.</span></div></div>';
    return h;
  }

  function reviewActions(r) {
    var done = S.resolved[r.id];
    if (done) return '<div class="flag" style="background:var(--green-soft);color:var(--green)">Handled by ' + esc(done.who) + ": " + esc(done.how) + "</div>";
    var spoof = r.flags.some(function (f) { return /imitates/.test(f); }) || /payment details/.test(r.issues.join(" "));
    return '<div class="row" style="display:flex;gap:8px;flex-wrap:wrap">' +
      (spoof ? '<button class="btn warn" data-resolve="' + r.id + '|Reported as phishing, sender blocked">Report as phishing</button>' : '<button class="btn go" data-resolve="' + r.id + '|Handled manually and replied">Handled, I replied myself</button>') +
      '<button class="btn" data-resolve="' + r.id + '|Asked the sender to resend">Ask sender to resend</button><button class="btn" data-resolve="' + r.id + '|No action needed">No action needed</button></div>' +
      (spoof ? '<p class="small">Lookalike senders and bank-detail changes can never be approved in the workflow. Verify by phone with a contact you already have.</p>' : "");
  }

  // ---------- approvals ----------
  function approvals() {
    var list = R.filter(function (r) { return r.draft; });
    var h = '<div class="page"><h2>Reply drafts</h2><p class="lede">The workflow never sends email. It saves each reply as a Gmail draft, and a person approves it here. Quotes and orders over EUR ' + S.settings.lead_approval_over + " need the operations lead. Drafts Claude wrote are checked by code first: any price, date or number that isn't in the order data, any discount and any delivery promise sends the draft back to a safe template.</p>";
    h += '<table class="t"><tr><th>Email</th><th>Route</th><th>Draft by</th><th>Approver</th><th>State</th><th></th></tr>' + list.map(function (r) {
      var d = S.drafts[r.id], e = email(r.id), can = r.draft.approver === "agent" || isLead();
      return '<tr><td><a href="#mail/' + r.id + '">' + esc(e.subject) + '</a><div class="small">' + esc(fromName(e.from)) + "</div></td><td>" + tag(r.route) + "</td><td>" + (r.draft.by === "model" ? "Claude" : "template" + (r.draft.rejected ? ' <span class="small">(' + esc(r.draft.rejected) + ")</span>" : "")) + "</td><td>" + (r.draft.approver === "lead" ? "Operations lead" : "Any agent") + "</td><td>" + esc(d.state) + "</td><td>" +
        (d.state === "awaiting approval" ? '<button class="btn go" data-approve="' + r.id + '" ' + (can ? "" : 'disabled title="Needs the operations lead"') + ">Approve and send</button>" : "") + "</td></tr>";
    }).join("") + "</table></div>";
    return h;
  }

  // ---------- review ----------
  function review() {
    var list = R.filter(function (r) { return r.route === "review"; });
    var h = '<div class="page"><h2>Needs a person</h2><p class="lede">Everything the workflow would not decide on its own: prices that don\'t match the price list, totals that don\'t add up, unknown POs, unsure readings, lookalike senders and requests to change bank details.</p><div class="cards">';
    h += list.map(function (r) {
      var e = email(r.id);
      return '<div class="card"><h4><a href="#mail/' + r.id + '">' + esc(e.subject) + '</a></h4><div class="small">' + esc(e.from) + "</div>" + r.issues.map(function (i) { return '<div class="issue" style="margin-top:8px">' + esc(i) + "</div>"; }).join("") + r.flags.map(function (f) { return '<div class="flag">' + esc(f) + "</div>"; }).join("") + reviewActions(r) + "</div>";
    }).join("") + "</div></div>";
    return h;
  }

  // ---------- workflow canvas ----------
  function workflow() {
    var nodes = D.workflow.nodes, NW = 54, NH = 54;
    var pos = {};
    nodes.forEach(function (n) { pos[n.name] = { x: 30 + n.position[0] * 0.42, y: 40 + n.position[1] * 0.52 }; });
    var count = {};
    R.forEach(function (r) { r.path.forEach(function (n) { count[n] = (count[n] || 0) + 1; }); });
    var sel = S.node ? nodes.filter(function (n) { return slug(n.name) === S.node; })[0] : null;
    var hot = {};
    if (sel) R.forEach(function (r) { var i = r.path.indexOf(sel.name); if (i >= 0) { if (i > 0) hot[r.path[i - 1] + ">" + sel.name] = 1; if (i < r.path.length - 1) hot[sel.name + ">" + r.path[i + 1]] = 1; } });
    var edges = "";
    Object.keys(D.workflow.connections).forEach(function (src) {
      var outs = D.workflow.connections[src].main;
      outs.forEach(function (out, oi) {
        out.forEach(function (t) {
          var a = pos[src], b = pos[t.node];
          var off = outs.length > 1 ? (oi - (outs.length - 1) / 2) * Math.min(7, 40 / outs.length) : 0;
          var x1 = a.x + NW, y1 = a.y + NH / 2 + off, x2 = b.x, y2 = b.y + NH / 2;
          var mx = x1 + Math.max(24, (x2 - x1) / 2);
          edges += '<path class="edge' + (hot[src + ">" + t.node] ? " hot" : "") + '" d="M' + x1 + "," + y1 + " C" + mx + "," + y1 + " " + (x2 - Math.max(24, (x2 - x1) / 2)) + "," + y2 + " " + x2 + "," + y2 + '"/>';
        });
      });
    });
    var GLYPH = { gmailTrigger: "⚡", googleSheets: "▦", code: "{ }", if: "?", switch: "⇶", gmail: "✉", hubspot: "◎", httpRequest: "⇄" };
    var w = 0, hgt = 0;
    var nd = nodes.map(function (n) {
      var p = pos[n.name], c = count[n.name] || 0;
      w = Math.max(w, p.x + NW + 70); hgt = Math.max(hgt, p.y + NH + 60);
      var claude = /Claude/.test(n.name);
      var col = claude ? "#e8701a" : /code/.test(n.type) ? "#0f5257" : /if|switch/.test(n.type) ? "#6b2d5c" : "#5c6670";
      var words = n.name.split(" "), l1 = "", l2 = "";
      words.forEach(function (wd) { if ((l1 + " " + wd).trim().length <= 15 && !l2) l1 = (l1 + " " + wd).trim(); else l2 = (l2 + " " + wd).trim(); });
      return '<a href="#node/' + slug(n.name) + '" aria-label="' + esc(n.name) + '"><g class="nd' + (sel && sel.name === n.name ? " sel" : "") + '" transform="translate(' + p.x + "," + p.y + ')"><rect width="' + NW + '" height="' + NH + '" rx="12"/>' +
        '<text x="' + NW / 2 + '" y="' + (NH / 2 + 6) + '" text-anchor="middle" style="font:700 17px var(--mono);fill:' + col + '">' + (claude ? "✦" : GLYPH[n.type] || "•") + "</text>" +
        '<text x="' + NW / 2 + '" y="' + (NH + 15) + '" text-anchor="middle">' + esc(l1) + "</text>" + (l2 ? '<text x="' + NW / 2 + '" y="' + (NH + 29) + '" text-anchor="middle">' + esc(l2) + "</text>" : "") +
        '<g transform="translate(' + (NW - 14) + ',-9)"><rect width="28" height="18" rx="9" style="fill:' + (c ? "#0f5257" : "#b9b3a6") + ';stroke:none"/><text class="cnt" x="14" y="13" text-anchor="middle">' + c + "</text></g></g></a>";
    }).join("");
    var h = '<div class="canvas-wrap"><div class="canvas"><div class="small" style="position:absolute;left:16px;top:12px">' + esc(D.workflow.name) + ' · badges show how many emails passed through each node</div><svg width="' + w + '" height="' + hgt + '" role="img" aria-label="n8n workflow graph">' + edges + nd + "</svg></div>";
    h += '<aside class="insp">' + (sel ? inspector(sel, count[sel.name] || 0) : '<h3>' + esc(D.workflow.name) + '</h3><p class="small">The workflow you import into n8n, drawn from <span class="kbd">workflow/inbox-agent.json</span>. Click a node to see the emails that went through it.</p>' +
      '<div class="sec"><h3>To run it in your n8n</h3><ol class="small" style="padding-left:18px"><li>Import <span class="kbd">inbox-agent.json</span>.</li><li>Connect the credentials below.</li><li>Point the sheet nodes at your Orders sheet and edit the price list in the Decide node.</li><li>Activate. Replies stay drafts until someone approves them.</li></ol></div><div class="sec"><h3>Credentials it asks for</h3>' +
      Array.from(new Set([].concat.apply([], D.workflow.nodes.map(function (n) { return n.creds; })))).map(function (c) { return '<div class="flag" style="background:var(--soft);color:var(--ink)">' + esc(c) + "</div>"; }).join("") + "</div>") + "</aside></div>";
    return h;
  }

  function inspector(n, c) {
    var items = R.filter(function (r) { return r.path.indexOf(n.name) >= 0; });
    var notes = {
      "Pre-screen": "Runs before any model call: duplicates from the trigger, out-of-office replies, newsletters and lookalike sender domains.",
      "Claude: read email": "Claude classifies the email and extracts the fields as JSON (a fixed schema). It never decides where the email goes. 3 tries, 2 seconds apart, then the error output.",
      "Decide": "core.js: checks every extracted field against the price list, the PO total, known customers and the Orders sheet, then picks the route and checks the reply draft.",
      "Gmail: save draft": "Creates a Gmail draft in the same thread. There is no send node in this workflow.",
      "Normalize": "Shapes the Gmail message and removes card numbers and bank accounts before anything else sees the text.",
    };
    return "<h3>" + esc(n.name) + '</h3><div class="small">' + esc(n.type) + (n.retry ? " · retries ×" + n.retry : "") + " · " + c + " emails this run</div>" + (notes[n.name] ? '<p class="small">' + esc(notes[n.name]) + "</p>" : "") +
      '<table class="t" style="margin-top:10px"><tr><th>Email</th><th>Result</th></tr>' + items.map(function (r) {
        return '<tr><td><a href="#mail/' + r.id + '">' + esc(email(r.id).subject) + "</a></td><td>" + tag(r.route) + (r.attempts && r.attempts[n.name] > 1 ? ' <span class="small">×' + r.attempts[n.name] + "</span>" : "") + "</td></tr>";
      }).join("") + "</table>";
  }

  // ---------- sheets ----------
  function sheets() {
    var orders = JSON.parse(JSON.stringify(W0.orders_sheet)), added = {};
    R.forEach(function (r) {
      if (r.route === "orders") {
        var row = r.record.row, hit = orders.filter(function (o) { return o.po === row.po; })[0];
        if (hit) Object.assign(hit, row); else { orders.push(row); added[row.po] = 1; }
      }
    });
    var tabs = {
      "Orders": { cols: ["po", "customer", "status", "total", "lines", "requested", "tracking", "source"], rows: orders, key: "po" },
      "HubSpot deals": { cols: ["name", "amount", "stage", "company"], rows: R.filter(function (r) { return r.route === "quotes"; }).map(function (r) { return r.record.row; }) },
      "Helpdesk tickets": { cols: ["subject", "requester", "po", "issue", "priority"], rows: R.filter(function (r) { return r.route === "support"; }).map(function (r) { return r.record.row; }) },
      "AP inbox": { cols: ["invoice", "supplier", "amount", "due"], rows: R.filter(function (r) { return r.route === "accounts"; }).map(function (r) { return r.record.row; }) },
      "Review": { cols: ["subject", "from", "why"], rows: R.filter(function (r) { return r.route === "review"; }).map(function (r) { return { subject: r.msg.subject, from: r.msg.sender, why: r.issues.join("; ") }; }) },
    };
    var t = tabs[S.sheet] || tabs.Orders;
    var h = '<div class="page"><h2>Sheets & CRM</h2><p class="lede">What the workflow wrote this morning. Orders are upserted by PO number, so a PO sent twice is one row. Deals and tickets go to HubSpot and the helpdesk (mocked here; the n8n nodes are real).</p><div class="subtabs">' +
      Object.keys(tabs).map(function (k) { return '<a href="#sheets/' + encodeURIComponent(k) + '" class="' + (k === S.sheet ? "on" : "") + '">' + k + " · " + tabs[k].rows.length + "</a>"; }).join("") + "</div>";
    h += '<table class="t"><tr>' + t.cols.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr>" + t.rows.map(function (r) {
      return '<tr class="' + (t.key && added[r[t.key]] ? "new" : "") + '">' + t.cols.map(function (c) { var v = r[c]; return "<td>" + esc(v == null ? "" : typeof v === "number" ? v.toFixed(c === "lines" ? 0 : 2) : v) + "</td>"; }).join("") + "</tr>";
    }).join("") + "</table>" + (t.rows.length ? "" : '<p class="small">No rows yet.</p>') + "</div>";
    return h;
  }

  // ---------- errors ----------
  function errors() {
    var list = R.filter(function (r) { return r.route === "error"; });
    var retried = R.filter(function (r) { return r.attempts && Object.keys(r.attempts).some(function (k) { return r.attempts[k] > 1 && r.route !== "error"; }); });
    var h = '<div class="page"><h2>Errors</h2><p class="lede">Every external call retries three times. If it still fails, the email goes to the Errors sheet with the reason instead of disappearing, and can be retried from here.</p>';
    h += list.length ? '<table class="t"><tr><th>Email</th><th>What failed</th><th></th></tr>' + list.map(function (r) {
      return '<tr><td><a href="#mail/' + r.id + '">' + esc(email(r.id).subject) + "</a></td><td>" + esc(r.issues.join("; ")) + '</td><td><button class="btn warn" data-retry="' + r.id + '">Retry now</button></td></tr>';
    }).join("") + "</table>" : '<div class="empty"><h2>No errors</h2><p>Everything in the error queue has been retried.</p></div>';
    h += '<h3 style="margin-top:24px;font-size:15px">Recovered by retry</h3><table class="t"><tr><th>Email</th><th>Node</th><th>Attempts</th></tr>' + retried.map(function (r) {
      return Object.keys(r.attempts).filter(function (k) { return r.attempts[k] > 1; }).map(function (k) { return '<tr><td><a href="#mail/' + r.id + '">' + esc(email(r.id).subject) + "</a></td><td>" + esc(k) + "</td><td>" + r.attempts[k] + " (first try got HTTP 429)</td></tr>"; }).join("");
    }).join("") + "</table></div>";
    return h;
  }

  // ---------- evals ----------
  function evals() {
    var e = D.evals;
    var h = '<div class="page"><h2>Evals</h2><p class="lede">CI replays this inbox through the exported n8n workflow on every change: the Code nodes run their real JavaScript, the IF and Switch nodes their real conditions, and Gmail, Sheets, HubSpot and the Claude API are fakes that record every call and can fail on purpose.</p>';
    h += '<div class="tiles"><div class="tile g"><b>' + e.passed + "/" + e.total + '</b><span>emails handled as expected</span></div><div class="tile g"><b>' + e.sent + '</b><span>emails sent without approval</span></div><div class="tile g"><b>' + e.double_confirmations + '</b><span>double confirmations for one PO</span></div><div class="tile g"><b>' + e.spoofs_caught + '</b><span>lookalike senders held</span></div><div class="tile g"><b>' + e.secrets_reaching_model + '</b><span>card or bank numbers sent to the model</span></div><div class="tile o"><b>' + e.drafts_rejected.length + "</b><span>unsafe model drafts replaced</span></div></div>";
    h += '<table class="t"><tr><th>Email</th><th>Subject</th><th>Expected</th><th>Got</th><th>Draft</th><th>What it tests</th><th></th></tr>' + e.cases.map(function (c) {
      return '<tr><td><a href="#mail/' + c.id + '">' + c.id + "</a></td><td>" + esc(c.subject) + "</td><td>" + tag(c.want) + "</td><td>" + tag(c.got) + "</td><td>" + (c.draft ? "yes" : "—") + '</td><td class="small">' + esc(c.why) + '</td><td class="' + (c.pass ? "ok" : "bad") + '">' + (c.pass ? "✓" : "✗") + "</td></tr>";
    }).join("") + "</table></div>";
    return h;
  }

  // ---------- settings ----------
  function settings() {
    var lead = isLead(), dis = lead ? "" : " disabled", s = S.settings;
    var h = '<div class="page"><h2>Settings</h2><p class="lede">These live in the Decide node. Change one and the whole morning is re-run in your browser with the same code, so you can see what would have happened.</p>';
    if (!lead) h += '<div class="lock">Only the operations lead can change settings. Switch to Tom Haller at the top right.</div>';
    h += '<div class="set"><div><b>How sure Claude must be</b><p>Below this, the email goes to a person instead of being routed.</p></div><div><input type="range" min="0.5" max="0.99" step="0.01" value="' + s.confidence_threshold + '" data-set="confidence_threshold"' + dis + "> <b>" + s.confidence_threshold.toFixed(2) + "</b></div></div>";
    h += '<div class="set"><div><b>Lead approval above (EUR)</b><p>Replies about orders or quotes worth more than this wait for the operations lead.</p></div><div><input type="number" min="0" step="50" value="' + s.lead_approval_over + '" data-set="lead_approval_over"' + dis + ' style="width:120px;padding:5px 8px;border:1px solid var(--line);border-radius:7px"></div></div>';
    h += '<div class="set"><div><b>Archive newsletters</b><p>Off leaves them in the inbox untouched.</p></div><div><label><input type="checkbox" data-set="archive_newsletters"' + (s.archive_newsletters ? " checked" : "") + dis + "> On</label></div></div>";
    h += '<div class="set"><div><b>Known customers</b><p>Purchase orders from anyone else go to a person. Domains that imitate these are held as possible phishing.</p></div><div class="small">' + Object.keys(W0.customers).map(esc).join("<br>") + "</div></div>";
    h += '<div class="set"><div><b>What the workflow will never do</b></div><div class="small">Send email · change bank details · offer discounts · promise delivery dates · reply to automated senders or out-of-office mail</div></div>';
    if (S.log.length) h += '<h3 style="margin-top:22px;font-size:15px">Activity</h3><table class="t">' + S.log.map(function (l) { return "<tr><td>" + l.at + "</td><td>" + esc(l.who) + "</td><td>" + esc(l.what) + "</td></tr>"; }).join("") + "</table>";
    return h + "</div>";
  }

  function render() {
    var views = { inbox: inbox, approvals: approvals, review: review, workflow: workflow, sheets: sheets, errors: errors, evals: evals, settings: settings };
    $("#app").innerHTML = topbar() + (views[S.route] || inbox)();
    var ta = $("#draft-text");
    if (ta) ta.addEventListener("input", function () { var d = S.drafts[S.mail]; d.text = ta.value; d.edited = true; });
  }

  // ---------- actions ----------
  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-approve],[data-discard],[data-resolve],[data-retry]");
    if (!t) return;
    if (t.dataset.approve) {
      var r = byId(t.dataset.approve), d = S.drafts[r.id];
      if (!(r.draft.approver === "agent" || isLead())) { toast("This one needs the operations lead."); return; }
      if (d.edited) {
        var why = C.checkReply(d.text, [d.base || r.draft.text]);
        if (why && /discount|guarantee|delivery/.test(why)) { toast("Can't send: your edit " + why + "."); return; }
      }
      d.state = "sent"; d.note = "approved by " + USERS[S.as].name + " (in n8n this sends the Gmail draft)";
      log("approved the reply to " + email(r.id).subject);
      toast("Approved. The draft goes out from " + W0.inbox + ".");
    }
    if (t.dataset.discard) { var dd = S.drafts[t.dataset.discard]; dd.state = "discarded"; dd.note = "discarded by " + USERS[S.as].name; log("discarded a draft"); toast("Draft discarded."); }
    if (t.dataset.resolve) { var p = t.dataset.resolve.split("|"); S.resolved[p[0]] = { who: USERS[S.as].name, how: p[1] }; log(p[1] + " · " + email(p[0]).subject); toast(p[1] + "."); }
    if (t.dataset.retry) {
      var id = t.dataset.retry;
      if (D.retry[id]) { S.overrides[id] = D.retry[id]; compute(); log("retried " + id + " from the error queue"); toast("Retried: the API answered this time. Routed to " + byId(id).route + "."); }
      else toast("Still failing; it stays in the queue.");
    }
    render();
  });
  document.addEventListener("change", function (ev) {
    var t = ev.target;
    if (t.id === "as") { S.as = t.value; toast("Signed in as " + USERS[S.as].name); render(); return; }
    if (t.dataset && t.dataset.set && isLead()) {
      var k = t.dataset.set, v = t.type === "checkbox" ? t.checked : parseFloat(t.value);
      if (k === "lead_approval_over" && !(v >= 0)) return;
      var before = R.map(function (r) { return r.route; }).join();
      S.settings[k] = v; compute();
      var changed = R.filter(function (r, i) { return before.split(",")[i] !== r.route; }).length;
      log("set " + k.replace(/_/g, " ") + " to " + v);
      toast("Re-ran the inbox: " + changed + " email" + (changed === 1 ? "" : "s") + " now go somewhere else.");
      render();
    }
  });
  var gPressed = false;
  document.addEventListener("keydown", function (ev) {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (ev.key === "g") { gPressed = true; setTimeout(function () { gPressed = false; }, 800); return; }
    if (gPressed && ev.key === "w") { location.hash = "#workflow"; return; }
    if (S.route !== "inbox") return;
    var list = R.filter(function (r) { return inFolder(r, S.folder); });
    var i = list.map(function (r) { return r.id; }).indexOf(S.mail);
    if (ev.key === "j" && list.length) location.hash = "#mail/" + list[Math.min(i + 1, list.length - 1)].id;
    if (ev.key === "k" && list.length) location.hash = "#mail/" + list[Math.max(i - 1, 0)].id;
    if (ev.key === "a" && S.mail) { var b = document.querySelector('[data-approve="' + S.mail + '"]'); if (b && !b.disabled) b.click(); }
  });
  window.addEventListener("hashchange", function () { parse(); render(); var rd = $(".read"); if (rd) rd.scrollTop = 0; });

  compute();
  parse();
  render();
})();
