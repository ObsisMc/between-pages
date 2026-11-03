import { useState } from 'react';
import type { EditIntent } from '../editor-binding/index.ts';
import { Button } from '../ui/index.ts';
import { groupDrafts } from './drafts.ts';
import type { DiaryDraft } from './session.ts';

const reasonText: Record<DiaryDraft['reason'], string> = {
  rejected: '服务器没有接受这段输入',
  'stale-generation': '写在已经更新的版本上',
};

const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Only text the user wrote may be copied back (kernel D7); a deletion is shown, not offered. */
const copyable = (intent: EditIntent) =>
  intent.kind === 'insert' ? intent.text : intent.kind === 'replace' ? intent.inserted : null;

function Intent({ intent, onCopy }: { intent: EditIntent; onCopy: (text: string) => void }) {
  const text = copyable(intent);
  return (
    <div className="grid justify-items-start gap-1">
      <p className="whitespace-pre-wrap text-ink [&_del]:text-ink-soft [&_ins]:bg-notice [&_ins]:no-underline">
        {intent.before}
        {intent.kind === 'insert' && <ins>{intent.text}</ins>}
        {intent.kind === 'delete' && <del>{intent.text}</del>}
        {intent.kind === 'replace' && (
          <>
            <del>{intent.deleted}</del>
            <ins>{intent.inserted}</ins>
          </>
        )}
        {intent.after}
      </p>
      <p className="text-sm text-ink-soft">
        {intent.kind === 'insert' && '新写的文字，未进入正文'}
        {intent.kind === 'delete' && '原本要删除的文字，正文里没有删除'}
        {intent.kind === 'replace' && '替换：划线的是原文，新写的部分可以复制'}
      </p>
      {text && (
        <Button type="button" variant="outline" size="sm" onClick={() => onCopy(text)}>
          复制新写的文字
        </Button>
      )}
    </div>
  );
}

/** Recovery drafts: view, copy and explicit delete only, never replayed (kernel D7). */
export function DraftList({
  drafts,
  onDelete,
}: {
  drafts: DiaryDraft[];
  onDelete: (draftIds: string[]) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  if (drafts.length === 0) return null;

  const copy = (text: string) => {
    setCopied(false);
    void navigator.clipboard?.writeText(text).then(() => setCopied(true));
  };

  return (
    <section className="mt-6 border-t border-dashed border-line pt-5" aria-label="恢复草稿">
      <h2 className="font-serif text-lg font-medium">恢复草稿</h2>
      <p className="mt-1 text-sm text-ink-soft">
        这些输入没有进入正文。需要的话复制后粘贴回正文，会作为你的新输入保存。
      </p>
      {copied && (
        <p role="status" className="mt-2 text-sm text-done">
          已复制
        </p>
      )}
      <ul className="mt-4 grid gap-3">
        {groupDrafts(drafts).map((group) => {
          const key = group.draftIds[0]!;
          return (
            <li
              key={key}
              className="grid justify-items-start gap-3 rounded-xl border border-line p-4"
            >
              <p className="text-sm text-ink-soft">
                {reasonText[group.reason]} · 写于 {time.format(group.writtenAt)}
              </p>
              {group.intents.map((intent, i) => (
                <Intent key={i} intent={intent} onCopy={copy} />
              ))}
              {confirming === key ? (
                <Button type="button" size="sm" onClick={() => onDelete(group.draftIds)}>
                  确认删除这条草稿
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(key)}>
                  删除草稿
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
