"""Replays synthetic emails through workflow/inbox-agent.json.

It walks the workflow's own nodes and connections the way n8n does (execution
order v1, branch by branch). Code nodes run their real JavaScript under node;
IF and Switch nodes evaluate their real conditions; Gmail, Google Sheets,
HubSpot, the helpdesk and the Claude API are in-memory fakes that record every
call. Failures can be injected (a 429 from Sheets, a 529 from the API) to check
retries and the error path.

    python -m harness.replay            # run the fixtures, print a summary
"""
import copy
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "harness" / "runner.js"


def load(name):
    return json.loads((ROOT / "data" / name).read_text())


# ---------------------------------------------------------------- expressions

def get_path(obj, path):
    for part in path.split("."):
        if obj is None:
            return None
        obj = obj.get(part) if isinstance(obj, dict) else None
    return obj


def expr(value, item):
    """The small subset of n8n expressions this workflow uses."""
    if not (isinstance(value, str) and value.startswith("={{")):
        return value
    body = value[3:-2].strip()
    m = re.fullmatch(r"\$json\.([\w.]+)", body)
    if m:
        return get_path(item, m.group(1))
    m = re.fullmatch(r"\$json\.([\w.]+) \? '(\w+)' : '(\w+)'", body)
    if m:
        return m.group(2) if get_path(item, m.group(1)) else m.group(3)
    m = re.fullmatch(r"\$json\.([\w.]+)\.join\('; '\)", body)
    if m:
        return "; ".join(get_path(item, m.group(1)) or [])
    m = re.fullmatch(r"\$json\.issues \? \$json\.issues\.join\('; '\) : \$json\.error\.message", body)
    if m:
        return "; ".join(item["issues"]) if item.get("issues") else get_path(item, "error.message")
    if body.startswith("JSON.stringify("):
        return None  # request bodies: the fake API reads the item directly
    raise ValueError(f"expression not supported by the harness: {body}")


def condition(params, item):
    c = params["conditions"]["conditions"][0]
    return expr(c["leftValue"], item) == c["rightValue"]


# ---------------------------------------------------------------- fakes

class Fail(Exception):
    pass


class World:
    """Everything outside n8n, recorded."""

    def __init__(self, failures=None, recorded=None):
        w = load("world.json")
        self.recorded = recorded if recorded is not None else load("recorded.json")
        self.sheets = {"Orders": copy.deepcopy(w["orders_sheet"]), "AP inbox": [], "Review": [], "Errors": []}
        self.deals, self.tickets, self.drafts, self.labels, self.sent = [], [], [], [], []
        self.calls = []
        self.failures = dict(failures or {})  # (node, message_id) -> how many attempts fail

    def maybe_fail(self, node, key, code):
        k = (node, key)
        if self.failures.get(k, 0) > 0:
            self.failures[k] -= 1
            self.calls.append((node, key, f"HTTP {code}"))
            raise Fail(f"HTTP {code}")

    def claude(self, item):
        mid = item["message_id"]
        rec = self.recorded.get(item["id"])
        if rec is None or "error" in rec:
            self.calls.append(("Claude", mid, "HTTP 529"))
            raise Fail(rec["error"] if rec else "no recording")
        self.calls.append(("Claude", mid, "ok"))
        prompt = item["text"] + "".join(a["text"] for a in item["attachments"])
        return {"id": "msg_replay", "type": "message", "stop_reason": "end_turn", "prompt_seen": prompt,
                "content": [{"type": "text", "text": json.dumps(rec)}]}


# ---------------------------------------------------------------- engine

