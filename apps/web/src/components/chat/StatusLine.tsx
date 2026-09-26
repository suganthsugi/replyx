import Typography from '@mui/material/Typography';

import type { ChatStatus } from './types';

/**
 * The conversation's friendly status under the last message ("Support has your message"). Only
 * the plain-language text from the API is shown; changes are announced by `ChatThread`.
 */
export function StatusLine({ status }: { status: ChatStatus }) {
  return (
    <Typography variant="caption" component="p" color="text.secondary" sx={{ textAlign: 'center', my: 1 }}>
      {status.text}
    </Typography>
  );
}
