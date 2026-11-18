import { z } from 'zod';
import { PageGoogleCopy } from './backup.ts';
import { ClientBinding } from './diaries.ts';
import { RecordUnread, Stamp } from './space-records.ts';
import { UserSummary } from './users.ts';

// Shared pages wire shapes (shared-pages ADR). The text travels over the collaboration
// socket like a diary's, with the page's ID in `diaryId`; here are the list, the title and
// the page as it opens.

const Uuid = z.uuid();
const Timestamp = z.iso.datetime({ offset: true });
const Revision = z.number().int().positive();

/** Actions on a page (D3, D5); the database accepts only these. */
export const SharedPageActionKind = z.enum(['renamed', 'wrote']);

/** Empty shows as "未命名页面" (D1). */
const PageTitle = z.string().trim().max(60);

export const SharedPageParams = z.object({ pageId: Uuid });

export const SharedPage = z
  .object({
    id: Uuid,
    title: z.string(),
    authorId: Uuid,
    /** Counts renames; `expectedRevision` of the next one. */
    revision: Revision,
    /** The last commit of its text or its last rename. */
    updatedAt: Timestamp,
    renamed: Stamp.nullable(),
    unread: RecordUnread,
    /** What a seen report sends back (space-records D8). */
    mark: z.number().int().nonnegative(),
  })
  .meta({ id: 'SharedPage' });

/** A page the partner deleted after the caller wrote in it or renamed it (D3). */
export const SharedPageNote = z
  .object({
    id: Uuid,
    title: z.string(),
    deleted: Stamp,
    /** The caller wrote in it, not only renamed it. */
    wrote: z.boolean(),
    unread: z.boolean(),
    mark: z.number().int().nonnegative(),
  })
  .meta({ id: 'SharedPageNote' });

export const SharedPagesResponse = z
  .object({
    me: UserSummary,
    partner: UserSummary,
    readOnly: z.boolean(),
    pages: z.array(SharedPage),
    notes: z.array(SharedPageNote),
  })
  .meta({ id: 'SharedPagesResponse' });

export const CreateSharedPageRequest = z
  .strictObject({ requestId: Uuid, title: PageTitle })
  .meta({ id: 'CreateSharedPageRequest' });

export const SharedPageResponse = z.object({ page: SharedPage }).meta({ id: 'SharedPageResponse' });

/** The page as it opens: the same state a diary opens with. */
export const SharedPageStateResponse = z
  .object({
    page: SharedPage,
    readOnly: z.boolean(),
    /**
     * The binding period this state was read in, null while unbound. Input written in one
     * period is never sent in another: it becomes drafts (shared-pages D4).
     */
    periodId: Uuid.nullable(),
    generationId: Uuid,
    seq: z.int().nonnegative(),
    state: z.base64(),
    bindings: z.array(ClientBinding),
    /** The page's Doc in the caller's own Drive (google-copy-beyond-diaries D8). */
    google: PageGoogleCopy,
  })
  .meta({ id: 'SharedPageStateResponse' });

export const RenameSharedPageRequest = z
  .strictObject({ requestId: Uuid, expectedRevision: Revision, title: PageTitle })
  .meta({ id: 'RenameSharedPageRequest' });
