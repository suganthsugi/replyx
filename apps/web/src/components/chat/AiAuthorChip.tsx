import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

/**
 * The author line of a message the assistant wrote (specs/002-ai-assist FR-012): "Assistant" with
 * an "AI" chip, in the staff ticket thread and the customer chat alike.
 */
export function AiAuthorChip() {
  return (
    <Typography variant="caption" component="p" sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 600, mb: 0.5 }}>
      Assistant
      <Box component="span" aria-hidden="true">
        ·
      </Box>
      <Box component="span" sx={{ px: 1, borderRadius: 9999, bgcolor: 'primary.main', color: 'primary.contrastText', fontSize: '0.625rem', fontWeight: 700, lineHeight: 1.6 }}>
        AI
      </Box>
    </Typography>
  );
}
