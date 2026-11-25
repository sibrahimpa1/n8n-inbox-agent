// Runs one n8n Code node ("Run once for all items") outside n8n, with the parts of
// the n8n Code-node API the workflow uses: $input, $('Node').all()/.first()/.itemMatching(i)
// and $getWorkflowStaticData('global'). Input and output are JSON on stdin/stdout.
const fs = require("fs");
const req = JSON.parse(fs.readFileSync(0, "utf8"));

const nodes = req.nodes || {};
const pairs = req.pairs || {};
const staticData = req.static || {};

function $(name) {
  const items = nodes[name];
  if (!items) throw new Error("Node '" + name + "' hasn't been executed");
  return {
    all: () => items,
    first: () => items[0],
    itemMatching: (i) => {
      const map = pairs[name];
      const idx = map ? map[i] : i;
      if (idx == null || !items[idx]) throw new Error("no paired item " + i + " in '" + name + "'");
      return items[idx];
    },
  };
}
const $input = { all: () => req.items, first: () => req.items[0] };
function $getWorkflowStaticData() { return staticData; }

let result;
try {
  const fn = new Function("$", "$input", "$getWorkflowStaticData", "module", "window", req.code);
  result = { items: fn($, $input, $getWorkflowStaticData, undefined, undefined), static: staticData };
} catch (e) {
  result = { error: String(e && e.stack || e) };
}
process.stdout.write(JSON.stringify(result));
