const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');

module.exports = () => {
  execFileSync('go', ['run', './examples/bonus-viewer', '.view-test/bonus.html'], { stdio: 'inherit' });
  const html = readFileSync('.view-test/bonus.html', 'utf8');
  const marker = /(<script id="infergo-data" type="application\/json">)(.*?)(<\/script>)/s;
  const data = JSON.parse(html.match(marker)[2]);
  function save(name, value) {
    const json = JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
    writeFileSync(`.view-test/${name}.html`, html.replace(marker, (_, before, _data, after) => before + json + after));
  }
  save('topology', { ...data, cases: [] });
  save('empty', { ...data, cases: [], rules: [], edges: [], inputCount: 0, outputCount: 0 });
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
