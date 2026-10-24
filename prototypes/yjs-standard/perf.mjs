import * as Y from 'yjs';
import { Authority } from './authority.mjs';
import { textClient } from './text-model.mjs';

// Server-side cost of validating + applying one keystroke on a fragmented document.
const p95 = xs => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
let seed = 7; const rand = n => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
for (const size of [10_000, 100_000]) {
  const auth = new Authority();
  const A = textClient('A', auth), B = textClient('B', auth);
  const t0 = performance.now();
  while (auth.doc.getText('body').length < size) {
    const who = rand(2) ? A : B;
    who.pull();
    who.insert(rand(who.text.length + 1), '日记'.repeat(10));
    who.flush();
  }
  const build = performance.now() - t0;
  B.pull();
  const check = [], apply = [], encode = [];
  for (let i = 0; i < 200; i++) {
    let update;
    const s = performance.now();
    B.doc.once('update', u => { update = u; });
    B.doc.transact(() => B.text.insert(rand(B.text.length + 1), '好'), 'B');
    encode.push(performance.now() - s);
    const c = performance.now(); auth.check('B', update); check.push(performance.now() - c);
    const a = performance.now(); Y.applyUpdate(auth.doc, update); apply.push(performance.now() - a);
  }
  const state = Y.encodeStateAsUpdate(auth.doc).length;
  console.log(JSON.stringify({ chars: auth.doc.getText('body').length, items: [...auth.doc.store.clients.values()].reduce((n, s) => n + s.length, 0),
    buildMs: Math.round(build), clientEditP95: +p95(encode).toFixed(3), serverCheckP95: +p95(check).toFixed(3),
    serverApplyP95: +p95(apply).toFixed(3), stateBytes: state, bytesPerChar: +(state / size).toFixed(2) }));
}
