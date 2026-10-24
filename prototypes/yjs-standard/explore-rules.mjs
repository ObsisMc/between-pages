import { Authority } from './authority.mjs';
import { Client, paragraphs, runs } from './harness.mjs';

// What breaks if Enter inside the other person's text is simply forbidden?
function scenario(name, steps) {
  const auth = new Authority();
  const A = new Client('A', paragraphs, auth), B = new Client('B', paragraphs, auth);
  const sync = () => { A.pull(); B.pull(); };
  console.log(`\n== ${name}`);
  steps({ A, B, sync, show: l => console.log(' ', l.padEnd(26), JSON.stringify(runs(auth.doc, auth.owner))) });
}
scenario('a. B Enter at start of A paragraph', ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAAA', 1)); A.flush(); sync();
  B.edit(tr => tr.split(1)); console.log('  B', B.flush()); show('server');
});
scenario('b. B deletes own char next to identical A char', ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('天气', 1)); A.flush(); sync();
  B.edit(tr => tr.insertText('天', 2)); B.flush(); sync(); show('before');   // A天 B天 A气
  B.edit(tr => tr.delete(2, 3)); console.log('  B deletes its own 天:', B.flush()); show('server');
});
scenario('c. A deletes own char next to identical B char', ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('哈', 1)); A.flush(); sync();
  B.edit(tr => tr.insertText('哈哈', 2)); B.flush(); sync(); show('before');  // A哈 B哈哈
  A.edit(tr => tr.delete(1, 2)); console.log('  A deletes its own 哈:', A.flush()); show('server');
});
scenario('d. B types same char right after identical A char', ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('好', 1)); A.flush(); sync();
  B.edit(tr => tr.insertText('好', 1)); console.log('  B inserts 好 before A 好:', B.flush()); show('server');
});
scenario('e. B joins own paragraph that contains A insertion', ({ A, B, sync, show }) => {
  B.edit(tr => tr.insertText('BB', 1)); B.edit(tr => tr.split(3)); B.edit(tr => tr.insertText('BBBB', 5)); B.flush(); sync();
  A.edit(tr => tr.insertText('A', 7)); A.flush(); sync(); show('before');
  B.edit(tr => tr.join(4)); console.log('  B joins:', B.flush()); show('server');
});
scenario('f. concurrent: B splits own paragraph while A inserts in its tail', ({ A, B, sync, show }) => {
  B.edit(tr => tr.insertText('BBBBBB', 1)); B.flush(); sync();
  A.edit(tr => tr.insertText('a', 6)); B.edit(tr => tr.split(4));
  console.log('  A', A.flush(), 'B', B.flush()); sync(); show('server');
  console.log('  expected: B"BBB" ¶ B"BB" A"a" B"B"');
});
