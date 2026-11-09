import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../ui/index.ts';
import { partnerOf } from './partner.ts';
import { useBinding, useSpaces } from './queries.ts';

const dayText = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });

const linkClass =
  'inline-flex items-center gap-1 text-warm underline-offset-4 hover:underline [&_svg]:size-4';

/**
 * The home page's partner card while unbound (spaces-and-invitations D12): one line of
 * state and the way to the invitation, which lives on the 设置 → 搭档 page. Inviting happens
 * once or twice ever, so the range editor and the link never sit on the home.
 */
export function PartnerCard({ userId }: { userId: string }) {
  const binding = useBinding();
  const spaces = useSpaces();

  const pending = binding.data?.invitation?.state === 'pending' ? binding.data.invitation : null;
  const archived = spaces.data?.spaces.find((s) => s.state === 'archived');
  const status =
    binding.isError || spaces.isError
      ? '双人空间读取失败'
      : binding.isPending || spaces.isPending
        ? '正在读取…'
        : pending
          ? `已发出邀请，${dayText.format(new Date(pending.expiresAt))} 前有效`
          : archived
            ? null
            : '还没有搭档';

  return (
    <Card aria-labelledby="partner-card-title">
      <CardHeader>
        <CardTitle id="partner-card-title">搭档</CardTitle>
        <CardDescription>每人只共享自己确认过的日期</CardDescription>
      </CardHeader>
      <CardContent>
        {status ?? (
          <Link to={`/spaces/${archived!.id}`} className={linkClass}>
            与 {partnerOf(archived!, userId).displayName} 的空间（已解绑）
          </Link>
        )}
      </CardContent>
      <CardFooter>
        <Link to="/partner" className={linkClass}>
          邀请搭档
          <ArrowRight aria-hidden="true" />
        </Link>
      </CardFooter>
    </Card>
  );
}
