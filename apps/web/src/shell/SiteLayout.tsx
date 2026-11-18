import { Outlet } from 'react-router';
import { useOnline, useRefetchOnReconnect } from '../api/online.ts';
import { useMe } from '../auth/me.ts';
import { UpdateBar } from '../pwa/index.ts';
import { SiteHeader } from './SiteHeader.tsx';

/** Every page under the one site header, with the update bar over it. */
export function SiteLayout() {
  useRefetchOnReconnect();
  return (
    <>
      <UpdateBar />
      <SiteHeader />
      <OfflineNotice />
      <Outlet />
    </>
  );
}

/**
 * installable-pwa D4: one notice for every signed-in page while the API does not answer. It
 * says only what this device does; "已保存到服务器" stays the save line's, from the server.
 */
function OfflineNotice() {
  const signedIn = !!useMe().data;
  const online = useOnline();
  if (!signedIn || online) return null;
  return (
    <p
      role="status"
      className="border-b border-line bg-notice px-4 py-2 text-center font-sans text-sm text-ink"
    >
      现在离线。日记和共享页面里写下的字先存在这台设备上，联网后自动发出；其他修改要联网后再做。
    </p>
  );
}
