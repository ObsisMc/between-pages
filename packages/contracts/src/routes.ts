import { z } from 'zod';
import {
  CharacterInfo,
  CharacterParams,
  CharacterQuery,
  DiaryListPage,
  DiaryListQuery,
  DiaryParams,
  DiaryResponse,
  HistoryPage,
  HistoryQuery,
  HistoryVersion,
  HistoryVersionParams,
  OpenDiaryRequest,
  OpenDiaryResponse,
  ReadRangesResponse,
  ReceiptQuery,
  ReceiptResponse,
  ReportReadRequest,
  ShareParams,
  SharedDiaryListPage,
  SharedDiaryResponse,
} from './diaries.ts';
import { BackupResponse, FinishGoogleRequest, StartGoogleResponse } from './backup.ts';
import {
  ClocksResponse,
  ClockSettings,
  ReportTimezoneRequest,
  SaveSleepRequest,
} from './clocks.ts';
import { PokesResponse, SeenPokesRequest, SendPokeRequest } from './pokes.ts';
import {
  DayParams,
  DayResponse,
  DaysPage,
  DaysQuery,
  NextUnreadQuery,
  NextUnreadResponse,
} from './days.ts';
import { ReportSeenRequest, ReportSeenResponse, SpaceUnreadResponse } from './space-records.ts';
import {
  AnniversariesQuery,
  AnniversariesResponse,
  AnniversaryDetailResponse,
  AnniversaryParams,
  AnniversaryResponse,
  CreateAnniversaryRequest,
  EditAnniversaryRequest,
  SaveReminderRequest,
  SetAnniversaryCountRequest,
  SetAnniversaryDateRequest,
} from './anniversaries.ts';
import {
  ActionRequest,
  CreateWishRequest,
  DeletedResponse,
  EditGiftRequest,
  EditWishRequest,
  GiftParams,
  GiftResponse,
  PrepareGiftRequest,
  ReceiveWishResponse,
  SaveCardRequest,
  SetGiftDateRequest,
  SetGiftOccasionRequest,
  WishParams,
  WishResponse,
  WishesResponse,
} from './wishes.ts';
import {
  CreateSharedPageRequest,
  RenameSharedPageRequest,
  SharedPageParams,
  SharedPageResponse,
  SharedPageStateResponse,
  SharedPagesResponse,
} from './shared-pages.ts';
import {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  BindingResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  DismissInvitationResponse,
  EmptyRequest,
  InvitationParams,
  MySharingResponse,
  PreviewInvitationRequest,
  PreviewInvitationResponse,
  RevokeInvitationResponse,
  SaveMySharingRequest,
  SaveMySharingResponse,
  SpaceParams,
  SpaceResponse,
  SpacesResponse,
  UnbindRequest,
  UnbindResponse,
} from './spaces.ts';
import {
  MailResponse,
  SaveMailRequest,
  UnsubscribeCategoryResponse,
  UnsubscribeQuery,
  UnsubscribeRedirect,
  UnsubscribeRequest,
  UnsubscribeResponse,
} from './mail.ts';
import { UpdateMeRequest, UserSummary } from './users.ts';

// Every HTTP route the web client may call. The API registers handlers from these
// definitions and the client builds requests from them, so the path, method and
// response shape cannot drift apart.
export interface RouteDefinition<Response extends z.ZodType = z.ZodType> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: `/api/${string}`;
  summary: string;
  // 'user' routes answer 401 without a session; public ones must say so explicitly
  // (authentication-and-sessions invariant 13).
  access: 'public' | 'user';
  /** Path parameters, named as the `:name` segments of `path`. */
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: Response;
}

export const HealthResponse = z
  .object({
    status: z.literal('ok'),
  })
  .meta({ id: 'HealthResponse' });

export const MeResponse = z.object({ user: UserSummary }).meta({ id: 'MeResponse' });

