import { ROOT, Rejection } from '../model.mjs';
const cache = new WeakMap(), segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
// Binary-search scalar offsets; segment only the affected grapheme, not every character on each key.
function lowerBound(array, predicate) {
  let low = 0, high = array.length;
  while (low < high) { const middle = (low + high) >>> 1; if (predicate(array[middle])) high = middle; else low = middle + 1; }
  return low;
}
function group(info, position) {
  if (position < 0 || position >= info.length) return null;
  const part = info.segments.containing(position), start = part.index, end = start + part.segment.length;
  const from = lowerBound(info.atoms, x => x.end > start), to = lowerBound(info.atoms, x => x.start >= end);
  return { start, end, atoms: info.atoms.slice(from, to) };
}
export function ranges(document) {
  const old = cache.get(document);
  if (old?.version === document.records.size) return old.value;
  let offset = 0;
  const atoms = document.visible().map(atom => {
    const start = offset; offset += atom.text.length;
    return { ...atom, start, end: offset };
  });
  const text = atoms.map(x => x.text).join(''), segments = segmenter.segment(text);
  const value = { atoms, text, segments, length: offset,
    get groups() { return Array.from(segments, part => group(value, part.index)); } };
  cache.set(document, { version: document.records.size, value });
  return value;
}
export function replacement(document, actor, from, to, text) {
  const info = ranges(document);
  if (from < 0 || to < from || to > info.length) throw new Rejection('INVALID_SELECTION');
  const boundary = p => p === info.length || p === 0 || info.segments.containing(p).index === p;
  if (!boundary(from) || !boundary(to)) throw new Rejection('GRAPHEME_BOUNDARY');
  const left = lowerBound(info.atoms, x => x.end > from), right = lowerBound(info.atoms, x => x.start >= to);
  const targets = info.atoms.slice(left, right);
  if (targets.some(x => x.actor !== actor)) throw new Rejection('FOREIGN_TEXT');
  return { after: info.atoms[left - 1]?.id ?? ROOT, deleteIds: targets.map(x => x.id), text };
}
export function deletion(document, actor, caret, direction) {
  const info = ranges(document);
  let current = group(info, direction < 0 ? caret - 1 : caret);
  if (!current) return { caret: direction < 0 ? 0 : info.length, jump: true };
  const owns = item => item.atoms.every(x => x.actor === actor);
  if (owns(current)) return { from: current.start, to: current.end, jump: false };
  while (current && !owns(current)) current = group(info, direction < 0 ? current.start - 1 : current.end);
  return { caret: current ? direction < 0 ? current.end : current.start : direction < 0 ? 0 : info.length, jump: true };
}
export function anchor(document, offset, bias = 'right') {
  const { atoms } = ranges(document);
  const index = lowerBound(atoms, x => x.end > offset);
  return { left: atoms[index - 1]?.id ?? ROOT, right: atoms[index]?.id ?? null, bias };
}
export function resolve(document, position) {
  const { atoms, length } = ranges(document);
  if (!position) return length;
  const right = atoms.find(x => x.id === position.right), left = atoms.find(x => x.id === position.left);
  if (position.bias === 'left' && left) return left.end;
  if (right) return right.start;
  if (left) return left.end;
  if (position.left === ROOT) return 0;
  let id = position.left;
  while (id && id !== ROOT) {
    id = document.atoms.get(id)?.parent;
    const survivor = atoms.find(x => x.id === id);
    if (survivor) return survivor.end;
  }
  return 0;
}
