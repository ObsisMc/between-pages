import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { toDate, toDay } from './day.ts';
import { ALL_DAYS, describeSelection, isExcluded, isShared } from './range.ts';
import { RangeEditor, type RangeChoice } from './RangeEditor.tsx';

afterEach(cleanup);

describe('date selection on screen', () => {
  const selection = {
    include: [
      { from: '2026-10-01', to: '2026-10-31' },
      { from: '2026-12-01', to: null },
    ],
    exclude: [{ from: '2026-10-10', to: '2026-10-10' }],
  };

  it('[adr:spaces-and-invitations#6] shares a day inside a range unless an exclusion covers it', () => {
    expect(isShared(selection, '2026-10-09')).toBe(true);
    expect(isShared(selection, '2026-10-10')).toBe(false);
    expect(isExcluded(selection, '2026-10-10')).toBe(true);
    expect(isExcluded(selection, '2026-10-09')).toBe(false);
    expect(isShared(selection, '2026-11-15')).toBe(false);
    expect(isShared(selection, '2030-01-01')).toBe(true);
    expect(isShared(ALL_DAYS, '1999-01-01')).toBe(true);
  });

  it('says the selection in words', () => {
    expect(describeSelection(selection)).toBe(
      '共享：2026-10-01 至 2026-10-31；2026-12-01 起持续；排除：2026-10-10',
    );
    expect(describeSelection({ include: [], exclude: [] })).toBe('暂不共享任何日期');
  });

  it('[adr:spaces-and-invitations#6] turns a day into a date and back without a zone', () => {
    // Runs under TZ=Etc/GMT-14 and TZ=Etc/GMT+11 as well as the machine's zone.
    expect(toDay(toDate('2026-10-05'))).toBe('2026-10-05');
    expect(toDay(toDate('2026-01-01'))).toBe('2026-01-01');
    expect(toDay(toDate('2026-12-31'))).toBe('2026-12-31');
  });
});

