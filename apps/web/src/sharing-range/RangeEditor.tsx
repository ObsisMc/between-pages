import { useState } from 'react';
import type { DateRange, DateSelection } from '@between-pages/contracts';
import { ALL_DAYS, describeSelection, isAllDays } from './range.ts';
import { MonthView } from './MonthView.tsx';

/** What the editor holds: a valid selection, "not set now" (only when allowed), or invalid input. */
export type RangeChoice =
  { kind: 'selection'; selection: DateSelection } | { kind: 'unset' } | { kind: 'invalid' };

type Row = { from: string; fromOpen: boolean; to: string; toOpen: boolean };
type Mode = 'all' | 'custom' | 'unset';

const toRow = (range: DateRange): Row => ({
  from: range.from ?? '',
  fromOpen: range.from === null,
  to: range.to ?? '',
  toOpen: range.to === null,
});

/** null when the row is incomplete or ends before it starts. */
function toRange(row: Row): DateRange | null {
  const from = row.fromOpen ? null : row.from || undefined;
  const to = row.toOpen ? null : row.to || undefined;
  if (from === undefined || to === undefined) return null;
  if (from !== null && to !== null && from > to) return null;
  return { from, to };
}

function choiceOf(mode: Mode, include: Row[], exclude: Row[]): RangeChoice {
  if (mode === 'unset') return { kind: 'unset' };
  if (mode === 'all') return { kind: 'selection', selection: ALL_DAYS };
  const ranges = (rows: Row[]) => rows.map(toRange);
  const inc = ranges(include);
  const exc = ranges(exclude);
  if ([...inc, ...exc].some((r) => r === null)) return { kind: 'invalid' };
  return {
    kind: 'selection',
    selection: { include: inc as DateRange[], exclude: exc as DateRange[] },
  };
}

const newRow = (): Row => ({ from: '', fromOpen: false, to: '', toOpen: false });

function RowEditor({
  row,
  label,
  onChange,
  onRemove,
}: {
  row: Row;
  label: string;
  onChange: (row: Row) => void;
  onRemove: () => void;
}) {
  return (
    <fieldset className="range-row">
      <legend>{label}</legend>
      <label>
        开始
        <input
          type="date"
          value={row.from}
          disabled={row.fromOpen}
          onChange={(e) => onChange({ ...row, from: e.target.value })}
        />
      </label>
      <label className="range-open">
        <input
          type="checkbox"
          checked={row.fromOpen}
          onChange={(e) => onChange({ ...row, fromOpen: e.target.checked })}
        />
        从最早的日期
      </label>
      <label>
        结束
        <input
          type="date"
          value={row.to}
          disabled={row.toOpen}
          onChange={(e) => onChange({ ...row, to: e.target.value })}
        />
      </label>
      <label className="range-open">
        <input
          type="checkbox"
          checked={row.toOpen}
          onChange={(e) => onChange({ ...row, toOpen: e.target.checked })}
        />
        以后持续
      </label>
      <button type="button" onClick={onRemove}>
        删除这段
      </button>
    </fieldset>
  );
}

/**
 * Chooses the dates this person keeps sharing in a space (spaces-and-invitations D3, D12):
 * everything, or day ranges (a single day has equal ends) with open ends and exclusions,
 * or, where `allowUnset`, not setting a range now. Only its owner ever sees it. Confirming
 * it is what shares the diaries of those dates (kernel D5); the caller asks for that.
 */
export function RangeEditor({
  initial,
  allowUnset = false,
  onChange,
}: {
  /** The starting selection; null starts unset (or everything when unset is not allowed). */
  initial: DateSelection | null;
  allowUnset?: boolean;
  onChange: (choice: RangeChoice) => void;
}) {
  const startMode: Mode =
    initial === null ? (allowUnset ? 'unset' : 'all') : isAllDays(initial) ? 'all' : 'custom';
  const [mode, setMode] = useState<Mode>(startMode);
  const [include, setInclude] = useState<Row[]>(
    initial && startMode === 'custom' ? initial.include.map(toRow) : [],
  );
  const [exclude, setExclude] = useState<Row[]>(
    initial && startMode === 'custom' ? initial.exclude.map(toRow) : [],
  );
  const choice = choiceOf(mode, include, exclude);

  const update = (next: { mode?: Mode; include?: Row[]; exclude?: Row[] }) => {
    const m = next.mode ?? mode;
    const i = next.include ?? include;
    const x = next.exclude ?? exclude;
    if (next.mode) setMode(m);
    if (next.include) setInclude(i);
    if (next.exclude) setExclude(x);
    onChange(choiceOf(m, i, x));
  };
  const edit = (list: 'include' | 'exclude', rows: Row[], index: number, row: Row | null) => {
    const next = row
      ? rows.map((r, i) => (i === index ? row : r))
      : rows.filter((_, i) => i !== index);
    update({ [list]: next });
  };

  return (
    <div className="range-editor">
      <div role="radiogroup" aria-label="共享日期">
        <label>
          <input type="radio" checked={mode === 'all'} onChange={() => update({ mode: 'all' })} />
          全部历史与以后的日期
        </label>
        <label>
          <input
            type="radio"
            checked={mode === 'custom'}
            onChange={() => update({ mode: 'custom' })}
          />
          自选日期
        </label>
        {allowUnset && (
          <label>
            <input
              type="radio"
              checked={mode === 'unset'}
              onChange={() => update({ mode: 'unset' })}
            />
            暂不设置
          </label>
        )}
      </div>
      {mode === 'custom' && (
        <>
          {include.map((row, i) => (
            <RowEditor
              key={`i${i}`}
              row={row}
              label={`共享第 ${i + 1} 段`}
              onChange={(r) => edit('include', include, i, r)}
              onRemove={() => edit('include', include, i, null)}
            />
          ))}
          <button type="button" onClick={() => update({ include: [...include, newRow()] })}>
            添加共享日期
          </button>
          {exclude.map((row, i) => (
            <RowEditor
              key={`x${i}`}
              row={row}
              label={`排除第 ${i + 1} 段`}
              onChange={(r) => edit('exclude', exclude, i, r)}
              onRemove={() => edit('exclude', exclude, i, null)}
            />
          ))}
          <button type="button" onClick={() => update({ exclude: [...exclude, newRow()] })}>
            添加排除日期
          </button>
          <p className="range-help">单日请把开始和结束设为同一天；排除的日期优先于共享的日期。</p>
        </>
      )}
      <p className="range-summary" aria-live="polite">
        {choice.kind === 'unset'
          ? '暂不设置共享范围，以后可以单独设置'
          : choice.kind === 'invalid'
            ? '有日期段还没填完整，或结束早于开始'
            : describeSelection(choice.selection)}
      </p>
      {choice.kind === 'selection' && <MonthView selection={choice.selection} />}
    </div>
  );
}
