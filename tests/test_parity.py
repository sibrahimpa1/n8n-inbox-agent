"""The live demo runs src/pipeline.js in the browser. It must decide exactly
what the replay of the n8n workflow decides."""
import json
import subprocess

from harness.replay import DEFAULT_FAILURES, ROOT, load, replay


def test_browser_pipeline_matches_workflow_replay():
    script = """
const {runInbox} = require(process.argv[1]);
const i = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(runInbox(i.emails, i.recorded, i.world, {failures: i.failures})));
"""
    inp = {"emails": load("emails.json"), "recorded": load("recorded.json"), "world": load("world.json"),
           "failures": {f"{k[0]}|{k[1]}": v for k, v in DEFAULT_FAILURES.items()}}
    res = subprocess.run(["node", "-e", script, str(ROOT / "src" / "pipeline.js")], input=json.dumps(inp),
                         capture_output=True, text=True, check=True)
    js = {r["id"]: r for r in json.loads(res.stdout)}
    r = replay(DEFAULT_FAILURES)
    py = {d["id"]: d for d in r.outputs["Decide"]}
    for e in load("emails.json"):
        b = js[e["id"]]
        if e["id"] not in py:
            assert b["route"] in ("skipped", "archived")
            continue
        p = py[e["id"]]
        assert (b["route"], b["issues"], b["flags"], b.get("draft")) == (p["route"], p["issues"], p["flags"], p.get("draft")), e["id"]
