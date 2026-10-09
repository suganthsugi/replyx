import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import { darken, keyframes, lighten, useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import { useEffect, useRef } from 'react';

import { useAnnounce } from '../foundations/LiveRegion';

import type { Responder } from '../../api/generated/model';

/**
 * Who is answering the conversation right now (specs/002-ai-assist US3, FR-031): the assistant,
 * one agent, or the support team. Shown on the ticket page and in the customer chat header.
 *
 * The Assistant variant has a shining sheen that sweeps across it about every 3 s and holds still
 * under `prefers-reduced-motion`. Every gradient stop moves away from the label color (darker
 * under white text, lighter under dark text), so the label keeps at least the primary color's
 * own ≥ 4.5:1 contrast on every stop. A change after the first render is announced politely as
 * "Now replying: …".
 */

export interface ResponderBadgeProps {
  responder: Responder;
}

const sweep = keyframes`
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
`;

export function responderLabel(responder: Responder): string {
  if (responder.kind === 'assistant') return 'Assistant';
  if (responder.kind === 'agent') return responder.name;
  return 'Support team';
}

export function ResponderBadge({ responder }: ResponderBadgeProps) {
  const theme = useTheme();
  const announce = useAnnounce();
  const label = responderLabel(responder);
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (previous.current !== null && previous.current !== label) announce(`Now replying: ${label}`, 'polite');
    previous.current = label;
  }, [label, announce]);

  const pill = { display: 'inline-flex', alignItems: 'center', gap: 1.5, px: 2.5, py: 0.75, borderRadius: 9999, maxWidth: '100%', minWidth: 0 } as const;
  const caption = (
    <Typography component="span" variant="caption" sx={{ opacity: 0.85 }}>
      Now replying:
    </Typography>
  );

  if (responder.kind === 'assistant') {
    const main = theme.palette.primary.main;
    const sheen = theme.palette.mode === 'dark' ? lighten(main, 0.35) : darken(main, 0.3);
    return (
      <Box
        data-testid="responder-badge"
        data-responder="assistant"
        sx={{
          ...pill,
          color: 'primary.contrastText',
          backgroundColor: main,
          backgroundImage: `linear-gradient(110deg, ${main} 0%, ${main} 35%, ${sheen} 50%, ${main} 65%, ${main} 100%)`,
          backgroundSize: '200% 100%',
          backgroundPosition: '100% 0',
          animation: `${sweep} 3s linear infinite`,
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }}
      >
        {caption}
        <Typography component="span" variant="caption" sx={{ fontWeight: 700 }}>
          Assistant · AI
        </Typography>
      </Box>
    );
  }

  return (
    <Box data-testid="responder-badge" data-responder={responder.kind} sx={{ ...pill, bgcolor: 'action.hover', color: 'text.primary', border: 1, borderColor: 'divider' }}>
      {caption}
      {responder.kind === 'agent' && (
        <Avatar src={responder.avatarUrl ?? undefined} alt="" sx={{ width: 20, height: 20, fontSize: '0.625rem', bgcolor: 'primary.light', color: 'text.primary' }}>
          {label.charAt(0).toUpperCase()}
        </Avatar>
      )}
      <Typography component="span" variant="caption" noWrap sx={{ fontWeight: 700 }}>
        {label}
      </Typography>
    </Box>
  );
}
