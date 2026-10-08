import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';

/** Shell for an AI admin page that is not built yet (specs/002-ai-assist T008). */
export function AiPlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        <Typography component="h1" variant="h1" sx={{ mb: 2 }}>
          {title}
        </Typography>
        <Typography color="text.secondary" sx={{ maxWidth: 680 }}>
          {description}
        </Typography>
      </Box>
    </DesignSystemScope>
  );
}
