import { useId, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DisplayName, type DisplayNameRefusal } from '@between-pages/contracts';
import { ApiError, callApi } from '../api/client.ts';
import { Button, Input } from '../ui/index.ts';

// The one name editor (display-name D6, D7): the settings page and the "修改" beside a name
// on 设置 → 搭档 and /join all use it. The rule is the contract's `DisplayName`, the same the
// server applies, so a refusal reads the same before and after a round trip.

const REFUSAL: Record<DisplayNameRefusal, string> = {
  empty: '名字不能为空',
  control: '名字里不能有换行等特殊字符',
  invisible: '名字里要有看得见的字',
  long: '名字最多 20 个字',
};

/** Why this name cannot be saved, in words; null when it can. */
export function nameProblem(value: string): string | null {
  const issue = DisplayName.safeParse(value).error?.issues[0];
  if (!issue) return null;
  const reason = (issue as { params?: { reason?: DisplayNameRefusal } }).params?.reason;
  return reason ? REFUSAL[reason] : REFUSAL.empty;
}

export function NameForm({
  current,
  onSaved,
  onCancel,
  autoFocus = false,
}: {
  current: string;
  onSaved?: () => void;
  /** Shown as 取消 when given: the inline editor closes without saving. */
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const client = useQueryClient();
  const id = useId();
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const problem = nameProblem(value);
    setSaved(false);
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      const { user } = await callApi('updateMe', { body: { displayName: value } });
      setValue(user.displayName);
      // The name sits in a dozen answers; refetching all of them misses none (D3).
      await client.invalidateQueries();
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'VALIDATION_FAILED'
          ? (nameProblem(value) ?? '这个名字不能用，请换一个')
          : '没能保存，请稍后再试',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="grid gap-2" onSubmit={(event) => void save(event)} noValidate>
      <label htmlFor={id} className="sr-only">
        名字
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          value={value}
          autoFocus={autoFocus}
          autoComplete="nickname"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="max-w-xs flex-1"
          onChange={(event) => {
            setValue(event.target.value);
            setSaved(false);
          }}
        />
        <Button type="submit" disabled={busy}>
          保存
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-warm">
          {error}
        </p>
      )}
      {saved && !onSaved && <p className="text-sm text-done">已保存</p>}
    </form>
  );
}
