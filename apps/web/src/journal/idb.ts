// IndexedDB without a wrapper library (kernel ADR: none is approved). Only reads are awaited
// inside a transaction; writes are issued without waiting, since a failed one aborts the
// whole transaction and surfaces through `transact`.

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new DOMException('Request failed'));
  });
}

/**
 * Runs `body` in one transaction and resolves only once it is complete, which is when its
 * writes count as stored (D7). If `body` throws, nothing it wrote is kept.
 */
export async function transact<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  // Chromium's default durability reports completion before the data reaches the disk.
  const tx = db.transaction(stores, mode, { durability: 'strict' });
  const settled = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
  try {
    const result = await body(tx);
    await settled;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // InvalidStateError: the transaction already finished or is aborting.
    }
    await settled.catch(() => undefined);
    throw error;
  }
}
