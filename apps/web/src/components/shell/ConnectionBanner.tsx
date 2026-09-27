import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

import { useRealtime } from '../../data/realtime';
import { useAnnounce } from '../foundations/LiveRegion';

/**
 * A workspace-wide reconnecting banner (T170, docs/design-system "Workspace Inbox"): shown only
 * once the socket has been disconnected for a moment (a brief blip never flashes it), announced
 * politely, and gone as soon as the connection comes back.
 */

const SHOW_DELAY_MS = 1500;
const MESSAGE = 'Reconnecting — catching up on the latest activity…';

export function ConnectionBanner() {
  const client = useRealtime();
  const announce = useAnnounce();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!client) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasDisconnected = false;
    // Only a connection that was up and dropped is "reconnecting"; a slow first connect isn't.
    let everConnected = client.connected;

    const onChange = (connected: boolean) => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (connected) {
        everConnected = true;
        setVisible(false);
        if (wasDisconnected) announce('Reconnected');
        wasDisconnected = false;
        return;
      }
      if (!everConnected) return;
      wasDisconnected = true;
      timer = setTimeout(() => {
        setVisible(true);
        announce(MESSAGE);
      }, SHOW_DELAY_MS);
    };

    onChange(client.connected);
    const off = client.onConnectionChange(onChange);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      off();
    };
  }, [client, announce]);

  if (!visible) return null;

  return (
    <Box sx={{ px: 4, py: 1.5, textAlign: 'center', bgcolor: 'warning.light', color: 'text.primary', borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
      <Typography variant="caption">{MESSAGE}</Typography>
    </Box>
  );
}
