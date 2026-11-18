import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { ChevronDown, LogOut } from 'lucide-react';
import { signOut } from '../api/auth.ts';
import { useMe } from '../auth/me.ts';
import { Avatar, Mascot } from '../avatar/index.ts';
import { clearPendingInvite } from '../join/index.ts';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/index.ts';
import { useSiteEntries, type SiteEntry } from './entries.ts';

// The one navigation of every signed-in page (digital-paper-interface D1): 此刻, 日记, and the
// menus 一起 and 设置 holding the pages the caller can reach; the account menu signs out.

const tab =
  'inline-flex h-9 min-h-0 items-center gap-1 rounded-lg border-0 px-2.5 text-sm whitespace-nowrap text-ink-soft no-underline transition-colors hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground data-[state=open]:bg-accent sm:px-3.5';

const UnreadDot = ({ label = '有新内容' }: { label?: string }) => (
  <span className="size-1.5 rounded-full bg-warm" role="img" aria-label={label} />
);

function Menu({
  label,
  entries,
  active,
}: {
  label: string;
  entries: SiteEntry[];
  active: boolean;
}) {
  const unread = entries.some((entry) => entry.unread);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className={tab} aria-current={active ? 'page' : undefined}>
        {label}
        {unread && <UnreadDot />}
        <ChevronDown aria-hidden="true" className="hidden size-3.5 opacity-60 sm:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        {entries.map((entry) => (
          <DropdownMenuItem key={entry.to} asChild>
            <Link to={entry.to}>
              <span className="flex-1">{entry.label}</span>
              {entry.unread ? <UnreadDot /> : null}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Account({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  const onSignOut = async () => {
    setFailed(false);
    try {
      await signOut();
      // Drop every cached answer and a kept invitation of the old session before showing
      // the login page.
      queryClient.clear();
      clearPendingInvite();
      await navigate('/login', { replace: true });
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {failed && (
        <p role="alert" className="text-xs text-warm">
          退出失败，请重试
        </p>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-2 px-2" aria-label={`账号：${name}`}>
            <span className="hidden max-w-32 truncate text-sm text-ink-soft md:inline">{name}</span>
            <Avatar person={{ name, slot: null }} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>已登录为 {name}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void onSignOut()}>
            <LogOut aria-hidden="true" />
            退出
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const TOGETHER = /^\/(clocks|wishes|anniversaries|shared-pages)(\/|$)/;
const SETTINGS = /^\/(spaces|partner|backup|mail|name)(\/|$)/;

/** The site header, for a signed-in user only. */
export function SiteHeader() {
  const me = useMe();
  const entries = useSiteEntries();
  const { pathname } = useLocation();
  if (!me.data) return null;
  return (
    <header className="sticky top-0 z-40 h-(--site-header) border-b border-line bg-paper/95 font-sans backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-6xl items-center gap-2 px-3 sm:px-6">
        <Link
          to="/"
          className="flex items-center gap-2 text-foreground no-underline"
          aria-label="Between Pages"
        >
          <span className="flex -space-x-2" aria-hidden="true">
            <Mascot tone={1} size={26} />
            <Mascot tone={2} size={26} />
          </span>
          <span className="hidden font-serif text-lg sm:inline">Between Pages</span>
        </Link>
        <nav aria-label="主要" className="mx-auto flex items-center gap-0.5 sm:gap-1">
          <NavLink to="/" end className={cn(tab)}>
            此刻
          </NavLink>
          <NavLink to="/days" className={cn(tab)}>
            日记
          </NavLink>
          {entries.together.length > 0 && (
            <Menu label="一起" entries={entries.together} active={TOGETHER.test(pathname)} />
          )}
          <Menu label="设置" entries={entries.settings} active={SETTINGS.test(pathname)} />
        </nav>
        <Account name={me.data.user.displayName} />
      </div>
    </header>
  );
}
