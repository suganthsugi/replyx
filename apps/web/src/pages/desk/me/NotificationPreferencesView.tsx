import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

import { NotificationChannelGrid, type NotificationEvents } from '../../../components/data-display/NotificationChannelGrid';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { useToast } from '../../../components/shell/Toast';
import { mapError } from '../../../data/errors';

import type { DesktopPermission } from '../../../data/notifications';

/**
 * Your notification preferences (US15, FR-080), without data access: the master switch, the
 * event × channel grid and the browser permission for desktop notifications.
 * `NotificationPreferencesPage` feeds it from the data hooks; tests target this view.
 *
 * The master switch stops desktop and email alerts only; the notification center still records
 * everything (spec US15 scenario 2), which the page says in words next to the switch.
 */

export interface PreferencesValue {
  enabled: boolean;
  events: NotificationEvents;
}

export interface NotificationPreferencesViewProps {
  status: 'pending' | 'error' | 'ready';
  errorMessage?: string;
  onRetry: () => void;
  preferences?: PreferencesValue;
  desktopPermission: DesktopPermission;
  /** Rejects with a user-facing error. */
  onEnableDesktop: () => Promise<void>;
  onSave: (value: PreferencesValue) => Promise<void>;
}

const PERMISSION_TEXT: Record<DesktopPermission, string> = {
  granted: 'Desktop notifications are on for this browser.',
  default: 'Allow this browser to show desktop notifications.',
  denied: 'Notifications are blocked for this site. Allow them in your browser settings to get desktop notifications.',
  unsupported: "This browser doesn't support desktop notifications. You'll still get in-app and email notifications.",
};

export function NotificationPreferencesView({
  status,
  errorMessage,
  onRetry,
  preferences,
  desktopPermission,
  onEnableDesktop,
  onSave,
}: NotificationPreferencesViewProps) {
  const toast = useToast();
  const [draft, setDraft] = useState<PreferencesValue | undefined>(preferences);
  const [saving, setSaving] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  useEffect(() => {
    setDraft(preferences);
  }, [preferences]);

  const save = async () => {
    if (draft === undefined) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await onSave(draft);
      toast({ message: 'Notification preferences saved', severity: 'success' });
    } catch (caught) {
      setSaveError(mapError(caught).message);
    } finally {
      setSaving(false);
    }
  };

  const enableDesktop = async () => {
    setEnabling(true);
    try {
      await onEnableDesktop();
      toast({ message: 'Desktop notifications are on for this browser', severity: 'success' });
    } catch (caught) {
      toast({ message: caught instanceof Error && caught.name === 'DesktopNotificationsError' ? caught.message : mapError(caught).message, severity: 'error' });
    } finally {
      setEnabling(false);
    }
  };

  return (
    <DesignSystemScope>
      <Box component="main" id="desk-main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 880 }}>
        <Typography component="h1" variant="h1" sx={{ mb: 2 }}>
          Notification preferences
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          Choose what notifies you and where. Your organization sets the starting choices; once you save, these are yours. A burst of
          customer messages on one ticket arrives as a single desktop notification or email.
        </Typography>

        {status === 'pending' && <Skeleton variant="block" label="notification preferences" />}
        {status === 'error' && <EmptyState variant="error" title="Couldn't load your notification preferences" message={errorMessage} onRetry={onRetry} />}

        {status === 'ready' && draft !== undefined && (
          <>
            <Box component="section" aria-labelledby="desktop-heading" sx={{ mb: 6 }}>
              <Typography component="h2" variant="h3" id="desktop-heading" sx={{ mb: 2 }}>
                Desktop notifications
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 240 }}>
                  {PERMISSION_TEXT[desktopPermission]}
                </Typography>
                {(desktopPermission === 'default' || desktopPermission === 'granted') && (
                  <Button variant="outlined" onClick={() => void enableDesktop()} disabled={enabling}>
                    {desktopPermission === 'granted' ? 'Re-register this browser' : 'Turn on desktop notifications'}
                  </Button>
                )}
              </Box>
            </Box>

            <Box component="section" aria-labelledby="channels-heading">
              <Typography component="h2" variant="h3" id="channels-heading" sx={{ mb: 2 }}>
                What notifies you
              </Typography>
              <FormControlLabel
                control={<Switch checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />}
                label="Desktop and email notifications"
              />
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                {draft.enabled
                  ? 'Turn this off to pause every desktop notification and email at once.'
                  : 'Paused: no desktop notifications or emails. Your notification center still lists everything, without alerts.'}
              </Typography>
              <NotificationChannelGrid
                caption="Notification channels per event"
                events={draft.events}
                mutedChannels={draft.enabled ? [] : ['push', 'email']}
                onChange={(event, channel, value) =>
                  setDraft({ ...draft, events: { ...draft.events, [event]: { ...draft.events[event]!, [channel]: value } } })
                }
              />
              {saveError !== undefined && (
                <Alert severity="error" sx={{ mt: 3 }}>
                  {saveError}
                </Alert>
              )}
              <Button variant="contained" sx={{ mt: 4 }} onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : 'Save preferences'}
              </Button>
            </Box>
          </>
        )}
      </Box>
    </DesignSystemScope>
  );
}
