// Preload (node --import): registers the keytar-blocking loader hook. Every child process of the suite gets it.
import { register } from 'node:module';
register('./no-keytar-hooks.mjs', import.meta.url);
