import { Link } from 'react-router';
import { useBinding } from './queries.ts';

/**
 * The home's line for each open invitation addressed to the caller's Google email
 * (in-app-invitation-by-email D5), under the backup banner. "查看" opens the usual confirm page
 * by ID; nothing binds before "接受邀请" there.
 */
export function InvitationBanner() {
  const invitations = useBinding().data?.invitationsForMe ?? [];
  return invitations.map((invitation) => (
    <p key={invitation.id} className="mb-6 rounded-xl bg-accent px-4 py-3 text-sm text-ink">
      {invitation.mode === 'restore'
        ? `${invitation.inviter.displayName} 邀请你恢复你们的空间`
        : `${invitation.inviter.displayName} 邀请你一起写日记`}{' '}
      ·{' '}
      <Link to={`/join?invite=${invitation.id}`} className="text-warm underline underline-offset-4">
        查看
      </Link>
    </p>
  ));
}