describe('RangeEditor', () => {
  // The tests run in November 2026 whatever the clock says.
  const TODAY = '2026-11-08';
  const day = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}，`) });
  const toOctober = () => fireEvent.click(screen.getByRole('button', { name: '上个月' }));
  const last = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.lastCall![0] as RangeChoice;
  const items = (list: string) =>
    within(screen.getByRole('group', { name: list }))
      .getAllByRole('listitem')
      .map((li) => li.textContent);

  it('opens on the month of today, marks it, and shares no day in 自选 until one is picked', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    render(<RangeEditor initial={ALL_DAYS} today={TODAY} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('自选日期'));

    expect(screen.getByText('2026 年 11 月')).toBeDefined();

    expect(last(onChange)).toEqual({
      kind: 'selection',
      selection: { include: [], exclude: [] },
    });
    expect(screen.getByRole('button', { name: '11 月 8 日，不共享，今天' })).toBeDefined();
    expect(screen.getByText('暂不共享任何日期')).toBeDefined();
  });

  it('[adr:spaces-and-invitations#6] picks single days, ranges, open ends and exclusions on the calendar', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    render(<RangeEditor initial={ALL_DAYS} today={TODAY} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('自选日期'));
    toOctober();
    expect(screen.getByText('2026 年 10 月')).toBeDefined();

    // The same day twice is a single day.
    fireEvent.click(day('10 月 5 日'));
    expect(screen.getByText(/已点选 10 月 5 日/)).toBeDefined();
    fireEvent.click(day('10 月 5 日'));
    // Two days in either order close a range.
    fireEvent.click(day('10 月 12 日'));
    fireEvent.click(day('10 月 10 日'));
    // From the first click, a range may be left open.
    fireEvent.click(day('10 月 20 日'));
    fireEvent.click(screen.getByRole('button', { name: '从这天起一直共享' }));
    // In 排除 mode one click excludes a day.
    fireEvent.click(screen.getByRole('radio', { name: '添加排除' }));
    fireEvent.click(day('10 月 11 日'));

    expect(last(onChange)).toEqual({
      kind: 'selection',
      selection: {
        include: [
          { from: '2026-10-05', to: '2026-10-05' },
          { from: '2026-10-10', to: '2026-10-12' },
          { from: '2026-10-20', to: null },
        ],
        exclude: [{ from: '2026-10-11', to: '2026-10-11' }],
      },
    });
    expect(day('10 月 5 日').getAttribute('aria-label')).toBe('10 月 5 日，共享');
    expect(day('10 月 11 日').getAttribute('aria-label')).toBe('10 月 11 日，已排除');
    expect(day('10 月 3 日').getAttribute('aria-label')).toBe('10 月 3 日，不共享');
    expect(
      screen.getByText(
        '共享：2026-10-05；2026-10-10 至 2026-10-12；2026-10-20 起持续；排除：2026-10-11',
      ),
    ).toBeDefined();

    expect(items('共享的日期段')).toEqual([
      '共享 2026-10-05',
      '共享 2026-10-10 至 2026-10-12',
      '共享 2026-10-20 起持续',
    ]);
    expect(items('排除的日期')).toEqual(['排除 2026-10-11']);
    const chips = within(screen.getByRole('group', { name: '已选的日期段' }));
    fireEvent.click(chips.getByRole('button', { name: '删除 共享 2026-10-10 至 2026-10-12' }));
    expect(last(onChange).kind === 'selection' && last(onChange)).toMatchObject({
      selection: {
        include: [
          { from: '2026-10-05', to: '2026-10-05' },
          { from: '2026-10-20', to: null },
        ],
      },
    });
  });

  it('offers "到这天为止" after a first click, and a cancel that picks nothing', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    render(<RangeEditor initial={ALL_DAYS} today={TODAY} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('自选日期'));
    onChange.mockClear();

    fireEvent.click(day('11 月 3 日'));
    expect(day('11 月 3 日').getAttribute('aria-label')).toBe('11 月 3 日，已点选');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByText(/已点选/)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(day('11 月 3 日'));
    fireEvent.click(screen.getByRole('button', { name: '到这天为止' }));
    expect(last(onChange)).toEqual({
      kind: 'selection',
      selection: { include: [{ from: null, to: '2026-11-03' }], exclude: [] },
    });
    expect(screen.getByText('共享 2026-11-03 及以前')).toBeDefined();
  });

  it('takes an exclusion back with a second click on the day', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    render(
      <RangeEditor
        initial={{ include: [{ from: '2026-11-01', to: null }], exclude: [] }}
        today={TODAY}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: '添加排除' }));
    fireEvent.click(day('11 月 4 日'));
    expect(day('11 月 4 日').getAttribute('aria-label')).toBe('11 月 4 日，已排除');
    fireEvent.click(day('11 月 4 日'));
    expect(day('11 月 4 日').getAttribute('aria-label')).toBe('11 月 4 日，共享');
    expect(last(onChange)).toEqual({
      kind: 'selection',
      selection: { include: [{ from: '2026-11-01', to: null }], exclude: [] },
    });
  });

  it('shows no calendar for 全部 or 暂不设置, only the line saying what is chosen', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    render(<RangeEditor initial={ALL_DAYS} today={TODAY} allowUnset onChange={onChange} />);
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.getByText('共享：全部历史与以后')).toBeDefined();

    fireEvent.click(screen.getByLabelText('暂不设置'));
    expect(screen.queryByRole('grid')).toBeNull();
    fireEvent.click(screen.getByLabelText('自选日期'));
    expect(screen.getByRole('grid')).toBeDefined();
  });

  it('clears every shared range, or every exclusion, at once', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    render(
      <RangeEditor
        initial={{
          include: [
            { from: '2026-11-01', to: '2026-11-03' },
            { from: '2026-11-10', to: null },
          ],
          exclude: [
            { from: '2026-11-02', to: '2026-11-02' },
            { from: '2026-11-12', to: '2026-11-12' },
          ],
        }}
        today={TODAY}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '清空共享' }));
    expect(last(onChange)).toEqual({
      kind: 'selection',
      selection: {
        include: [],
        exclude: [
          { from: '2026-11-02', to: '2026-11-02' },
          { from: '2026-11-12', to: '2026-11-12' },
        ],
      },
    });
    expect(screen.queryByRole('button', { name: '清空共享' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清空排除' }));
    expect(last(onChange)).toEqual({ kind: 'selection', selection: { include: [], exclude: [] } });
    expect(screen.queryByRole('button', { name: '清空排除' })).toBeNull();
  });

  it('lists at most three items per kind under a count, the rest behind 展开全部', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    const single = (d: string) => ({ from: `2026-11-${d}`, to: `2026-11-${d}` });
    render(
      <RangeEditor
        initial={{
          include: ['01', '03', '05', '07', '09'].map(single),
          exclude: ['20', '21', '22', '23'].map(single),
        }}
        today={TODAY}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('共享 5 段 · 排除 4 天')).toBeDefined();
    expect(items('共享的日期段')).toEqual([
      '共享 2026-11-01',
      '共享 2026-11-03',
      '共享 2026-11-05',
    ]);
    expect(items('排除的日期')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: '展开全部（5）' }));
    expect(items('共享的日期段')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '删除 共享 2026-11-09' }));
    expect(last(onChange)).toMatchObject({ selection: { include: { length: 4 } } });
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(items('共享的日期段')).toHaveLength(3);
  });

  it('[adr:spaces-and-invitations#5] offers not setting a range only where allowed', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    render(<RangeEditor initial={ALL_DAYS} today={TODAY} allowUnset onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('暂不设置'));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'unset' });
    cleanup();

    render(<RangeEditor initial={ALL_DAYS} today={TODAY} onChange={onChange} />);
    expect(screen.queryByLabelText('暂不设置')).toBeNull();
  });
});
