import { expect, type Page } from '@playwright/test';

// The sharing-range calendar opens on the device's current month, so a spec that needs a
// fixed date walks to its month first. Days are addressed by the grid's `data-day`
// (`YYYY-MM-DD`, the calendar day itself, no zone involved).

/** Turns the month until the caption reads the `YYYY-MM` of `day`. */
async function showMonth(page: Page, day: string) {
  const [year, month] = day.split('-').map(Number) as [number, number];
  const caption = page.getByText(/^\d{4} 年 \d{1,2} 月$/);
  for (let turns = 0; turns < 60; turns += 1) {
    const text = (await caption.innerText()).replace(/\s/g, '');
    const [shownYear, shownMonth] = text.match(/\d+/g)!.map(Number) as [number, number];
    const shown = shownYear * 12 + shownMonth;
    const wanted = year * 12 + month;
    if (shown === wanted) return;
    await page.getByRole('button', { name: shown > wanted ? '上个月' : '下个月' }).click();
    await expect(caption).not.toHaveText(text);
  }
  throw new Error(`could not reach the month of ${day}`);
}

/** Clicks one day of the sharing calendar, turning to its month first. */
export async function clickDay(page: Page, day: string) {
  await showMonth(page, day);
  await page.locator(`[data-day="${day}"]`).getByRole('button').click();
}
