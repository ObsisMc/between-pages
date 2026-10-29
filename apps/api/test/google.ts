import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { DRIVE_FILE_SCOPE, GOOGLE_ENDPOINTS, type GoogleEndpoints } from '../src/google/oauth.ts';

// A local stand-in for Google's token endpoint, Drive and Docs, as far as the readable copy
// uses them (server-backup-and-google-docs D6–D10). It checks PKCE, refuses another
// account's files, applies Docs batchUpdate requests to plain text, and refuses a write
// whose required revision is not current, as Google does.

export type FakeFile = {
  id: string;
  owner: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  modifiedTime: string;
  revision: number;
  /** A Doc's body without its final newline. */
  text: string;
  headings: { text: string; level: number }[];
  colors: { text: string; rgb: number[] }[];
};

type Range = { startIndex: number; endIndex: number };
type DocRequest = {
  deleteContentRange?: { range: Range };
  insertText?: { location: { index: number }; text: string };
  updateParagraphStyle?: { range: Range; paragraphStyle: { namedStyleType: string } };
  updateTextStyle?: {
    range: Range;
    textStyle: { foregroundColor?: { color: { rgbColor: Record<string, number> } } };
  };
};

const read = async (req: IncomingMessage) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
};

export async function startFakeGoogle() {
  const state = {
    files: new Map<string, FakeFile>(),
    /** consent code → PKCE challenge and account */
    grants: new Map<string, { challenge: string; permissionId: string; email: string }>(),
    /** refresh token → account */
    refreshTokens: new Map<string, string>(),
    /** Every call, as "METHOD path", for counting what reached Google. */
    calls: [] as string[],
    down: false,
    storageFull: false,
    /** Runs just before a batchUpdate's revision check, e.g. to edit the Doc in between. */
    beforeBatch: null as ((file: FakeFile) => void) | null,
  };

  const apiError = (status: number, reason: string) => ({
    error: { code: status, status: reason, errors: [{ reason }] },
  });

  function applyBatch(file: FakeFile, requests: DocRequest[]) {
    const at = (index: number) => index - 1;
    for (const r of requests) {
      if (r.deleteContentRange) {
        const { startIndex, endIndex } = r.deleteContentRange.range;
        file.text = file.text.slice(0, at(startIndex)) + file.text.slice(at(endIndex));
      } else if (r.insertText) {
        const i = at(r.insertText.location.index);
        file.text = file.text.slice(0, i) + r.insertText.text + file.text.slice(i);
      } else if (r.updateParagraphStyle) {
        const { range, paragraphStyle } = r.updateParagraphStyle;
        if (paragraphStyle.namedStyleType === 'NORMAL_TEXT') file.headings = [];
        else
          file.headings.push({
            text: file.text.slice(at(range.startIndex), at(range.endIndex)),
            level: Number(paragraphStyle.namedStyleType.replace('HEADING_', '')),
          });
      } else if (r.updateTextStyle) {
        const { range, textStyle } = r.updateTextStyle;
        const rgb = textStyle.foregroundColor?.color.rgbColor;
        if (!rgb) file.colors = [];
        else
          file.colors.push({
            text: file.text.slice(at(range.startIndex), at(range.endIndex)),
            rgb: [rgb.red ?? 0, rgb.green ?? 0, rgb.blue ?? 0],
          });
      }
    }
  }

  const server = createServer(async (req, res) => {
    const json = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://fake');
    state.calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await read(req));
      if (form.get('grant_type') === 'refresh_token') {
        const account = state.refreshTokens.get(form.get('refresh_token') ?? '');
        if (!account) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: `access-${account}`, scope: DRIVE_FILE_SCOPE });
      }
      const grant = state.grants.get(form.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (!grant || grant.challenge !== challenge) return json(400, { error: 'invalid_grant' });
      state.grants.delete(form.get('code')!);
      const refresh = `refresh-SECRET-${randomUUID()}`;
      state.refreshTokens.set(refresh, grant.permissionId);
      return json(200, {
        access_token: `access-${grant.permissionId}`,
        refresh_token: refresh,
        scope: DRIVE_FILE_SCOPE,
      });
    }
    const account = (req.headers.authorization ?? '').replace('Bearer access-', '');
    if (url.pathname === '/drive/about') {
      const email = [...state.grants.values()].find((g) => g.permissionId === account)?.email;
      return json(200, { user: { permissionId: account, emailAddress: email ?? 'x@example.com' } });
    }
    if (state.down) return json(503, apiError(503, 'backendError'));
    const own = (id: string) => {
      const file = state.files.get(id);
      return file?.owner === account ? file : undefined;
    };

    if (url.pathname === '/drive/files' && req.method === 'POST') {
      if (state.storageFull) return json(403, apiError(403, 'storageQuotaExceeded'));
      const body = JSON.parse(await read(req)) as {
        name: string;
        mimeType: string;
        parents?: string[];
      };
      if (body.parents?.some((p) => !own(p))) return json(404, apiError(404, 'notFound'));
      const id = `file-${randomUUID()}`;
      state.files.set(id, {
        id,
        owner: account,
        name: body.name,
        mimeType: body.mimeType,
        parents: body.parents ?? [],
        trashed: false,
        modifiedTime: new Date().toISOString(),
        revision: 1,
        text: '',
        headings: [],
        colors: [],
      });
      return json(200, { id });
    }
    if (url.pathname === '/drive/files' && req.method === 'GET') {
      if (url.searchParams.get('q') !== 'trashed = false')
        return json(400, apiError(400, 'badRequest'));
      const files = [...state.files.values()]
        .filter((f) => f.owner === account && !f.trashed)
        .map((f) => ({ id: f.id, modifiedTime: f.modifiedTime }));
      return json(200, { files });
    }
    const driveFile = url.pathname.match(/^\/drive\/files\/([^/]+)$/);
    if (driveFile) {
      const file = own(driveFile[1]!);
      if (!file) return json(404, apiError(404, 'notFound'));
      if (req.method === 'PATCH') {
        Object.assign(file, JSON.parse(await read(req)) as { name: string });
        return json(200, { id: file.id });
      }
      return json(200, { trashed: file.trashed });
    }
    const doc = url.pathname.match(/^\/docs\/documents\/([^/:]+)(:batchUpdate)?$/);
    if (doc) {
      const file = own(doc[1]!);
      if (!file) return json(404, apiError(404, 'notFound'));
      if (!doc[2])
        return json(200, {
          revisionId: `rev-${file.revision}`,
          body: { content: [{ endIndex: 1 }, { endIndex: file.text.length + 2 }] },
        });
      const body = JSON.parse(await read(req)) as {
        requests: DocRequest[];
        writeControl: { requiredRevisionId: string };
      };
      state.beforeBatch?.(file);
      state.beforeBatch = null;
      if (body.writeControl.requiredRevisionId !== `rev-${file.revision}`)
        return json(400, apiError(400, 'badRequest'));
      applyBatch(file, body.requests);
      file.revision += 1;
      file.modifiedTime = new Date().toISOString();
      return json(200, { writeControl: { requiredRevisionId: `rev-${file.revision}` } });
    }
    json(404, apiError(404, 'notFound'));
  });
  const base = await new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
    ),
  );
  const endpoints: GoogleEndpoints = {
    ...GOOGLE_ENDPOINTS,
    token: `${base}/token`,
    revoke: `${base}/revoke`,
    drive: `${base}/drive`,
    docs: `${base}/docs`,
  };

  return {
    state,
    endpoints,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    /** Consents as `permissionId` to the authorization URL; returns what the callback page sends. */
    consent(authorizationUrl: string, permissionId: string, email = `${permissionId}@example.com`) {
      const url = new URL(authorizationUrl);
      const code = `code-${randomUUID()}`;
      state.grants.set(code, {
        challenge: url.searchParams.get('code_challenge')!,
        permissionId,
        email,
      });
      return { code, state: url.searchParams.get('state')! };
    },
    /** The account's Docs by name. */
    docs(permissionId: string) {
      return [...state.files.values()].filter(
        (f) => f.owner === permissionId && f.mimeType === 'application/vnd.google-apps.document',
      );
    },
    /** Someone moves the file to the bin. */
    trash(fileId: string) {
      state.files.get(fileId)!.trashed = true;
    },
    /** Someone empties the bin: the file is gone. */
    remove(fileId: string) {
      state.files.delete(fileId);
    },
    /** Someone edits the Doc in Google: a new revision the app did not write. */
    editInGoogle(fileId: string, text: string) {
      const file = state.files.get(fileId)!;
      file.text += text;
      file.revision += 1;
      file.modifiedTime = new Date(Date.now() + 1000).toISOString();
    },
  };
}

export type FakeGoogle = Awaited<ReturnType<typeof startFakeGoogle>>;
