import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Route, Routes } from 'react-router';

import { AreaShell, NotFoundPage } from './AreaShell';

/**
 * The agent/admin workspace (`/desk/*` on a tenant host), loaded lazily. Paths here are relative
 * to `/desk`. Pages arrive with US3 onwards (T067, T069, …); admin sections live under
 * `/desk/admin`.
 */
export default function WorkspaceArea() {
  return (
    <AreaShell>
      <Routes>
        <Route index element={<WorkspaceHome />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AreaShell>
  );
}

function WorkspaceHome() {
  return (
    <Box component="main" sx={{ px: 6, py: 6 }}>
      <Typography component="h1" variant="h4">
        Inbox
      </Typography>
    </Box>
  );
}
