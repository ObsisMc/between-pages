import { Button } from '../ui/index.ts';
import { applyUpdate, useUpdateWaiting } from './register.ts';

/** "有新版本 · 刷新" at the top of every page while a new version waits (installable-pwa D2). */
export function UpdateBar() {
  if (!useUpdateWaiting()) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-1 bg-notice px-4 py-1.5 font-sans text-sm text-ink"
    >
      <span>有新版本</span>
      <span aria-hidden="true">·</span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-1 py-0"
        onClick={() => void applyUpdate()}
      >
        刷新
      </Button>
    </div>
  );
}