class Run:
    def __init__(self, workflow, world, static=None):
        self.wf = workflow
        self.nodes = {n["name"]: n for n in workflow["nodes"]}
        self.world = world
        self.static = static if static is not None else {}
        self.outputs = {}   # node -> list of items (all batches)
        self.pairs = {}     # node -> output index -> index in that node's items
        self.trace = []     # (node, message_id, outcome)
        self.attempts = {}

    def run_code(self, node, items):
        req = {"code": node["parameters"]["jsCode"], "items": [{"json": i} for i in items],
               "nodes": {k: [{"json": i} for i in v] for k, v in self.outputs.items()},
               "pairs": self.pairs, "static": self.static}
        res = subprocess.run(["node", str(RUNNER)], input=json.dumps(req), capture_output=True, text=True, check=True)
        out = json.loads(res.stdout)
        if "error" in out:
            raise RuntimeError(f"{node['name']}: {out['error']}")
        self.static = out["static"]
        return [i["json"] for i in out["items"]]

    def with_retry(self, node, item, fn):
        tries = node.get("maxTries", 3) if node.get("retryOnFail") else 1
        last = None
        for attempt in range(1, tries + 1):
            try:
                result = fn()
                self.attempts[(node["name"], item.get("message_id"))] = attempt
                return result, None
            except Fail as e:
                last = str(e)
        self.attempts[(node["name"], item.get("message_id"))] = tries
        return None, last

    def execute(self, name, items):
        """Returns a list of outputs, each a list of (item, source_index)."""
        node, t, p = self.nodes[name], self.nodes[name]["type"].split(".")[-1], self.nodes[name]["parameters"]
        w = self.world
        if t == "gmailTrigger":
            return [[(i, k) for k, i in enumerate(items)]]
        if t == "code":
            return [[(i, k) for k, i in enumerate(self.run_code(node, items))]]
        if t == "if":
            yes, no = [], []
            for k, i in enumerate(items):
                (yes if condition(p, i) else no).append((i, k))
            return [yes, no]
        if t == "switch":
            outs = [[] for _ in p["rules"]["values"]]
            for k, i in enumerate(items):
                for o, rule in enumerate(p["rules"]["values"]):
                    if condition(rule, i):
                        outs[o].append((i, k))
                        break
            return outs
        if t == "googleSheets" and p["operation"] == "read":
            return [[(r, k) for k, r in enumerate(w.sheets[p["sheetName"]["value"]])]]
        ok, err = [], []
        for k, i in enumerate(items):
            mid = i.get("message_id")
            if t == "httpRequest" and "anthropic" in p["url"]:
                res, e = self.with_retry(node, i, lambda: w.claude(i))
                if e:
                    err.append(({"error": {"message": e}}, k))
                    self.trace.append((name, mid, f"failed after {self.attempts[(name, mid)]} attempts"))
                else:
                    ok.append((res, k))
                    self.trace.append((name, mid, "read"))
                continue

            def write():
                w.maybe_fail(name, mid, 429)
                if t == "googleSheets":
                    sheet = w.sheets[p["sheetName"]["value"]]
                    row = {c: expr(v, i) for c, v in p["columns"]["value"].items()}
                    if p["operation"] == "appendOrUpdate":
                        key = p["columns"]["matchingColumns"][0]
                        hit = next((r for r in sheet if r.get(key) == row[key]), None)
                        if hit:
                            hit.update(row)
                            return "updated row " + str(row[key])
                    sheet.append(row)
                    return "appended row"
                if t == "hubspot":
                    w.deals.append(dict(i["record"]["row"], source=mid))
                    return "created deal"
                if t == "httpRequest":
                    w.tickets.append(dict(i["record"]["row"], source=mid))
                    return "created ticket"
                if t == "gmail" and p.get("resource") == "draft":
                    w.drafts.append({**i["draft"], "message_id": mid, "route": i["route"]})
                    return "saved draft"
                if t == "gmail" and p["operation"] == "addLabels":
                    w.labels.append((mid, p["labelIds"][0]))
                    return "labelled"
                if t == "gmail" and p["operation"] == "send":
                    w.sent.append(mid)
                    return "SENT"
                raise ValueError(f"no fake for {node['type']} {p.get('operation')}")

            res, e = self.with_retry(node, i, write)
            tries = self.attempts[(name, mid)]
            if e:
                err.append(({**i, "issues": [f"{name}: {e}"], "route": "error"}, k))
                self.trace.append((name, mid, f"failed after {tries} attempts"))
            else:
                ok.append((i, k))
                self.trace.append((name, mid, res + (f" (after {tries} attempts)" if tries > 1 else "")))
        return [ok, err] if node.get("onError") == "continueErrorOutput" else [ok]

    def go(self, emails):
        start = next(n for n in self.wf["nodes"] if n["type"].endswith("Trigger"))
        queue = [(start["name"], emails, None)]
        claude_src = []
        while queue:
            name, items, pairs = queue.pop(0)
            if not items:
                continue
            if pairs is not None:
                self.pairs["Pre-screen"] = pairs
            outs = self.execute(name, items)
            self.outputs.setdefault(name, []).extend(i for out in outs for i, _ in out)
            if name == "Needs the model?":
                claude_src = [k for _, k in outs[0]]
            conns = self.wf["connections"].get(name, {}).get("main", [])
            for idx, out in enumerate(outs):
                if idx >= len(conns) or not out:
                    continue
                for target in conns[idx]:
                    p = [claude_src[k] for _, k in out] if name == "Claude: read email" else None
                    queue.append((target["node"], [i for i, _ in out], p))
        return self


def replay(failures=None, recorded=None, emails=None, workflow=None, static=None):
    wf = workflow or json.loads((ROOT / "workflow" / "inbox-agent.json").read_text())
    world = World(failures, recorded)
    run = Run(wf, world, static)
    run.go(emails if emails is not None else load("emails.json"))
    return run


DEFAULT_FAILURES = {("Orders sheet: upsert", "<r20@lakeside-clinic.example>"): 1}


def summary(run):
    w = run.world
    decided = run.outputs.get("Decide", [])
    return {
        "routes": {d["id"]: d["route"] for d in decided},
        "skipped": [(i["id"], i["screen"]["reason"]) for i in run.outputs.get("Pre-screen", []) if i["screen"]["action"] != "continue"],
        "orders": w.sheets["Orders"], "deals": w.deals, "tickets": w.tickets, "drafts": w.drafts,
        "review": w.sheets["Review"], "errors": w.sheets["Errors"], "ap": w.sheets["AP inbox"], "sent": w.sent,
    }


if __name__ == "__main__":
    r = replay(DEFAULT_FAILURES)
    s = summary(r)
    for k, v in s["routes"].items():
        print(f"{k}: {v}")
    print("skipped:", s["skipped"])
    print("drafts:", len(s["drafts"]), "sent:", len(s["sent"]), "review rows:", len(s["review"]), "errors:", len(s["errors"]))
    sys.exit(0)
