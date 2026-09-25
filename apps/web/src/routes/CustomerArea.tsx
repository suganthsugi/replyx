import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Route, Routes } from 'react-router';

import { AreaShell, NotFoundPage } from './AreaShell';

/**
 * The customer chat area (`/` on a tenant host). Loaded lazily and kept free of workspace
 * imports so the customer bundle stays small (research D21) and ticket-free (ui-components
 * rule 5). Pages arrive with US1/US3 (T068 onwards).
 */
export default function CustomerArea() {
  return (
    <AreaShell>
      <Routes>
        <Route index element={<CustomerHome />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AreaShell>
  );
}

function CustomerHome() {
  return (
    <Box component="main" sx={{ maxWidth: 720, mx: 'auto', px: 4, py: 8 }}>
      <Typography component="h1" variant="h4">
        Support
      </Typography>
    </Box>
  );
}
