"""python -m harness demo | eval | build | site"""
import json
import sys

from . import evals
from .replay import DEFAULT_FAILURES, replay, summary


def demo():
    r = replay(DEFAULT_FAILURES)
    s = summary(r)
    for d in r.outputs["Decide"]:
        line = f"{d['id']}  {d['route']:<9} {d.get('summary') or ''}"
        if d["issues"]:
            line += "  -> needs a person: " + "; ".join(d["issues"])
        print(line)
        for f in d["flags"]:
            print(" " * 15 + "· " + f)
        if d.get("draft"):
            dr = d["draft"]
            print(" " * 15 + f"draft for {dr['approver']} to approve ({dr['by']}" + (f", model draft rejected: {dr['rejected']}" if dr["rejected"] else "") + ")")
    for e, why in s["skipped"]:
        print(f"{e}  skipped   {why}")
    for t in r.trace:
        if "after" in t[2]:
            print(f"retry: {t[0]} for {t[1]}: {t[2]}")
    ev = evals.run()
    print(f"\n{ev['passed']}/{ev['total']} emails handled as expected · {ev['sent']} emails sent automatically · "
          f"{len(ev['drafts_rejected'])} unsafe model drafts replaced · {ev['spoofs_caught']} lookalike senders held")
    return 0 if ev["passed"] == ev["total"] and ev["sent"] == 0 else 1


def main(argv):
    cmd = argv[0] if argv else "demo"
    if cmd == "demo":
        return demo()
    if cmd == "eval":
        ev = evals.run()
        print(json.dumps({k: v for k, v in ev.items() if k != "cases"}, indent=2))
        return 0 if ev["passed"] == ev["total"] and ev["sent"] == 0 else 1
    if cmd == "build":
        import workflow.build as b
        b.build()
        print("wrote workflow/inbox-agent.json")
        return 0
    if cmd == "site":
        from . import site
        print("wrote", site.build())
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
