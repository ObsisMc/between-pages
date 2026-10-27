import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ALL_DAYS, describeSelection, isShared } from './range.ts';
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
});

describe('RangeEditor', () => {
  const setDate = (label: RegExp | string, index: number, value: string) =>
    fireEvent.change(screen.getAllByLabelText(label)[index]!, { target: { value } });

  it('[adr:spaces-and-invitations#6] builds single days, open-ended ranges and exclusions', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    render(<RangeEditor initial={ALL_DAYS} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('自选日期'));
    fireEvent.click(screen.getByText('添加共享日期'));
    setDate('开始', 0, '2026-10-05');
    setDate('结束', 0, '2026-10-05');
    fireEvent.click(screen.getByText('添加共享日期'));
    setDate('开始', 1, '2026-11-01');
    fireEvent.click(screen.getAllByLabelText('以后持续')[1]!);
    fireEvent.click(screen.getByText('添加排除日期'));
    setDate('开始', 2, '2026-12-25');
    setDate('结束', 2, '2026-12-25');

    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'selection',
      selection: {
        include: [
          { from: '2026-10-05', to: '2026-10-05' },
          { from: '2026-11-01', to: null },
        ],
        exclude: [{ from: '2026-12-25', to: '2026-12-25' }],
      },
    });
    expect(screen.getByText(/共享：2026-10-05；2026-11-01 起持续；排除：2026-12-25/)).toBeDefined();
  });

  it('reports an incomplete or reversed range as invalid', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    render(<RangeEditor initial={ALL_DAYS} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('自选日期'));
    fireEvent.click(screen.getByText('添加共享日期'));
    setDate('开始', 0, '2026-10-05');

    expect(onChange).toHaveBeenLastCalledWith({ kind: 'invalid' });
    setDate('结束', 0, '2026-10-01');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'invalid' });
    setDate('结束', 0, '2026-10-06');
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'selection',
      selection: { include: [{ from: '2026-10-05', to: '2026-10-06' }], exclude: [] },
    });
  });

  it('[adr:spaces-and-invitations#5] offers not setting a range only where allowed', () => {
    const onChange = vi.fn<(choice: RangeChoice) => void>();
    render(<RangeEditor initial={ALL_DAYS} allowUnset onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('暂不设置'));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'unset' });
    cleanup();

    render(<RangeEditor initial={ALL_DAYS} onChange={onChange} />);
    expect(screen.queryByLabelText('暂不设置')).toBeNull();
  });
});
