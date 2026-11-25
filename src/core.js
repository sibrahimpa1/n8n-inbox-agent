// Decision logic for the shared-inbox workflow. The same file is pasted into the
// n8n Code nodes (workflow/build.py), run by the replay harness, and used by the
// live demo, so what you test is what runs in n8n.
//
// The model classifies and extracts; this code decides. Nothing here sends mail:
// replies are only ever saved as drafts for a person to approve.

const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const PO_RE = /^PO-\d{4}-\d{4}$/;

function domainOf(from) {
  const m = String(from).match(/<([^>]+)>/);
  const addr = (m ? m[1] : String(from)).trim().toLowerCase();
  return { address: addr, local: addr.split("@")[0], domain: addr.split("@")[1] || "" };
}

function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = +digits[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

// Card numbers (Luhn-valid) and IBANs never reach the model or a sheet.
function redact(text) {
  const found = [];
  let out = String(text || "").replace(CARD, (m) => {
    const d = m.replace(/\D/g, "");
    if (d.length >= 13 && luhn(d)) { found.push("card number"); return "[card number removed]"; }
    return m;
  });
  out = out.replace(IBAN, () => { found.push("bank account"); return "[bank account removed]"; });
  return { text: out, found: Array.from(new Set(found)) };
}

function normalize(email) {
  const sender = domainOf(email.from);
  const body = redact(email.text);
  const att = (email.attachments || []).map((a) => ({ name: a.name, text: redact(a.text).text }));
  return {
    id: email.id, message_id: email.message_id, subject: email.subject, received: email.received,
    from: email.from, sender: sender.address, local: sender.local, domain: sender.domain,
    headers: email.headers || {}, text: body.text, redacted: body.found, attachments: att,
  };
}

// Lookalike domains: same as a known one after undoing common swaps, but not identical.
function skeleton(d) {
  return d.toLowerCase().replace(/rn/g, "m").replace(/vv/g, "w").replace(/[1|]/g, "l").replace(/0/g, "o").replace(/5/g, "s");
}
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i].concat(new Array(b.length).fill(0)));
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
function lookalike(domain, known) {
  if (known.indexOf(domain) >= 0) return null;
  for (const k of known) {
    if (skeleton(k) === skeleton(domain) || editDistance(k, domain) <= 2) return k;
  }
  return null;
}

// Before any model call: loops, bulk mail, duplicates, lookalikes.
function prescreen(msg, seen, world) {
  const h = Object.keys(msg.headers).reduce((o, k) => { o[k.toLowerCase()] = String(msg.headers[k]).toLowerCase(); return o; }, {});
  if (seen.indexOf(msg.message_id) >= 0) return { action: "ignore", reason: "same Message-ID already processed (trigger delivered it twice)" };
  if ((h["auto-submitted"] && h["auto-submitted"] !== "no") || /^(automatic reply|auto:|out of office)/i.test(msg.subject))
    return { action: "ignore", reason: "automatic reply; answering it could start a mail loop" };
  if (h["list-unsubscribe"] || h["precedence"] === "bulk")
    return { action: world.settings.archive_newsletters ? "archive" : "ignore", reason: "newsletter or bulk mail" };
  const known = Object.keys(world.customers).concat(world.suppliers);
  const like = lookalike(msg.domain, known);
  if (like) return { action: "continue", flag: "lookalike", reason: "sender domain " + msg.domain + " imitates " + like };
  return { action: "continue" };
}

function money(n) { return Math.round(n * 100) / 100; }
function fmt(n) { return money(n).toFixed(2); }

function validateLines(lines, world, needPrice) {
  const issues = [];
  (lines || []).forEach((l) => {
    const p = world.products[l.sku];
    if (!p) { issues.push("unknown product " + l.sku); return; }
    if (!(Number.isInteger(l.qty) && l.qty > 0)) issues.push("bad quantity for " + l.sku);
    if (needPrice && l.unit_price != null && money(l.unit_price) !== money(p.price))
      issues.push(l.sku + " at EUR " + fmt(l.unit_price) + " but the price list says EUR " + fmt(p.price));
  });
  if (!lines || !lines.length) issues.push("no order lines found");
  return issues;
}

