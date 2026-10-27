import { Schema, type Node } from 'prosemirror-model';

/**
 * One block of plain text with `\n` as an ordinary character, mirroring `Y.Text('body')`
 * (ADR-0006 §11): paragraphs or hard breaks would turn Enter inside the other person's
 * text into a delete and re-create of their characters (yjs-standard spike).
 */
export const schema = new Schema({
  nodes: {
    doc: { content: 'body' },
    body: {
      content: 'text*',
      marks: '',
      code: true,
      whitespace: 'pre',
      parseDOM: [{ tag: 'div', preserveWhitespace: 'full' }],
      toDOM: () => ['div', 0],
    },
    text: {},
  },
});

export function docOf(text: string): Node {
  return schema.node('doc', null, schema.node('body', null, text ? schema.text(text) : []));
}

/** Text index of a document position: `Y.Text` index `i` sits at position `i + 1`. */
export function indexOf(doc: Node, pos: number): number {
  return Math.min(Math.max(pos - 1, 0), lengthOf(doc));
}

export function lengthOf(doc: Node): number {
  return doc.content.size - 2;
}

/** Text between two `Y.Text` indexes, clamped to the document. */
export function textOf(doc: Node, from: number, to: number): string {
  const start = Math.max(from, 0);
  const end = Math.min(to, lengthOf(doc));
  return start < end ? doc.textBetween(start + 1, end + 1) : '';
}
