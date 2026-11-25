"""Scores a replay of the fixture inbox against what should happen to each email."""
import json
import re

from .replay import DEFAULT_FAILURES, replay, summary

EXPECT = {
    "E-01": ("orders", "draft"), "E-02": ("review", None), "E-03": ("review", None), "E-04": ("orders", None),
    "E-05": ("skipped", None), "E-06": ("quotes", "draft"), "E-07": ("quotes", "draft"), "E-08": ("support", "draft"),
    "E-09": ("support", "draft"), "E-10": ("support", "draft"), "E-11": ("status", "draft"), "E-12": ("review", None),
    "E-13": ("skipped", None), "E-14": ("skipped", None), "E-15": ("accounts", None), "E-16": ("review", None),
    "E-17": ("review", None), "E-18": ("review", None), "E-19": ("done", None), "E-20": ("orders", "draft"),
    "E-21": ("review", None), "E-22": ("support", None), "E-23": ("quotes", "draft"), "E-24": ("error", None),
}
WHY = {
    "E-02": "price differs from the price list", "E-03": "lookalike sender domain", "E-04": "same PO resent",
    "E-05": "trigger delivered it twice", "E-11": "model draft promised a delivery date", "E-12": "PO not found",
    "E-13": "out-of-office reply", "E-14": "newsletter", "E-16": "card number in the body, no PO number",
    "E-17": "model unsure", "E-18": "PO total doesn't match its lines", "E-20": "Sheets returned 429 once",
    "E-21": "bank-detail change from a lookalike domain", "E-22": "automated sender, no reply",
    "E-23": "model draft offered a discount", "E-24": "model API down on every retry",
}
SECRETS = [r"4111\s?1111\s?1111\s?1111", r"DE00\s?1234"]


def run():
    r = replay(DEFAULT_FAILURES)
    s = summary(r)
    emails = json.loads(open(__import__("pathlib").Path(__file__).resolve().parent.parent.joinpath("data", "emails.json")).read())
    drafted = {d["message_id"] for d in s["drafts"]}
    skipped = {e for e, _ in s["skipped"]}
    rows = []
    for e in emails:
        route = "skipped" if e["id"] in skipped else s["routes"].get(e["id"])
        want_route, want_draft = EXPECT[e["id"]]
        has_draft = e["message_id"] in drafted and e["id"] not in skipped
        ok = route == want_route and (want_draft == "draft") == has_draft
        rows.append({"id": e["id"], "subject": e["subject"], "want": want_route, "got": route,
                     "draft": has_draft, "pass": ok, "why": WHY.get(e["id"], "")})
    prompts = json.dumps(r.world.calls) + json.dumps([i for i in r.outputs.get("Claude: read email", [])])
    leaked = [p for p in SECRETS if re.search(p, prompts) or re.search(p, json.dumps(s["orders"] + s["review"]))]
    confirmations = {}
    for d in s["drafts"]:
        if d["route"] == "orders":
            po = re.search(r"PO-\d{4}-\d{4}", d["text"]).group(0)
            confirmations[po] = confirmations.get(po, 0) + 1
    decided = r.outputs.get("Decide", [])
    return {
        "cases": rows, "passed": sum(x["pass"] for x in rows), "total": len(rows),
        "sent": len(s["sent"]), "drafts": len(s["drafts"]),
        "double_confirmations": sum(1 for n in confirmations.values() if n > 1),
        "order_rows_unique": len({o["po"] for o in s["orders"]}) == len(s["orders"]),
        "spoofs_caught": sum(1 for d in decided if any("imitates" in f for f in d["flags"]) and d["route"] == "review"),
        "secrets_reaching_model": len(leaked),
        "drafts_rejected": [{"id": d["id"], "reason": d["draft"]["rejected"]} for d in decided if d.get("draft") and d["draft"]["rejected"]],
        "retried_ok": [t for t in r.trace if "after" in t[2] and "failed" not in t[2]],
        "parked": len(s["errors"]),
    }


if __name__ == "__main__":
    print(json.dumps({k: v for k, v in run().items() if k != "cases"}, indent=2))
