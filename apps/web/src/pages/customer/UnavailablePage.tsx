import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

/**
 * What a customer sees when the workspace is suspended (FR-004). It says only that support cannot
 * be reached right now: why a workspace is suspended is between the platform and that business,
 * and never the customer's concern.
 */
export default function UnavailablePage() {
  return (
    <Box component="main" sx={{ maxWidth: 480, mx: 'auto', px: 4, py: 8, textAlign: 'center' }}>
      <Typography component="h1" variant="h4" sx={{ mb: 2 }}>
        Support is unavailable
      </Typography>
      <Typography color="text.secondary">
        This support workspace can&apos;t be reached at the moment. Please try again later, or
        contact the company another way.
      </Typography>
    </Box>
  );
}
