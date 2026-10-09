import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useId, type ReactNode } from 'react';

/** A titled card on an AI admin page, labelled by its heading. */
export function AiSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ p: 5, border: 1, borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}>
      <Typography id={headingId} component="h2" variant="h3" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 4 }}>
        {description}
      </Typography>
      {children}
    </Box>
  );
}