function priced(lines, world) {
  return lines.map((l) => {
    const p = world.products[l.sku];
    return { sku: l.sku, name: p ? p.name : l.sku, qty: l.qty, unit_price: p ? p.price : null, line_total: p ? money(p.price * l.qty) : null };
  });
}

// Every number and date in a reply must come from the facts code allowed;
// discounts, guarantees and delivery promises are never left to the model.
function checkReply(text, facts) {
  if (!text) return "no draft";
  const banned = [[/\b\d+ ?% ?(off|discount)\b|\bdiscount\b/i, "offers a discount"], [/\bguarantee/i, "makes a guarantee"],
    [/\bship (it )?today\b|\bwill arrive\b|\barrive (on|by)?\s*(mon|tue|wed|thu|fri|sat|sun)/i, "promises a delivery date"]];
  for (const [re, why] of banned) if (re.test(text)) return why;
  const allowed = new Set();
  facts.forEach((f) => String(f).replace(/,/g, "").match(/\d+(?:\.\d+)?/g)?.forEach((n) => allowed.add(String(+n))));
  const nums = (text.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) || []).map((n) => String(+n));
  const stray = nums.filter((n) => !allowed.has(n));
  if (stray.length) return "states " + Array.from(new Set(stray)).join(", ") + ", which is not in the order data";
  return null;
}

function approver(amount, world) { return amount != null && amount > world.settings.lead_approval_over ? "lead" : "agent"; }

// The model's reading of the email -> what the workflow does.
function decide(msg, screen, model, ctx, world) {
  const s = world.settings;
  const out = { id: msg.id, route: "review", issues: [], flags: [], actions: [], draft: null };
  if (msg.redacted.length) out.flags.push("removed " + msg.redacted.join(" and ") + " before the model saw it");
  if (screen.flag === "lookalike") { out.flags.push(screen.reason); out.issues.push("possible spoofed sender"); }
  if (!model || model.error) { out.route = "error"; out.issues.push(model ? model.error : "no model result"); return out; }
  out.type = model.type; out.confidence = model.confidence; out.summary = model.summary;
  if (model.confidence < s.confidence_threshold) { out.issues.push("model unsure (" + model.confidence + ")"); }
  const f = model.fields || {}, customer = world.customers[msg.domain];
  const isSystem = /^(no-?reply|mailer-daemon|notifications?)$/.test(msg.local);
  let facts = [], amount = null;

  if (model.type === "purchase_order") {
    if (!f.po_number || !PO_RE.test(f.po_number)) out.issues.push("no valid PO number");
    if (!customer) out.issues.push("sender is not a known customer");
    out.issues = out.issues.concat(validateLines(f.lines, world, true));
    const sum = money((f.lines || []).reduce((t, l) => t + (l.unit_price || 0) * l.qty, 0));
    if (f.total != null && money(f.total) !== sum) out.issues.push("PO total EUR " + fmt(f.total) + " does not match the lines (EUR " + fmt(sum) + ")");
    const dup = f.po_number && ctx.orders.some((o) => o.po === f.po_number);
    amount = f.total;
    out.record = { sheet: "Orders", key: f.po_number, row: { po: f.po_number, customer: customer ? customer.name : msg.domain, total: f.total, lines: (f.lines || []).length, requested: f.requested_date || "", status: "New", source: msg.message_id } };
    if (!out.issues.length) {
      out.route = "orders";
      if (dup) { out.flags.push("PO already in the Orders sheet; row updated, no second confirmation"); out.duplicate = true; }
      facts = [f.po_number, (f.lines || []).length, fmt(f.total), f.requested_date || "", f.ship_to || ""];
    }
  } else if (model.type === "quote_request") {
    out.issues = out.issues.concat(validateLines(f.lines, world, false));
    if (!out.issues.length) {
      const lines = priced(f.lines, world);
      amount = money(lines.reduce((t, l) => t + l.line_total, 0));
      out.route = "quotes";
      out.record = { system: "HubSpot", object: "deal", key: msg.message_id, row: { name: (customer ? customer.name : msg.sender) + " quote", amount: amount, stage: "Quote requested", company: customer ? customer.hubspot_id : "new contact: " + msg.sender, lines: lines } };
      if (f.customer_ask) out.flags.push("customer asks for " + f.customer_ask + "; a person decides");
      facts = lines.map((l) => l.qty).concat(lines.map((l) => fmt(l.unit_price)), lines.map((l) => l.name), [fmt(amount)]);
    }
  } else if (model.type === "support") {
    const prio = f.issue === "damaged" || f.issue === "wrong_item" ? "high" : "normal";
    out.route = "support";
    out.record = { system: "Helpdesk", object: "ticket", key: msg.message_id, row: { subject: msg.subject, requester: msg.sender, po: f.po_number || "", issue: f.issue, priority: prio } };
    facts = [f.po_number || ""];
  } else if (model.type === "order_status") {
    const o = ctx.orders.find((r) => r.po === f.po_number);
    out.route = "status";
    out.lookup = o || null;
    if (!o) { out.route = "review"; out.issues.push(f.po_number + " is not in the Orders sheet"); }
    else facts = [o.po, o.status, o.shipped || "", o.carrier || "", o.tracking || ""];
  } else if (model.type === "invoice") {
    out.route = "accounts";
    out.record = { sheet: "AP inbox", key: f.invoice_number, row: { invoice: f.invoice_number, supplier: msg.domain, amount: f.amount, due: f.due } };
  } else if (model.type === "payment_change") {
    out.route = "review"; out.issues.push("asks to change payment details; verify by phone with a known contact");
  } else {
    out.route = out.issues.length ? "review" : "done";
    if (!out.issues.length) out.flags.push("nothing to do");
  }
  if (out.issues.length) out.route = "review";

  // Reply draft: only for routes that answer the customer, never to system senders.
  const answers = { orders: 1, quotes: 1, support: 1, status: 1 };
  if (answers[out.route] && !isSystem && !(out.duplicate)) {
    const reason = checkReply(model.reply, facts);
    const text = reason ? template(out, msg, f, world) : model.reply;
    out.draft = { to: msg.sender, subject: "Re: " + msg.subject, text: text, by: reason ? "template" : "model", rejected: reason, approver: approver(amount, world), state: "awaiting approval" };
  } else if (answers[out.route] && isSystem) {
    out.flags.push("no reply: automated sender");
  }
  return out;
}

