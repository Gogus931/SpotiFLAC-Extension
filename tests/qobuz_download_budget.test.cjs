const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { CASES, createHost } = require('./qobuz_download_budget_cases.js');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../sources/qobuz-web/index.js'),
  'utf8'
);

// The extension declares its top-level functions in the context itself, so the
// context object is the api the cases drive.
function load(overrides) {
  const host = createHost(overrides);
  const context = vm.createContext(host.globals);
  vm.runInContext(SOURCE, context, { filename: 'qobuz-web/index.js' });
  return { api: context, state: host.state };
}

for (const testCase of CASES) {
  test(testCase.name, () => {
    testCase.run(load);
  });
}
