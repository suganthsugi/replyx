import { Route, Routes } from 'react-router';

import ConsoleSignInPage from '../pages/console/ConsoleSignInPage';
import SupportSessionPage from '../pages/console/SupportSessionPage';
import TenantsPage from '../pages/console/TenantsPage';

import { AreaShell, NotFoundPage } from './AreaShell';

/**
 * The platform operator console (the console host), loaded lazily. The tenant list is the home
 * page, and it shows the sign-in form itself when there is no operator session: the console has
 * one audience and one entry point (T086).
 */
export default function ConsoleArea() {
  return (
    <AreaShell>
      <Routes>
        <Route index element={<TenantsPage />} />
        <Route path="sign-in" element={<ConsoleSignInPage />} />
        <Route path="tenants/:id/support" element={<SupportSessionPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AreaShell>
  );
}
