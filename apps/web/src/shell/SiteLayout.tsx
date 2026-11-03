import { Outlet } from 'react-router';
import { SiteHeader } from './SiteHeader.tsx';

/** Every page under the one site header. */
export function SiteLayout() {
  return (
    <>
      <SiteHeader />
      <Outlet />
    </>
  );
}