export const routes = {
  health: {
    method: 'GET',
    path: '/api/health',
    summary: 'Report that the API process is serving requests.',
    access: 'public',
    response: HealthResponse,
  },
  me: {
    method: 'GET',
    path: '/api/me',
    summary: 'Return the signed-in user.',
    access: 'user',
    response: MeResponse,
  },
  updateMe: {
    method: 'PATCH',
    path: '/api/me',
    summary:
      'Rename the caller; the answer is the caller as GET /api/me returns it (display-name D7).',
    access: 'user',
    body: UpdateMeRequest,
    response: MeResponse,
  },
  diaries: {
    method: 'GET',
    path: '/api/diaries',
    summary: "List the caller's own diaries, newest date first, one page per `before` date.",
    access: 'user',
    query: DiaryListQuery,
    response: DiaryListPage,
  },
  openDiary: {
    method: 'POST',
    path: '/api/diaries',
    summary:
      "Open the caller's diary for today in the given time zone, or for a past date, creating it if missing.",
    access: 'user',
    body: OpenDiaryRequest,
    response: OpenDiaryResponse,
  },
  diary: {
    method: 'GET',
    path: '/api/diaries/:diaryId',
    summary: "Open one of the caller's diaries: its current text, generation and seq.",
    access: 'user',
    params: DiaryParams,
    response: DiaryResponse,
  },
  receipt: {
    method: 'GET',
    path: '/api/diaries/:diaryId/receipt',
    summary: "Look up the caller's committed batch by batch ID or by one operation ID.",
    access: 'user',
    params: DiaryParams,
    query: ReceiptQuery,
    response: ReceiptResponse,
  },
  history: {
    method: 'GET',
    path: '/api/diaries/:diaryId/history',
    summary: 'List history points of a diary, newest first, one page per opaque cursor.',
    access: 'user',
    params: DiaryParams,
    query: HistoryQuery,
    response: HistoryPage,
  },
  historyVersion: {
    method: 'GET',
    path: '/api/diaries/:diaryId/history/:publicId',
    summary: 'Read one committed version as server-rendered, read-only author runs.',
    access: 'user',
    params: HistoryVersionParams,
    response: HistoryVersion,
  },
  readRanges: {
    method: 'GET',
    path: '/api/diaries/:diaryId/read',
    summary: "The caller's own read coverage of a diary they may read, merged across devices.",
    access: 'user',
    params: DiaryParams,
    response: ReadRangesResponse,
  },
  reportRead: {
    method: 'POST',
    path: '/api/diaries/:diaryId/read',
    summary:
      'Add characters the caller saw on screen to their own read coverage; no one else ever learns of it.',
    access: 'user',
    params: DiaryParams,
    body: ReportReadRequest,
    response: ReadRangesResponse,
  },
  sharedDiary: {
    method: 'GET',
    path: '/api/diaries/:diaryId/shares/:epochId',
    summary:
      "Open the partner's diary shared with the caller as one epoch: live, or frozen at the version sharing stopped.",
    access: 'user',
    params: ShareParams,
    response: SharedDiaryResponse,
  },
  character: {
    method: 'GET',
    path: '/api/diaries/:diaryId/characters/:clientId/:clock',
    summary: 'Who wrote one visible character and when, in the text the caller may read.',
    access: 'user',
    params: CharacterParams,
    query: CharacterQuery,
    response: CharacterInfo,
  },
  binding: {
    method: 'GET',
    path: '/api/binding',
    summary: "The caller's current binding and their latest open invitation.",
    access: 'user',
    response: BindingResponse,
  },
  spaces: {
    method: 'GET',
    path: '/api/spaces',
    summary: 'Spaces the caller takes part in, current or archived.',
    access: 'user',
    response: SpacesResponse,
  },
  space: {
    method: 'GET',
    path: '/api/spaces/:spaceId',
    summary: 'One space the caller takes part in, with its binding periods. No sharing range.',
    access: 'user',
    params: SpaceParams,
    response: SpaceResponse,
  },
  createInvitation: {
    method: 'POST',
    path: '/api/binding/invitations',
    summary:
      "Open a seven-day invitation link, closing the caller's previous one; a repeated requestId returns it without its token.",
    access: 'user',
    body: CreateInvitationRequest,
    response: CreateInvitationResponse,
  },
  revokeInvitation: {
    method: 'POST',
    path: '/api/binding/invitations/:inviteId/revoke',
    summary: "Revoke one of the caller's invitations; revoking it again changes nothing.",
    access: 'user',
    params: InvitationParams,
    body: EmptyRequest,
    response: RevokeInvitationResponse,
  },
  previewInvitation: {
    method: 'POST',
    path: '/api/binding/invitations/preview',
    summary:
      'Show who invited the caller and whether it starts or restores a space; binds nothing.',
    access: 'user',
    body: PreviewInvitationRequest,
    response: PreviewInvitationResponse,
  },
  acceptInvitation: {
    method: 'POST',
    path: '/api/binding/invitations/accept',
    summary:
      "Bind the caller to the inviter, storing each confirmed sharing range and opening that person's covered diaries to the other.",
    access: 'user',
    body: AcceptInvitationRequest,
    response: AcceptInvitationResponse,
  },
  dismissInvitation: {
    method: 'POST',
    path: '/api/binding/invitations/:inviteId/dismiss',
    summary:
      'Hide an invitation addressed to the caller from the caller only; the inviter sees no change.',
    access: 'user',
    params: InvitationParams,
    body: EmptyRequest,
    response: DismissInvitationResponse,
  },
  unbind: {
    method: 'POST',
    path: '/api/spaces/:spaceId/unbind',
    summary: 'End the given binding period for both participants; the space and its history stay.',
    access: 'user',
    params: SpaceParams,
    body: UnbindRequest,
    response: UnbindResponse,
  },
  mySharing: {
    method: 'GET',
    path: '/api/spaces/:spaceId/my-sharing',
    summary: "The caller's own sharing range in a space; never the partner's.",
    access: 'user',
    params: SpaceParams,
    response: MySharingResponse,
  },
  sharedDiaries: {
    method: 'GET',
    path: '/api/spaces/:spaceId/shared-diaries',
    summary:
      "The partner's diaries shared with the caller in a space, live or frozen, newest date first.",
    access: 'user',
    params: SpaceParams,
    query: DiaryListQuery,
    response: SharedDiaryListPage,
  },
  days: {
    method: 'GET',
    path: '/api/days',
    summary:
      "List the dates with the caller's own or the partner's shared diary, newest first, with list unread marks.",
    access: 'user',
    query: DaysQuery,
    response: DaysPage,
  },
  nextUnread: {
    method: 'GET',
    path: '/api/days/next-unread',
    summary:
      'The nearest date older than `before` or newer than `after` whose diaries have list unread for the caller.',
    access: 'user',
    query: NextUnreadQuery,
    response: NextUnreadResponse,
  },
  backup: {
    method: 'GET',
    path: '/api/backup',
    summary: "The caller's own Google Drive connection and backup problems.",
    access: 'user',
    response: BackupResponse,
  },
  startGoogleConnection: {
    method: 'POST',
    path: '/api/backup/google/start',
    summary: 'Start connecting Google Drive (drive.file only): returns the consent URL.',
    access: 'user',
    body: EmptyRequest,
    response: StartGoogleResponse,
  },
  finishGoogleConnection: {
    method: 'POST',
    path: '/api/backup/google/finish',
    summary: 'Finish connecting Google Drive with the code and state the consent page returned.',
    access: 'user',
    body: FinishGoogleRequest,
    response: BackupResponse,
  },
  disconnectGoogle: {
    method: 'POST',
    path: '/api/backup/google/disconnect',
    summary: 'Disconnect Google Drive: the grant is revoked at Google; Drive files stay.',
    access: 'user',
    body: EmptyRequest,
    response: BackupResponse,
  },
  runBackup: {
    method: 'POST',
    path: '/api/backup/run',
    summary: 'Back up every waiting day now, without waiting for its history point ("现在备份").',
    access: 'user',
    body: EmptyRequest,
    response: BackupResponse,
  },
  day: {
    method: 'GET',
    path: '/api/days/:date',
    summary:
      "One date's own and shared diaries, as on the day list, with the caller's own Google copy of it.",
    access: 'user',
    params: DayParams,
    response: DayResponse,
  },
  saveMySharing: {
    method: 'PUT',
    path: '/api/spaces/:spaceId/my-sharing',
    summary:
      "Confirm the caller's sharing range for the open period, opening covered diaries to the partner and freezing ones no longer covered.",
    access: 'user',
    params: SpaceParams,
    body: SaveMySharingRequest,
    response: SaveMySharingResponse,
  },
  clocks: {
    method: 'GET',
    path: '/api/clocks',
    summary:
      "The caller's time zone and sleep schedule, and the partner's while the two are bound.",
    access: 'user',
    response: ClocksResponse,
  },
  reportTimezone: {
    method: 'PUT',
    path: '/api/me/timezone',
    summary: "Record the IANA time zone the caller's browser reports.",
    access: 'user',
    body: ReportTimezoneRequest,
    response: ClockSettings,
  },
  pokes: {
    method: 'GET',
    path: '/api/pokes',
    summary:
      "The partner's pokes and pets the caller has not seen yet, while the two are bound (window-mascots D4).",
    access: 'user',
    response: PokesResponse,
  },
  sendPoke: {
    method: 'POST',
    path: '/api/pokes',
    summary:
      "Pokes or pets the current partner's mascot, counted at most once a second per kind; the answer is the caller's own waiting pokes.",
    access: 'user',
    body: SendPokeRequest,
    response: PokesResponse,
  },
  seenPokes: {
    method: 'POST',
    path: '/api/pokes/seen',
    summary: 'Takes the pokes and pets the caller has shown off what is waiting for them.',
    access: 'user',
    body: SeenPokesRequest,
    response: PokesResponse,
  },
  saveSleep: {
    method: 'PUT',
    path: '/api/me/sleep',
    summary: "Set or clear the caller's usual sleep schedule.",
    access: 'user',
    body: SaveSleepRequest,
    response: ClockSettings,
  },
  spaceUnread: {
    method: 'GET',
    path: '/api/space/unread',
    summary:
      'How many records of each space feature hold something the caller has not seen, for the entry dots.',
    access: 'user',
    response: SpaceUnreadResponse,
  },
  reportSeen: {
    method: 'POST',
    path: '/api/space/seen',
    summary:
      'Records the caller has had on screen for about a second, each at the mark it came with.',
    access: 'user',
    body: ReportSeenRequest,
    response: ReportSeenResponse,
  },
  sharedPages: {
    method: 'GET',
    path: '/api/shared-pages',
    summary: 'Every page of the space, newest first, and deletion notes.',
    access: 'user',
    response: SharedPagesResponse,
  },
  createSharedPage: {
    method: 'POST',
    path: '/api/shared-pages',
    summary: 'Start a new page of the space; its text is written over the sync socket.',
    access: 'user',
    body: CreateSharedPageRequest,
    response: SharedPageResponse,
  },
  sharedPage: {
    method: 'GET',
    path: '/api/shared-pages/:pageId',
    summary: 'One page as it opens, with its committed state.',
    access: 'user',
    params: SharedPageParams,
    response: SharedPageStateResponse,
  },
  renameSharedPage: {
    method: 'PUT',
    path: '/api/shared-pages/:pageId/title',
    summary: "Change a page's title, from the revision it was loaded at; either of the two may.",
    access: 'user',
    params: SharedPageParams,
    body: RenameSharedPageRequest,
    response: SharedPageResponse,
  },
  deleteSharedPage: {
    method: 'POST',
    path: '/api/shared-pages/:pageId/delete',
    summary: 'Delete a page for both; either of the two may.',
    access: 'user',
    params: SharedPageParams,
    body: ActionRequest,
    response: DeletedResponse,
  },
  wishes: {
    method: 'GET',
    path: '/api/wishes',
    summary:
      "Both wish lists, the caller's own gifts in preparation, the gift wall and deletion notes.",
    access: 'user',
    response: WishesResponse,
  },
  createWish: {
    method: 'POST',
    path: '/api/wishes',
    summary: 'Add a wish of the caller.',
    access: 'user',
    body: CreateWishRequest,
    response: WishResponse,
  },
  editWish: {
    method: 'PUT',
    path: '/api/wishes/:wishId',
    summary: "Change one of the caller's wishes, from the revision it was loaded at.",
    access: 'user',
    params: WishParams,
    body: EditWishRequest,
    response: WishResponse,
  },
  deleteWish: {
    method: 'POST',
    path: '/api/wishes/:wishId/delete',
    summary: "Delete one of the caller's wishes.",
    access: 'user',
    params: WishParams,
    body: ActionRequest,
    response: DeletedResponse,
  },
  receiveWish: {
    method: 'POST',
    path: '/api/wishes/:wishId/received',
    summary:
      '"收到了" on one of the caller\'s wishes: it moves to the gift wall as a gift from the partner.',
    access: 'user',
    params: WishParams,
    body: ActionRequest,
    response: ReceiveWishResponse,
  },
  prepareGift: {
    method: 'POST',
    path: '/api/gifts',
    summary:
      'Start preparing a gift, for a wish of the partner or as a surprise; only the caller sees it until it is revealed.',
    access: 'user',
    body: PrepareGiftRequest,
    response: GiftResponse,
  },
  editGift: {
    method: 'PUT',
    path: '/api/gifts/:giftId',
    summary: 'Change the name or link of a gift the caller created.',
    access: 'user',
    params: GiftParams,
    body: EditGiftRequest,
    response: GiftResponse,
  },
  deleteGift: {
    method: 'POST',
    path: '/api/gifts/:giftId/delete',
    summary: 'Delete a gift the caller created; for one in preparation, stop preparing it.',
    access: 'user',
    params: GiftParams,
    body: ActionRequest,
    response: DeletedResponse,
  },
  revealGift: {
    method: 'POST',
    path: '/api/gifts/:giftId/reveal',
    summary:
      'Reveal a gift the caller is preparing: it and its card reach the partner and the gift wall.',
    access: 'user',
    params: GiftParams,
    body: ActionRequest,
    response: GiftResponse,
  },
  saveGiftCard: {
    method: 'PUT',
    path: '/api/gifts/:giftId/card',
    summary: "Write or change the giver's card of a gift.",
    access: 'user',
    params: GiftParams,
    body: SaveCardRequest,
    response: GiftResponse,
  },
  setGiftDate: {
    method: 'PUT',
    path: '/api/gifts/:giftId/date',
    summary: "Change a revealed gift's date on the gift wall; either of the two may.",
    access: 'user',
    params: GiftParams,
    body: SetGiftDateRequest,
    response: GiftResponse,
  },
  setGiftOccasion: {
    method: 'PUT',
    path: '/api/gifts/:giftId/occasion',
    summary:
      "Set or clear a revealed gift's occasion, a generic one or an anniversary; either of the two may.",
    access: 'user',
    params: GiftParams,
    body: SetGiftOccasionRequest,
    response: GiftResponse,
  },
  anniversaries: {
    method: 'GET',
    path: '/api/anniversaries',
    summary:
      "Every anniversary of the space with its next day, counted in the partner's local date except the caller's own birthday, and the one for the home strip.",
    access: 'user',
    query: AnniversariesQuery,
    response: AnniversariesResponse,
  },
  anniversary: {
    method: 'GET',
    path: '/api/anniversaries/:anniversaryId',
    summary: 'One anniversary with its date in every year so far and the gifts given for it.',
    access: 'user',
    params: AnniversaryParams,
    query: AnniversariesQuery,
    response: AnniversaryDetailResponse,
  },
  createAnniversary: {
    method: 'POST',
    path: '/api/anniversaries',
    summary: 'Add an anniversary of the space; at most one together day per space.',
    access: 'user',
    query: AnniversariesQuery,
    body: CreateAnniversaryRequest,
    response: AnniversaryResponse,
  },
  editAnniversary: {
    method: 'PUT',
    path: '/api/anniversaries/:anniversaryId',
    summary:
      'Change the kind, whose birthday, name or note of an anniversary the caller added, from the revision it was loaded at.',
    access: 'user',
    params: AnniversaryParams,
    query: AnniversariesQuery,
    body: EditAnniversaryRequest,
    response: AnniversaryResponse,
  },
  deleteAnniversary: {
    method: 'POST',
    path: '/api/anniversaries/:anniversaryId/delete',
    summary: 'Delete an anniversary the caller added; gifts given for it keep its name.',
    access: 'user',
    params: AnniversaryParams,
    body: ActionRequest,
    response: DeletedResponse,
  },
  setAnniversaryDate: {
    method: 'PUT',
    path: '/api/anniversaries/:anniversaryId/date',
    summary: "Correct an anniversary's date; either of the two may.",
    access: 'user',
    params: AnniversaryParams,
    query: AnniversariesQuery,
    body: SetAnniversaryDateRequest,
    response: AnniversaryResponse,
  },
  setAnniversaryCount: {
    method: 'PUT',
    path: '/api/anniversaries/:anniversaryId/count',
    summary: 'Turn the day count of an anniversary with a year on or off; either of the two may.',
    access: 'user',
    params: AnniversaryParams,
    query: AnniversariesQuery,
    body: SetAnniversaryCountRequest,
    response: AnniversaryResponse,
  },
  saveAnniversaryReminder: {
    method: 'PUT',
    path: '/api/anniversaries/:anniversaryId/reminder',
    summary:
      "Set how many days ahead the caller is reminded of an anniversary; only the caller's own setting, allowed while unbound.",
    access: 'user',
    params: AnniversaryParams,
    query: AnniversariesQuery,
    body: SaveReminderRequest,
    response: AnniversaryResponse,
  },
  mail: {
    method: 'GET',
    path: '/api/mail',
    summary:
      "The caller's own email reminder switches, the address mails go to, and whether the home notice was closed.",
    access: 'user',
    response: MailResponse,
  },
  saveMail: {
    method: 'PUT',
    path: '/api/mail',
    summary: "Change the caller's own reminder switches, or close the home notice for good.",
    access: 'user',
    body: SaveMailRequest,
    response: MailResponse,
  },
  unsubscribeLink: {
    method: 'GET',
    path: '/api/mail/unsubscribe',
    summary:
      'The List-Unsubscribe address opened in a browser: 303 to the unsubscribe page with the same token; changes nothing.',
    access: 'public',
    query: UnsubscribeQuery,
    response: UnsubscribeRedirect,
  },
  unsubscribeCategory: {
    method: 'GET',
    path: '/api/mail/unsubscribe/category',
    summary:
      'Which category an unsubscribe token turns off; 404 for an invalid token. Changes nothing.',
    access: 'public',
    query: UnsubscribeQuery,
    response: UnsubscribeCategoryResponse,
  },
  unsubscribe: {
    method: 'POST',
    path: '/api/mail/unsubscribe',
    summary:
      "Turn off the token's category for its user (RFC 8058 one-click, or the unsubscribe page); the only write without an Origin check; 404 for an invalid token.",
    access: 'public',
    query: UnsubscribeQuery,
    body: UnsubscribeRequest,
    response: UnsubscribeResponse,
  },
} as const satisfies Record<string, RouteDefinition>;

export type RouteName = keyof typeof routes;
export type ResponseOf<Name extends RouteName> = z.infer<(typeof routes)[Name]['response']>;

type InputOf<
  Name extends RouteName,
  Key extends 'params' | 'query' | 'body',
> = (typeof routes)[Name] extends { [K in Key]: infer Schema extends z.ZodType }
  ? z.infer<Schema>
  : undefined;
export type ParamsOf<Name extends RouteName> = InputOf<Name, 'params'>;
export type QueryOf<Name extends RouteName> = InputOf<Name, 'query'>;
export type BodyOf<Name extends RouteName> = InputOf<Name, 'body'>;
