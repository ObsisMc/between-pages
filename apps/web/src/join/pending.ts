import { InvitationToken } from '@between-pages/contracts';

// One invitation token waiting for the login round trip (spaces-and-invitations D12): kept
// in this tab's sessionStorage only, never in Query, the URL after reading, or any log.
// Without sessionStorage it lives in memory, which a signed-in tab can still finish with.

const KEY = 'between-pages-pending-invite';
let inMemory: string | null = null;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // SecurityError: storage is disabled for this page; memory is the fallback.
    return null;
  }
}

export function keepPendingInvite(token: string): void {
  inMemory = token;
  try {
    storage()?.setItem(KEY, token);
  } catch {
    // QuotaExceededError or disabled storage: the in-memory copy still serves this page.
  }
}

/** The kept token, if it still looks like one. */
export function pendingInvite(): string | null {
  const stored = storage()?.getItem(KEY) ?? inMemory;
  return stored && InvitationToken.safeParse(stored).success ? stored : null;
}

/** Whether a token can survive leaving the page to sign in. */
export const canKeepAcrossLogin = () => storage() !== null;

export function clearPendingInvite(): void {
  inMemory = null;
  storage()?.removeItem(KEY);
}

/** The token in a `#token=…` fragment, if well formed. */
export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token && InvitationToken.safeParse(token).success ? token : null;
}
