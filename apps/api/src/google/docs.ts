import { z } from 'zod';
import { GoogleError, type GoogleEndpoints } from './oauth.ts';

// The Drive and Docs REST calls the readable copy makes (server-backup-and-google-docs D6–D8),
// with a short-lived access token. drive.file only reaches files this app created. Every
// response is validated where it enters the process; errors carry Google's reason, never a
// request body or token.

export const FOLDER_TYPE = 'application/vnd.google-apps.folder';
export const DOC_TYPE = 'application/vnd.google-apps.document';

/** A Doc's body as the copy writes it: plain text, heading ranges and author colors. */
export type DocBody = {
  text: string;
  /** Offsets into `text`, end exclusive. */
  headings: { start: number; end: number; level: 1 | 2 | 3 }[];
  colors: { start: number; end: number; rgb: readonly [number, number, number] }[];
};

const ApiError = z.object({
  error: z
    .object({
      status: z.string().optional(),
      errors: z.array(z.object({ reason: z.string() }).loose()).optional(),
    })
    .loose(),
});

const retryAfter = (header: string | null) => {
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
};

async function call(url: string, token: string, init: { method?: string; body?: object } = {}) {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const parsed = ApiError.safeParse(body);
    const reason = parsed.success
      ? (parsed.data.error.errors?.[0]?.reason ?? parsed.data.error.status)
      : undefined;
    throw new GoogleError(
      response.status,
      reason ?? String(response.status),
      retryAfter(response.headers.get('retry-after')),
    );
  }
  return body;
}

const Created = z.object({ id: z.string().min(1) });

/** Creates a folder or an empty Doc named `name` in `parentId` (or My Drive's root). */
export async function createFile(
  endpoints: GoogleEndpoints,
  token: string,
  input: { name: string; type: typeof FOLDER_TYPE | typeof DOC_TYPE; parentId: string | null },
): Promise<string> {
  const created = Created.parse(
    await call(`${endpoints.drive}/files?fields=id`, token, {
      method: 'POST',
      body: {
        name: input.name,
        mimeType: input.type,
        ...(input.parentId ? { parents: [input.parentId] } : {}),
      },
    }),
  );
  return created.id;
}

/** Whether the file is still usable: null when gone, `trashed` when in the bin. */
export async function fileState(
  endpoints: GoogleEndpoints,
  token: string,
  fileId: string,
): Promise<'present' | 'trashed' | null> {
  try {
    const { trashed } = z
      .object({ trashed: z.boolean() })
      .parse(await call(`${endpoints.drive}/files/${fileId}?fields=trashed`, token));
    return trashed ? 'trashed' : 'present';
  } catch (error) {
    if (error instanceof GoogleError && error.status === 404) return null;
    throw error;
  }
}

/** Renames a file; its content and revision history stay as they are. */
export async function rename(
  endpoints: GoogleEndpoints,
  token: string,
  fileId: string,
  name: string,
): Promise<void> {
  await call(`${endpoints.drive}/files/${fileId}?fields=id`, token, {
    method: 'PATCH',
    body: { name },
  });
}

const FileList = z.object({
  nextPageToken: z.string().optional(),
  files: z.array(z.object({ id: z.string(), modifiedTime: z.iso.datetime({ offset: true }) })),
});

/**
 * Every file of this app in the Drive that is not in the bin, with its last change: only
 * metadata, no content (D8 daily check). drive.file lists only files the app created.
 */
