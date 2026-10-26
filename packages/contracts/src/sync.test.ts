import { describe, expect, it } from 'vitest';
import { ClientMessage, ReceiptQuery, ServerMessage } from './index.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const submit = {
  v: 1,
  type: 'submit',
  diaryId: uuid(1),
  batchId: uuid(2),
  generationId: uuid(3),
  operations: [{ operationId: uuid(4), update: 'AAE=', writtenAt: '2026-10-26T08:00:00+08:00' }],
};

describe('client messages', () => {
  it('accepts a submit and a subscribe of the current protocol', () => {
    expect(ClientMessage.safeParse(submit).success).toBe(true);
    const subscribe = { v: 1, type: 'subscribe', diaryId: uuid(1), generationId: uuid(3) };
    expect(ClientMessage.safeParse({ ...subscribe, knownSeq: 0 }).success).toBe(true);
  });

  it('rejects unknown fields, so a client cannot claim an author or actor', () => {
    expect(ClientMessage.safeParse({ ...submit, actor: uuid(9) }).success).toBe(false);
    const operations = [{ ...submit.operations[0], author: uuid(9) }];
    expect(ClientMessage.safeParse({ ...submit, operations }).success).toBe(false);
  });

  it('rejects another protocol version, an empty batch and repeated operation IDs', () => {
    expect(ClientMessage.safeParse({ ...submit, v: 2 }).success).toBe(false);
    expect(ClientMessage.safeParse({ ...submit, operations: [] }).success).toBe(false);
    const twice = [submit.operations[0], submit.operations[0]];
    expect(ClientMessage.safeParse({ ...submit, operations: twice }).success).toBe(false);
  });
});

describe('server messages', () => {
  it('are parsed leniently, so the server can add fields without a new version', () => {
    const error = { v: 1, type: 'error', code: 'INTERNAL', message: 'x', addedLater: true };
    expect(ServerMessage.parse(error)).toEqual({
      v: 1,
      type: 'error',
      code: 'INTERNAL',
      message: 'x',
    });
  });
});

describe('receipt query', () => {
  it('takes exactly one of batch ID and operation ID', () => {
    expect(ReceiptQuery.safeParse({ batchId: uuid(1) }).success).toBe(true);
    expect(ReceiptQuery.safeParse({ operationId: uuid(1) }).success).toBe(true);
    expect(ReceiptQuery.safeParse({}).success).toBe(false);
    expect(ReceiptQuery.safeParse({ batchId: uuid(1), operationId: uuid(2) }).success).toBe(false);
  });
});
