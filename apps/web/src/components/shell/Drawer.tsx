import Box from '@mui/material/Box';
import MuiDrawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { useId, type ReactNode } from 'react';

import { CloseIcon } from '../foundations/icons';

/**
 * A side panel over the page (ticket details on narrow screens, the customer profile sheet).
 * Temporary drawers are modal: MUI traps focus and restores it on close; Escape closes.
 */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  anchor?: 'left' | 'right' | 'bottom';
  width?: number | string;
}

export function Drawer({ open, onClose, title, children, anchor = 'right', width = 420 }: DrawerProps) {
  const titleId = useId();
  return (
    <MuiDrawer
      anchor={anchor}
      open={open}
      onClose={onClose}
      slotProps={{ paper: { role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId } }}
    >
      <Box sx={{ width: anchor === 'bottom' ? 'auto' : { xs: '100vw', sm: width }, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 4, py: 3, borderBottom: 1, borderColor: 'divider' }}>
          <Typography id={titleId} component="h2" variant="h6" sx={{ flex: 1 }}>
            {title}
          </Typography>
          <IconButton aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Box>
        <Box sx={{ flex: 1, overflow: 'auto', p: 4 }}>{children}</Box>
      </Box>
    </MuiDrawer>
  );
}
