import { useState } from 'react';
import { X } from 'lucide-react';
import type { DateRange, DateSelection } from '@between-pages/contracts';
import {
  Button,
  CheckboxLabel,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ToggleGroup,
  ToggleGroupItem,
} from '../ui/index.ts';
import { ALL_DAYS, NO_DAYS, describeRanges, describeSelection, isAllDays } from './range.ts';
import { MonthView } from './MonthView.tsx';

/** What the editor holds: a valid selection, or "not set now" (only when allowed). */
export type RangeChoice = { kind: 'selection'; selection: DateSelection } | { kind: 'unset' };

type Mode = 'all' | 'custom' | 'unset';
/** What a click on the calendar does while choosing: start or close a shared range, or exclude a day. */
type Tool = 'include' | 'exclude';
type Kind = 'include' | 'exclude';

/** Items shown per kind before "展开全部", so many ranges never grow the page without bound. */
const SHOWN = 3;

const choiceOf = (mode: Mode, ranges: DateSelection): RangeChoice =>
  mode === 'unset'
    ? { kind: 'unset' }
    : { kind: 'selection', selection: mode === 'all' ? ALL_DAYS : ranges };

const sameRange = (a: DateRange, b: DateRange) => a.from === b.from && a.to === b.to;
const dayLabel = (day: string) => {
  const [, month, date] = day.split('-').map(Number);
  return `${month} 月 ${date} 日`;
};

/** "共享 3 段 · 排除 2 天": exclusions count in days while every one is a single day. */
function countText({ include, exclude }: DateSelection): string {
  const parts: string[] = [];
  if (include.length) parts.push(`共享 ${include.length} 段`);
  if (exclude.length) {
    const days = exclude.every((r) => r.from !== null && r.from === r.to);
    parts.push(`排除 ${exclude.length} ${days ? '天' : '段'}`);
  }
  return parts.join(' · ');
}

function Chip({ text, onRemove }: { text: string; onRemove: () => void }) {
  return (
    <li className="inline-flex min-h-9 max-w-full items-center gap-1 rounded-full border border-line py-0.5 pr-1 pl-3.5 text-sm">
      <span className="min-w-0">{text}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 rounded-full"
        aria-label={`删除 ${text}`}
        onClick={onRemove}
      >
        <X aria-hidden="true" />
      </Button>
    </li>
  );
}

/** One kind's chips: the first three, the rest behind a shadcn Collapsible. */
function ChipList({
  label,
  prefix,
  ranges,
  onRemove,
}: {
  label: string;
  prefix: string;
  ranges: readonly DateRange[];
  onRemove: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  if (ranges.length === 0) return null;
  const chip = (range: DateRange, i: number) => (
    <Chip
      key={`${range.from}${range.to}`}
      text={`${prefix} ${describeRanges([range])}`}
      onRemove={() => onRemove(i)}
    />
  );
  const list = 'flex flex-wrap gap-2';
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      role="group"
      aria-label={label}
      className="grid justify-items-start gap-2"
    >
      <ul className={list}>{ranges.slice(0, SHOWN).map(chip)}</ul>
      <CollapsibleContent asChild>
        <ul className={list}>{ranges.slice(SHOWN).map((r, i) => chip(r, i + SHOWN))}</ul>
      </CollapsibleContent>
      {ranges.length > SHOWN && (
        <CollapsibleTrigger asChild>
          <Button type="button" variant="link" size="sm">
            {open ? '收起' : `展开全部（${ranges.length}）`}
          </Button>
        </CollapsibleTrigger>
      )}
    </Collapsible>
  );
}

/**
 * Chooses the dates this person keeps sharing in a space (spaces-and-invitations D3, D12):
 * everything, or day ranges picked on the calendar — two clicks close a range, the same
 * day twice is a single day, and from the first click the range may be left open at either
 * end; in 排除 mode one click excludes a day (a second click on it takes that back). Beside
 * the calendar (under it on a narrow box): the click mode, a count, "清空共享" / "清空排除",
 * and each range as a removable chip, three per kind before "展开全部". Or, where
 * `allowUnset`, not setting a range now. Only 自选 shows a calendar. Only its owner ever
 * sees it. Confirming it is what shares the diaries of those dates (kernel D5); the caller
 * asks for that.
 */
