import copy
import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from harness import evals
from harness.replay import DEFAULT_FAILURES, ROOT, load, replay, summary

WF = json.loads((ROOT / "workflow" / "inbox-agent.json").read_text())
CORE = (ROOT / "src" / "core.js").read_text()


def js(expr):
    """Evaluate an expression against src/core.js under node."""
    code = CORE + "\nconst W = " + (ROOT / "data" / "world.json").read_text() + ";\nprocess.stdout.write(JSON.stringify(" + expr + "));"
    out = subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def test_committed_workflow_is_current():
    import workflow.build as b
    assert b.build() == WF


def test_code_nodes_carry_core_js():
    codes = [n["parameters"]["jsCode"] for n in WF["nodes"] if n["type"] == "n8n-nodes-base.code"]
    assert codes and all(CORE in c for c in codes)


def test_workflow_never_sends_mail():
    for n in WF["nodes"]:
        if n["type"] == "n8n-nodes-base.gmail":
            assert n["parameters"].get("operation") != "send"
            assert n["parameters"].get("resource") in ("draft", None)


def test_external_calls_retry_and_have_error_paths():
    for n in WF["nodes"]:
        if n["name"] in ("Claude: read email", "Orders sheet: upsert", "HubSpot: create deal", "Helpdesk: create ticket"):
            assert n["retryOnFail"] and n["maxTries"] >= 3 and n["onError"] == "continueErrorOutput"


def test_every_connection_points_at_a_node():
    names = {n["name"] for n in WF["nodes"]}
    for src, c in WF["connections"].items():
        assert src in names
        for out in c["main"]:
            for t in out:
                assert t["node"] in names


def test_full_inbox_replay_scores():
    r = evals.run()
    assert r["passed"] == r["total"]
    assert r["sent"] == 0 and r["double_confirmations"] == 0 and r["order_rows_unique"]
    assert r["spoofs_caught"] == 2 and r["secrets_reaching_model"] == 0
    assert {d["id"] for d in r["drafts_rejected"]} == {"E-11", "E-23"}
    assert r["retried_ok"] and r["parked"] == 1


def test_second_run_skips_everything_already_seen():
    first = replay(DEFAULT_FAILURES)
    again = replay(static=first.static)
    s = summary(again)
    assert len(s["skipped"]) == len(load("emails.json"))
    assert not s["drafts"] and not again.world.deals


def test_sheet_failing_every_retry_goes_to_error_queue():
    r = replay({("Orders sheet: upsert", "<a1@brightsmile-dental.example>"): 5})
    s = summary(r)
    assert any(e["message_id"] == "<a1@brightsmile-dental.example>" for e in s["errors"])
    assert not any(d["message_id"] == "<a1@brightsmile-dental.example>" for d in s["drafts"])


def test_model_blip_is_retried():
    rec = load("recorded.json")
    rec["E-24"] = copy.deepcopy(rec["E-20"])
    rec["E-24"]["fields"]["po_number"] = "PO-2026-1206"
    rec["E-24"]["fields"]["lines"] = [{"sku": "GLV-NIT-L", "qty": 12, "unit_price": 14.50}, {"sku": "IMP-ALG-500", "qty": 2, "unit_price": 18.75}]
    rec["E-24"]["fields"]["total"] = 211.50
    rec["E-24"]["reply"] = None
    r = replay({}, recorded=rec)
    assert summary(r)["routes"]["E-24"] == "orders"


def test_model_reply_that_is_not_json_is_an_error():
    rec = load("recorded.json")
    r = replay({}, recorded={**rec, "E-01": None})
    assert summary(r)["routes"]["E-01"] == "error"


# ---- core.js ----------------------------------------------------------------

def test_redaction_only_removes_real_card_numbers_and_ibans():
    out = js("redact('card 4111 1111 1111 1111, order 1234567890123, IBAN DE00 1234 5678 9012 3456 78')")
    assert "4111" not in out["text"] and "1234567890123" in out["text"] and "DE00" not in out["text"]
    assert sorted(out["found"]) == ["bank account", "card number"]


@pytest.mark.parametrize("domain,expect", [
    ("brightsmi1e-dental.example", "brightsmile-dental.example"), ("oakrldge-ortho.example", "oakridge-ortho.example"),
    ("brightsmile-dental.example", None), ("totally-new-clinic.example", None)])
def test_lookalike(domain, expect):
    assert js(f"lookalike('{domain}', Object.keys(W.customers))") == expect


@pytest.mark.parametrize("text,reason", [
    ("Your total is EUR 678.00.", None),
    ("Your total is EUR 600.00.", "states 600, which is not in the order data"),
    ("We can do 10% off this time.", "offers a discount"),
    ("It will arrive Thursday.", "promises a delivery date"),
    ("We guarantee next-day delivery.", "makes a guarantee"),
])
def test_reply_checks(text, reason):
    assert js(f"checkReply({json.dumps(text)}, ['678.00'])") == reason


def test_threshold_and_approval_settings():
    e = next(x for x in load("emails.json") if x["id"] == "E-10")
    m = load("recorded.json")["E-10"]
    base = f"const msg = normalize({json.dumps(e)}); const m = {json.dumps(m)};"
    strict = js("(() => {" + base + " W.settings.confidence_threshold = 0.9; return decide(msg, {action:'continue'}, m, {orders: []}, W).route; })()")
    assert strict == "review"
    e6 = next(x for x in load("emails.json") if x["id"] == "E-06")
    m6 = load("recorded.json")["E-06"]
    who = js("(() => { const msg = normalize(" + json.dumps(e6) + "); W.settings.lead_approval_over = 1000; return decide(msg, {action:'continue'}, " + json.dumps(m6) + ", {orders: []}, W).draft.approver; })()")
    assert who == "agent"


def test_unknown_product_goes_to_review():
    e = next(x for x in load("emails.json") if x["id"] == "E-01")
    m = load("recorded.json")["E-01"]
    m["fields"]["lines"][0]["sku"] = "GLV-NOPE"
    d = js("decide(normalize(" + json.dumps(e) + "), {action:'continue'}, " + json.dumps(m) + ", {orders: []}, W)")
    assert d["route"] == "review" and "unknown product GLV-NOPE" in d["issues"]