function greeting(msg) {
  const name = String(msg.from).split("<")[0].trim().replace(/^Dr\.\s*/, "").split(" ")[0];
  return name && !/^(reception|accounts|polar)$/i.test(name) ? "Hi " + name + "," : "Hello,";
}

// Plain, safe replies built only from checked data.
function template(out, msg, f, world) {
  const g = greeting(msg);
  if (out.route === "orders") return g + " thank you for " + f.po_number + ". We've logged it and will confirm dispatch by email.";
  if (out.route === "quotes") {
    const r = out.record.row;
    const lines = r.lines.map((l) => l.qty + " x " + l.name + " at EUR " + fmt(l.unit_price)).join("; ");
    return g + " here is your quote: " + lines + ". Total EUR " + fmt(r.amount) + " excluding VAT. Reply to confirm and we'll book it in.";
  }
  if (out.route === "status") {
    const o = out.lookup;
    return o.tracking ? g + " " + o.po + " shipped on " + o.shipped + " with " + o.carrier + ", tracking " + o.tracking + "." : g + " " + o.po + (o.status === "New" ? " has been received and is being prepared." : " is at the " + o.status.toLowerCase() + " stage now.") + " We'll send tracking as soon as it ships.";
  }
  if (out.route === "support") return g + " thanks for letting us know. We've opened a ticket" + (f.po_number ? " for " + f.po_number : "") + " and will get back to you shortly.";
  return g + " thanks for your email.";
}

const api = { normalize, redact, prescreen, lookalike, decide, checkReply, priced, template, domainOf };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.InboxCore = api;
