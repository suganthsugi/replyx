import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';

import { VisuallyHidden } from '../foundations/VisuallyHidden';

import type { PresenceUser } from './types';

/**
 * Overlapping initials for who else has this ticket open (docs/design-system "Presence"): a
 * filled avatar for someone viewing, a muted one for someone typing. Both the name and the status
 * reach screen readers, since the color/fill difference alone wouldn't.
 */

export interface PresenceStackProps {
  users: readonly PresenceUser[];
  /** How many avatars to show before collapsing the rest into a "+N" avatar. */
  max?: number;
}

export function PresenceStack({ users, max = 4 }: PresenceStackProps) {
  if (users.length === 0) return null;
  const shown = users.slice(0, max);
  const overflow = users.length - shown.length;

  return (
    <Box component="ul" aria-label="People viewing this ticket" sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex' }}>
      {shown.map((user, index) => (
        <Box component="li" key={user.id} sx={{ ml: index === 0 ? 0 : '-6px' }}>
          <Tooltip title={`${user.name} (${user.status})`}>
            <Avatar
              sx={{
                width: 24,
                height: 24,
                fontSize: '0.625rem',
                fontWeight: 700,
                border: '2px solid',
                borderColor: 'background.paper',
                bgcolor: user.status === 'viewing' ? 'primary.main' : 'action.hover',
                color: user.status === 'viewing' ? 'primary.contrastText' : 'text.primary',
              }}
            >
              <span aria-hidden="true">{user.name.charAt(0).toUpperCase()}</span>
              <VisuallyHidden>
                {user.name} ({user.status})
              </VisuallyHidden>
            </Avatar>
          </Tooltip>
        </Box>
      ))}
      {overflow > 0 && (
        <Box component="li" sx={{ ml: '-6px' }}>
          <Avatar
            sx={{
              width: 24,
              height: 24,
              fontSize: '0.625rem',
              fontWeight: 700,
              border: '2px solid',
              borderColor: 'background.paper',
              bgcolor: 'action.hover',
              color: 'text.secondary',
            }}
          >
            +{overflow}
          </Avatar>
        </Box>
      )}
    </Box>
  );
}
