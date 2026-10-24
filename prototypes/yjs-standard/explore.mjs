import { Authority } from './authority.mjs';
import { Client, paragraphs, breaks, runs } from './harness.mjs';

function setup(schema) {
  const auth = new Authority();
  const A = new Client('A', schema, auth), B = new Client('B', schema, auth);
  const sync = () => { A.pull(); B.pull(); };
  return { auth, A, B, sync, show: label => console.log(label.padEnd(44), JSON.stringify(runs(auth.doc, auth.owner))) };
}
function scenario(name, schema, steps) {
  console.log(`\n== ${name}`);
  const ctx = setup(schema);
  steps(ctx);
}
const textEnd = pm => pm.content.size - 1;

scenario('1. B inserts inside A sentence', paragraphs, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('今天很累，但是想到你就开心了。', 1)); console.log('A flush', A.flush()); sync();
  B.edit(tr => tr.insertText('抱抱！', 1 + 5)); console.log('B flush', B.flush()); sync(); show('after');
});
scenario('2. B deletes A char (UI bug)', paragraphs, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAAA', 1)); A.flush(); sync();
  B.edit(tr => tr.delete(2, 3)); console.log('B flush', B.flush()); sync(); show('server');
});
scenario('3. paragraphs: B presses Enter inside A text', paragraphs, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAAAAA', 1)); A.flush(); sync();
  B.edit(tr => tr.split(4)); console.log('B flush', B.flush()); show('server');
});
scenario('4. paragraphs: B presses Enter at end of A text, then types', paragraphs, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAAAAA', 1)); A.flush(); sync();
  B.edit(tr => tr.split(7)); B.edit((tr) => tr.insertText('BBB', 9)); console.log('B flush', B.flush()); show('server');
});
scenario('5. paragraphs: A two paragraphs, B appends own paragraph then joins it back (Backspace)', paragraphs, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAA', 1)); A.flush(); sync();
  B.edit(tr => tr.split(4)); B.edit(tr => tr.insertText('BBB', 6)); B.flush(); sync(); show('before join');
  B.edit(tr => tr.join(5)); console.log('B flush', B.flush()); show('server');
});
scenario('6. paragraphs: B joins A second paragraph into A first (Backspace at A para start)', paragraphs, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAA', 1)); A.edit(tr => tr.split(4)); A.edit(tr => tr.insertText('aaa', 6)); A.flush(); sync(); show('before');
  B.edit(tr => tr.join(5)); console.log('B flush', B.flush()); show('server');
});
scenario('7. paragraphs: A first para, B inserts text in middle of A para 2', paragraphs, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAA', 1)); A.edit(tr => tr.split(4)); A.edit(tr => tr.insertText('aaaa', 6)); A.flush(); sync();
  B.edit(tr => tr.insertText('BB', 8)); console.log('B flush', B.flush()); show('server');
});
scenario('8. hard_break: B inserts newline inside A text', breaks, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAAAAA', 1)); A.flush(); sync();
  B.edit((tr, s) => tr.insert(4, s.nodes.hard_break.create())); console.log('B flush', B.flush()); show('server');
});
scenario('9. hard_break: B newline at end of A text then types', breaks, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAAAAA', 1)); A.flush(); sync();
  B.edit((tr, s) => tr.insert(7, s.nodes.hard_break.create())); B.edit(tr => tr.insertText('BBB', 8)); console.log('B flush', B.flush()); show('server');
});
scenario('10. hard_break: B deletes own newline between A runs', breaks, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAAAAA', 1)); A.flush(); sync();
  B.edit((tr, s) => tr.insert(4, s.nodes.hard_break.create())); B.flush(); sync(); show('before');
  B.edit(tr => tr.delete(4, 5)); console.log('B flush', B.flush()); show('server');
});
scenario('11. paragraphs: B types inside A text while A types concurrently elsewhere', paragraphs, ({ A, B, sync, show }) => {
  A.edit(tr => tr.insertText('AAAAAA', 1)); A.flush(); sync();
  A.edit(tr => tr.insertText('xx', 7)); B.edit(tr => tr.insertText('BB', 3));
  console.log('A', A.flush(), 'B', B.flush()); sync(); show('server');
  console.log('A sees', A.pm().textContent, ' B sees', B.pm().textContent);
});
