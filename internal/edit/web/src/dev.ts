// Entry point of the dev page (npm run dev:editor): the shell on the mock Api.
// Page query parameters pick the mock's starting point: `?check=fixture` sends
// check.json (one diagnostic of every kind) and `?history=fixture` starts from
// history.json. `window.infergoMock` exposes the mock and `window.infergoStore`
// the store, so a console or a Playwright script can drive both.
import { start } from './main';
import { mockApi, type MockApi } from './mock';
import type { Store } from './store';

declare global {
  interface Window { infergoMock?: MockApi; infergoStore?: Store }
}

const params = new URLSearchParams(location.search);
const api = mockApi({
  check: params.get('check') === 'fixture' ? 'fixture' : 'computed',
  history: params.get('history') === 'fixture' ? 'fixture' : 'empty',
});
window.infergoMock = api;
void start(api).then(store => { window.infergoStore = store; });
