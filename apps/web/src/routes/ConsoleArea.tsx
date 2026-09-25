import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Route, Routes } from 'react-router';

import { AreaShell, NotFoundPage } from './AreaShell';

/**
 * The platform operator console (the console host), loaded lazily. Pages arrive with US2
 * (tenant list, create, suspend, support sessions).
 */
export default function ConsoleArea() {
  return (
    <AreaShell>
      <Routes>
        <Route index element={<ConsoleHome />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AreaShell>
  );
}

function ConsoleHome() {
  return (
    <Box component="main" sx={{ px: 6, py: 6 }}>
      <Typography component="h1" variant="h4">
        Tenants
      </Typography>
    </Box>
  );
}
