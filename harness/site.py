"""Builds the live demo, site/index.html: one self-contained page with the
fixtures, the workflow graph, the eval results and the same core.js and
pipeline.js the tests run."""
import json
from pathlib import Path

from . import evals
from .replay import DEFAULT_FAILURES, ROOT, load

WEB = ROOT / "web"


def payload():
    wf = json.loads((ROOT / "workflow" / "inbox-agent.json").read_text())
    retry = dict(load("recorded.json")["E-20"])
    retry.update(summary="One more order with large gloves and alginate.", reply="Hi Amira, thank you for PO-2026-1206 (2 lines, EUR 211.50). It's logged and we'll confirm dispatch.",
                 fields={"po_number": "PO-2026-1206", "ship_to": None, "requested_date": None, "total": 211.50,
                         "lines": [{"sku": "GLV-NIT-L", "qty": 12, "unit_price": 14.50}, {"sku": "IMP-ALG-500", "qty": 2, "unit_price": 18.75}]})
    ev = evals.run()
    return {
        "world": load("world.json"), "emails": load("emails.json"), "recorded": load("recorded.json"),
        "retry": {"E-24": retry},
        "failures": {f"{k[0]}|{k[1]}": v for k, v in DEFAULT_FAILURES.items()},
        "workflow": {"name": wf["name"], "nodes": [{"name": n["name"], "type": n["type"].split(".")[-1], "position": n["position"],
                                                    "retry": n.get("maxTries") if n.get("retryOnFail") else None,
                                                    "creds": list((n.get("credentials") or {}).keys())} for n in wf["nodes"]],
                     "connections": wf["connections"]},
        "evals": ev,
    }


def build(out=ROOT / "site" / "index.html"):
    html = (WEB / "index.html").read_text()
    data = json.dumps(payload(), separators=(",", ":")).replace("</", "<\\/")
    html = (html.replace("/*CSS*/", (WEB / "style.css").read_text())
                .replace("/*DATA*/", "window.MAILROOM = " + data + ";")
                .replace("/*CORE*/", (ROOT / "src" / "core.js").read_text())
                .replace("/*PIPELINE*/", (ROOT / "src" / "pipeline.js").read_text())
                .replace("/*APP*/", (WEB / "app.js").read_text()))
    Path(out).write_text(html)
    return str(Path(out).relative_to(ROOT))
