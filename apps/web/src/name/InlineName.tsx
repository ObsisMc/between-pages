import { useState } from 'react';
import { Button } from '../ui/index.ts';
import { NameForm } from './NameForm.tsx';

/**
 * A name with "修改" beside it (display-name D6), for the moments the partner first sees it:
 * the invitation form on 设置 → 搭档 and the /join confirm page. Editing happens in place and
 * the page stays where it is.
 */
export function InlineName({ name }: { name: string }) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <span className="mt-2 block">
        <NameForm
          current={name}
          autoFocus
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </span>
    );
  return (
    <>
      <strong className="font-medium text-ink">{name}</strong>
      <span aria-hidden="true"> · </span>
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 align-baseline text-warm"
        aria-label={`修改名字 ${name}`}
        onClick={() => setEditing(true)}
      >
        修改
      </Button>
    </>
  );
}