export function RangeEditor({
  initial,
  today,
  allowUnset = false,
  onChange,
}: {
  /** The starting selection; null starts unset (or everything when unset is not allowed). */
  initial: DateSelection | null;
  /** The viewer's local today, `YYYY-MM-DD`: the month the calendar opens on. */
  today: string;
  allowUnset?: boolean;
  onChange: (choice: RangeChoice) => void;
}) {
  const startMode: Mode =
    initial === null ? (allowUnset ? 'unset' : 'all') : isAllDays(initial) ? 'all' : 'custom';
  const [mode, setMode] = useState<Mode>(startMode);
  const [ranges, setRanges] = useState<DateSelection>(
    initial && startMode === 'custom' ? initial : NO_DAYS,
  );
  const [tool, setTool] = useState<Tool>('include');
  // The first day clicked while adding a shared range, until the range closes.
  const [anchor, setAnchor] = useState<string | null>(null);
  const choice = choiceOf(mode, ranges);

  const update = (next: { mode?: Mode; ranges?: DateSelection }) => {
    const m = next.mode ?? mode;
    const r = next.ranges ?? ranges;
    if (next.mode) setMode(m);
    if (next.ranges) setRanges(r);
    onChange(choiceOf(m, r));
  };
  const addInclude = (range: DateRange) => {
    setAnchor(null);
    if (ranges.include.some((r) => sameRange(r, range))) return;
    update({ ranges: { ...ranges, include: [...ranges.include, range] } });
  };
  const remove = (kind: Kind, index: number) =>
    update({ ranges: { ...ranges, [kind]: ranges[kind].filter((_, i) => i !== index) } });
  const clear = (kind: Kind) => {
    if (kind === 'include') setAnchor(null);
    update({ ranges: { ...ranges, [kind]: [] } });
  };

  const pick = (day: string) => {
    if (tool === 'exclude') {
      const one = { from: day, to: day };
      const at = ranges.exclude.findIndex((r) => sameRange(r, one));
      if (at >= 0) remove('exclude', at);
      else update({ ranges: { ...ranges, exclude: [...ranges.exclude, one] } });
      return;
    }
    if (anchor === null) setAnchor(day);
    else addInclude(anchor <= day ? { from: anchor, to: day } : { from: day, to: anchor });
  };

  const summary = (
    <p className="text-sm text-ink-soft" aria-live="polite">
      {choice.kind === 'unset'
        ? '暂不设置共享范围，以后可以单独设置'
        : describeSelection(choice.selection)}
    </p>
  );
  const picked = ranges.include.length + ranges.exclude.length > 0;

  return (
    <div className="@container grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 font-sans text-ink">
      <div role="radiogroup" aria-label="共享日期" className="grid gap-2">
        <CheckboxLabel>
          <input type="radio" checked={mode === 'all'} onChange={() => update({ mode: 'all' })} />
          全部历史与以后的日期
        </CheckboxLabel>
        <CheckboxLabel>
          <input
            type="radio"
            checked={mode === 'custom'}
            onChange={() => update({ mode: 'custom' })}
          />
          自选日期
        </CheckboxLabel>
        {allowUnset && (
          <CheckboxLabel>
            <input
              type="radio"
              checked={mode === 'unset'}
              onChange={() => update({ mode: 'unset' })}
            />
            暂不设置
          </CheckboxLabel>
        )}
      </div>
      {mode !== 'custom' ? (
        summary
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 @xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] @xl:items-start">
          <MonthView selection={ranges} today={today} anchor={anchor} onDayClick={pick} />
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
            <ToggleGroup
              type="single"
              aria-label="点日历时"
              value={tool}
              onValueChange={(v) => {
                if (!v) return;
                setTool(v as Tool);
                setAnchor(null);
              }}
            >
              <ToggleGroupItem value="include">添加共享</ToggleGroupItem>
              <ToggleGroupItem value="exclude">添加排除</ToggleGroupItem>
            </ToggleGroup>
            {anchor === null ? (
              <p className="text-sm text-ink-soft">
                {tool === 'include'
                  ? '点两天选一段，同一天点两次选单日。'
                  : '点一天把它排除在共享之外；排除优先于共享。'}
              </p>
            ) : (
              <div className="grid justify-items-start gap-2">
                <p className="text-sm text-ink-soft">
                  已点选 {dayLabel(anchor)}：再点一天成一段，再点这天为单日，或者
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addInclude({ from: anchor, to: null })}
                  >
                    从这天起一直共享
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addInclude({ from: null, to: anchor })}
                  >
                    到这天为止
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAnchor(null)}>
                    取消
                  </Button>
                </div>
              </div>
            )}
            {picked && (
              <div role="group" aria-label="已选的日期段" className="grid gap-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm font-medium">{countText(ranges)}</span>
                  {ranges.include.length > 0 && (
                    <Button type="button" variant="link" size="sm" onClick={() => clear('include')}>
                      清空共享
                    </Button>
                  )}
                  {ranges.exclude.length > 0 && (
                    <Button type="button" variant="link" size="sm" onClick={() => clear('exclude')}>
                      清空排除
                    </Button>
                  )}
                </div>
                <ChipList
                  label="共享的日期段"
                  prefix="共享"
                  ranges={ranges.include}
                  onRemove={(i) => remove('include', i)}
                />
                <ChipList
                  label="排除的日期"
                  prefix="排除"
                  ranges={ranges.exclude}
                  onRemove={(i) => remove('exclude', i)}
                />
              </div>
            )}
            {summary}
          </div>
        </div>
      )}
    </div>
  );
}
