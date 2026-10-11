import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

import { NotificationChannelGrid, type NotificationEvents } from '../../../components/data-display/NotificationChannelGrid';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { useToast } from '../../../components/shell/Toast';
import { mapError } from '../../../data/errors';

/**
 * The organization's notification defaults (US15, FR-080), without data access: which channels
 * each event uses for people who haven't chosen for themselves. Read-only without
 * `tenant_settings.edit`. `NotificationDefaultsPage` feeds it; tests target this view.
 */

export interface NotificationDefaultsViewProps {
  status: 'pending' | 'error' | 'ready';
  errorMessage?: string;
  onRetry: () => void;
  events?: NotificationEvents;
  canEdit: boolean;
  /** Sends only the events that changed. Rejects with the API error. */
  onSave: (changed: NotificationEvents) => Promise<void>;
}

export function NotificationDefaultsView({ status, errorMessage, onRetry, events, canEdit, onSave }: NotificationDefaultsViewProps) {
  const toast = useToast();
  const [draft, setDraft] = useState<NotificationEvents | undefined>(events);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  useEffect(() => {
    setDraft(events);
  }, [events]);

  const changed = (): NotificationEvents => {
    if (draft === undefined || events === undefined) return {};
    return Object.fromEntries(Object.entries(draft).filter(([event, toggles]) => JSON.stringify(toggles) !== JSON.stringify(events[event])));
  };

  const save = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      await onSave(changed());
      toast({ message: 'Notification defaults saved', severity: 'success' });
    } catch (caught) {
      setSaveError(mapError(caught).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 880 }}>
        <Typography component="h1" variant="h1" sx={{ mb: 2 }}>
          Notification defaults
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          The channels each event uses for people who haven&apos;t set their own notification preferences. Anyone who saved their own
          preferences keeps them.
        </Typography>

        {status === 'pending' && <Skeleton variant="block" label="notification defaults" />}
        {status === 'error' && <EmptyState variant="error" title="Couldn't load the notification defaults" message={errorMessage} onRetry={onRetry} />}

        {status === 'ready' && draft !== undefined && (
          <>
            <NotificationChannelGrid
              caption="Default notification channels per event"
              events={draft}
              disabled={!canEdit}
              onChange={(event, channel, value) => setDraft({ ...draft, [event]: { ...draft[event]!, [channel]: value } })}
            />
            {saveError !== undefined && (
              <Alert severity="error" sx={{ mt: 3 }}>
                {saveError}
              </Alert>
            )}
            {canEdit ? (
              <Button variant="contained" sx={{ mt: 4 }} onClick={() => void save()} disabled={saving || Object.keys(changed()).length === 0}>
                {saving ? 'Saving…' : 'Save defaults'}
              </Button>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
                You can view the defaults but not change them.
              </Typography>
            )}
          </>
        )}
      </Box>
    </DesignSystemScope>
  );
}
