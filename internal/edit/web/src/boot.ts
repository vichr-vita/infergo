// Entry point of the shipped editor.js: the shell on the real server Api.
// build.mjs fails if the mock ever reaches this bundle.
import { serverApi } from './api';
import { start } from './main';

void start(serverApi());
