const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { buildSync } = require('esbuild');

module.exports = () => {
  execFileSync('go', ['run', './examples/bonus-viewer', '.view-test/bonus.html'], { stdio: 'inherit' });
  const html = readFileSync('.view-test/bonus.html', 'utf8');
  const marker = /(<script id="infergo-data" type="application\/json">)(.*?)(<\/script>)/s;
  const data = JSON.parse(html.match(marker)[2]);
  function save(name, value, bundle) {
    const template = bundle ? html.replace(readFileSync('viewer/viewer.js', 'utf8'), () => bundle) : html;
    const json = JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
    writeFileSync(`.view-test/${name}.html`, template.replace(marker, (_, before, _data, after) => before + json + after));
  }
  save('topology', { ...data, cases: [] });
  save('empty', { ...data, cases: [], rules: [], edges: [], inputCount: 0, outputCount: 0 });
  // Reduced synthetic DAG reproducing Dagre 3.1.1's parallel-edge crash.
  // Every fact has one producer; three distinct facts flow from Rule0 to Rule2.
  const connections = [[0, 1], [0, 2], [0, 2], [0, 2], [0, 3], [1, 2], [1, 3]];
  const edges = connections.map(([from, to], index) => ({ from, to, fact: `fact${index}` }));
  const fact = name => ({ name, type: 'int' });
  const rules = Array.from({ length: 4 }, (_, index) => ({
    id: `Rule${index}`, requirement: 'Synthetic rule.', source: `func Rule${index}() int { return ${index} }`,
    inputs: edges.filter(edge => edge.to === index).map(edge => fact(edge.fact)),
    outputs: [...edges.filter(edge => edge.from === index).map(edge => fact(edge.fact)), fact(`result${index}`)],
  }));
  const parallel = {
    title: 'Parallel facts', inputCount: 0, outputCount: 1, outputs: [fact('result3')], rules, edges,
    cases: ['first', 'second'].map((id, scenario) => ({
      id, label: id, inputs: {},
      trace: rules.map(rule => ({ rule: rule.id, kind: 'succeeded', facts: Object.fromEntries(rule.outputs.map(fact => [fact.name, String(scenario + 1)])) })),
    })),
  };
  save('parallel', parallel);
  // Bundle the real viewer with a fault at its layout dependency boundary.
  // No test hook is shipped in exported viewers.
  const faults = {
    throw: 'throw new Error("Injected layout failure")',
    bounds: 'realLayout(graph); graph.graph().width = NaN',
    node: 'realLayout(graph); graph.node("0").x = NaN',
    edge: 'realLayout(graph); graph.edge(graph.edges()[0]).points[1].x = NaN',
  };
  for (const [name, fault] of Object.entries(faults)) {
    const dependency = resolve(`.view-test/layout-${name}.js`);
    writeFileSync(dependency, `import { Graph, layout as realLayout } from ${JSON.stringify(require.resolve('@dagrejs/dagre'))};
export { Graph };
export function layout(graph) { ${fault}; }`);
    const bundle = buildSync({
      entryPoints: ['viewer/viewer.ts'], bundle: true, format: 'iife', write: false,
      alias: { '@dagrejs/dagre': dependency },
    }).outputFiles[0].text;
    save(`layout-${name}`, parallel, bundle);
  }
  const longName = 'GoodPerformanceWithAnUnusuallyLongRuleName'.repeat(4);
  data.rules[0].id = longName;
  data.rules[0].requirement = 'Long requirement '.repeat(30);
  data.rules[0].source += '\n// ' + 'UnbrokenSourceToken'.repeat(60);
  for (const scenario of data.cases) {
    scenario.trace[0].rule = longName;
    scenario.inputs.employeeID = '"' + 'VeryLongEmployeeIdentifier'.repeat(40) + '"';
    for (const trace of scenario.trace) {
      if (trace.rule === 'PaymentReference') trace.facts.paymentReference = '"' + 'BONUS-LongReference'.repeat(60) + '"';
    }
  }
  data.cases[0].label = '</script><img src=x onerror="window.injected=true">' + 'LongScenarioName'.repeat(30);
  save('long', data);
};