export async function listFiles(
  endpoints: GoogleEndpoints,
  token: string,
): Promise<Map<string, Date>> {
  const files = new Map<string, Date>();
  let pageToken: string | undefined;
  do {
    const url = new URL(`${endpoints.drive}/files`);
    url.search = new URLSearchParams({
      q: 'trashed = false',
      fields: 'nextPageToken,files(id,modifiedTime)',
      pageSize: '1000',
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const page = FileList.parse(await call(url.toString(), token));
    for (const file of page.files) files.set(file.id, new Date(file.modifiedTime));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

const DocState = z.object({
  revisionId: z.string().min(1),
  body: z.object({ content: z.array(z.object({ endIndex: z.number().int() }).loose()) }),
});

/** The Doc's current revision and body end, without its content; null when gone. */
export async function docRevision(
  endpoints: GoogleEndpoints,
  token: string,
  docId: string,
): Promise<{ revisionId: string; endIndex: number } | null> {
  try {
    const doc = DocState.parse(
      await call(
        `${endpoints.docs}/documents/${docId}?fields=revisionId,body.content(endIndex)`,
        token,
      ),
    );
    return { revisionId: doc.revisionId, endIndex: doc.body.content.at(-1)?.endIndex ?? 2 };
  } catch (error) {
    if (error instanceof GoogleError && error.status === 404) return null;
    throw error;
  }
}

const DocText = z.object({
  revisionId: z.string().min(1),
  title: z.string(),
  body: z.object({
    content: z.array(
      z
        .object({
          paragraph: z
            .object({
              elements: z.array(
                z.object({ textRun: z.object({ content: z.string() }).optional() }).loose(),
              ),
            })
            .loose()
            .optional(),
        })
        .loose(),
    ),
  }),
});

/**
 * The Doc's revision, title (its Drive name) and plain text without the final newline;
 * null when gone. Only to tell whether a rename the app made is all that changed
 * (google-copy-beyond-diaries 技术设计); never logged.
 */
export async function docText(
  endpoints: GoogleEndpoints,
  token: string,
  docId: string,
): Promise<{ revisionId: string; title: string; text: string } | null> {
  try {
    const doc = DocText.parse(
      await call(
        `${endpoints.docs}/documents/${docId}?fields=revisionId,title,body.content(paragraph.elements(textRun.content))`,
        token,
      ),
    );
    const text = doc.body.content
      .flatMap((c) => c.paragraph?.elements ?? [])
      .map((e) => e.textRun?.content ?? '')
      .join('');
    return { revisionId: doc.revisionId, title: doc.title, text: text.replace(/\n$/, '') };
  } catch (error) {
    if (error instanceof GoogleError && error.status === 404) return null;
    throw error;
  }
}

const rgbColor = ([red, green, blue]: readonly [number, number, number]) => ({
  color: { rgbColor: { red, green, blue } },
});

/**
 * Replaces the whole body in one batchUpdate that Google applies only while the Doc is
 * still at `requiredRevisionId` (D8); returns the revision the write produced. Docs
 * indexes count UTF-16 code units from 1, as JavaScript strings do.
 */
export async function replaceBody(
  endpoints: GoogleEndpoints,
  token: string,
  docId: string,
  current: { revisionId: string; endIndex: number },
  body: DocBody,
): Promise<string> {
  const range = (start: number, end: number) => ({ startIndex: 1 + start, endIndex: 1 + end });
  const all = range(0, body.text.length);
  const requests = [
    ...(current.endIndex > 2
      ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: current.endIndex - 1 } } }]
      : []),
    { insertText: { location: { index: 1 }, text: body.text } },
    {
      updateParagraphStyle: {
        range: all,
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        fields: 'namedStyleType',
      },
    },
    { updateTextStyle: { range: all, textStyle: {}, fields: 'foregroundColor' } },
    ...body.headings.map((h) => ({
      updateParagraphStyle: {
        range: range(h.start, h.end),
        paragraphStyle: { namedStyleType: `HEADING_${h.level}` },
        fields: 'namedStyleType',
      },
    })),
    ...body.colors.map((c) => ({
      updateTextStyle: {
        range: range(c.start, c.end),
        textStyle: { foregroundColor: rgbColor(c.rgb) },
        fields: 'foregroundColor',
      },
    })),
  ];
  const written = z
    .object({ writeControl: z.object({ requiredRevisionId: z.string().min(1) }) })
    .parse(
      await call(`${endpoints.docs}/documents/${docId}:batchUpdate`, token, {
        method: 'POST',
        body: { requests, writeControl: { requiredRevisionId: current.revisionId } },
      }),
    );
  return written.writeControl.requiredRevisionId;
}

export const folderUrl = (folderId: string) => `https://drive.google.com/drive/folders/${folderId}`;
export const docUrl = (docId: string) => `https://docs.google.com/document/d/${docId}/edit`;
