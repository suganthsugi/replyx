import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useId, useState } from 'react';

/**
 * The AI assistant's draft reply, shown above the staff composer (specs/002-ai-assist US3). Use puts
 * the text in the composer for the agent to edit and send; Discard throws it away. The new-draft
 * announcement is made by the caller (`useAnnounce`), so this region is not a live region.
 */

export interface AiDraftBarProps {
  body: string;
  onUse: () => void;
  onDiscard: () => void;
  discarding?: boolean;
}

const PREVIEW_CHARS = 280;

export function AiDraftBar({ body, onUse, onDiscard, discarding = false }: AiDraftBarProps) {
  const [expanded, setExpanded] = useState(false);
  const previewId = useId();
  const long = body.length > PREVIEW_CHARS;
  const shown = expanded || !long ? body : `${body.slice(0, PREVIEW_CHARS).trimEnd()}…`;

  return (
    <Box
      component="section"
      aria-label="AI draft"
      sx={{ mx: 3, mt: 3, p: 3, border: 1, borderColor: 'primary.main', borderRadius: 2, bgcolor: 'action.hover', display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <Typography component="h3" variant="body2" sx={{ fontWeight: 700 }}>
        AI draft
      </Typography>
      <Typography id={previewId} variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {shown}
      </Typography>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button size="small" variant="contained" onClick={onUse} disabled={discarding}>
          Use
        </Button>
        <Button size="small" variant="outlined" onClick={onDiscard} disabled={discarding} aria-busy={discarding}>
          Discard
        </Button>
        {long && (
          <Button size="small" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={previewId}>
            {expanded ? 'Show less' : 'Show full draft'}
          </Button>
        )}
      </Box>
    </Box>
  );
}
