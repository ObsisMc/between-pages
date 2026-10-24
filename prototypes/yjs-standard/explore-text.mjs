import { Authority } from './authority.mjs';
import { textClient, textRuns } from './text-model.mjs';
const auth = new Authority();
const A = textClient('A', auth), B = textClient('B', auth);
const sync = () => { A.pull(); B.pull(); };
const show = l => console.log(l.padEnd(40), JSON.stringify(textRuns(auth.doc, auth.owner)).replaceAll('\\n', '↵'));
A.insert(0, 'AAAAAA'); console.log('A', A.flush()); sync();
B.insert(3, '\n'); console.log('B newline inside A text', B.flush()); sync(); show('server');
B.insert(4, 'BB'); B.flush(); sync(); show('B types on new line');
B.remove(3, 1); console.log('B deletes own newline', B.flush()); sync(); show('server');
B.remove(1, 1); console.log('B deletes A char (bug)', B.flush());
// personal undo: A undoes its own later insertion; B text inside stays
const auth2 = new Authority(); const A2 = textClient('A', auth2), B2 = textClient('B', auth2);
A2.insert(0, '今天很累，但是想到你就开心了。'); A2.flush(); B2.pull();
B2.insert(5, '抱抱！'); B2.flush(); A2.pull();
A2.undo.undo(); console.log('A undo all own text', A2.flush()); B2.pull();
console.log('after A undo'.padEnd(40), JSON.stringify(textRuns(auth2.doc, auth2.owner)));
A2.undo.redo(); console.log('A redo', A2.flush());
console.log('after A redo'.padEnd(40), JSON.stringify(textRuns(auth2.doc, auth2.owner)));
