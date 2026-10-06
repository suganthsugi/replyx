import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useRef, useState } from 'react';

import { summarizeIntervals } from '../../../components/builders/business-hours-summary';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { useToast } from '../../../components/shell/Toast';
import { mapError } from '../../../data/errors';
import { HttpError } from '../../../data/http';

import { BusinessHoursEditorDrawer, type BusinessHoursBody, type BusinessHoursRecord } from './BusinessHoursEditorDrawer';

/**
 * The business-hours screen, without data access (US12, FR-085): the calendars by name with their
 * time zone, weekly hours and holiday count, Edit and Delete, and the add / edit drawer.
 * `BusinessHoursPage` feeds it from the data hooks; tests target this view.
 */

export type { BusinessHoursBody, BusinessHoursRecord };

export interface BusinessHoursViewProps {
  status: 'pending' | 'error' | 'ready';
  /** Mapped, user-facing message for `status: 'error'`. */
  errorMessage?: string;
  onRetry: () => void;
  calendars: readonly BusinessHoursRecord[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Creates, or replaces when `id` is given. Rejects with the API error. */
  onSave: (body: BusinessHoursBody, id?: string) => Promise<void>;
  onDelete: (calendar: BusinessHoursRecord) => Promise<void>;
}

const IN_USE_MESSAGE =
  'This calendar is still used by an SLA policy or by the workspace settings. Switch them to another calendar first, then delete it.';

export function BusinessHoursView({ status, errorMessage, onRetry, calendars, canCreate, canEdit, canDelete, onSave, onDelete }: BusinessHoursViewProps) {
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<BusinessHoursRecord | undefined>();
  const [deleting, setDeleting] = useState<BusinessHoursRecord | null>(null);

  const openEditor = (calendar?: BusinessHoursRecord) => {
    setEditing(calendar);
    setEditorOpen(true);
  };

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap', mb: 2 }}>
          <Typography component="h1" variant="h1" ref={headingRef} tabIndex={-1} sx={{ outline: 'none' }}>
            Business hours
          </Typography>
          {canCreate && status === 'ready' && (
            <Button variant="contained" onClick={() => openEditor()}>
              Add calendar
            </Button>
          )}
        </Box>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          A calendar says when your team is open: the weekly hours in a time zone, and the holidays it is closed. SLA targets count only
          the minutes a calendar is open.
        </Typography>

        {status === 'pending' && <Skeleton variant="list" rows={3} label="business hours" />}

        {status === 'error' && <EmptyState variant="error" title="Couldn't load business hours" message={errorMessage} onRetry={onRetry} />}

        {status === 'ready' &&
          (calendars.length === 0 ? (
            <EmptyState
              title="No business-hours calendars yet"
              message="Add a calendar before you create SLA policies: every policy counts its targets in one."
              action={canCreate ? { label: 'Add calendar', onClick: () => openEditor() } : undefined}
            />
          ) : (
            <Box component="ul" aria-label="Business-hours calendars" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {calendars.map((calendar) => (
                <Paper component="li" key={calendar.id} variant="outlined" sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 3, flexWrap: 'wrap' }}>
                  <Box sx={{ flex: 1, minWidth: 220 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {calendar.name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {summarizeIntervals(calendar.intervals)} ({calendar.timezone})
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {calendar.holidays.length === 0 ? 'No holidays' : `${calendar.holidays.length} ${calendar.holidays.length === 1 ? 'holiday' : 'holidays'}`}
                    </Typography>
                  </Box>
                  {canEdit && (
                    <Button size="small" onClick={() => openEditor(calendar)} aria-label={`Edit ${calendar.name}`}>
                      Edit
                    </Button>
                  )}
                  {canDelete && (
                    <Button size="small" color="error" onClick={() => setDeleting(calendar)} aria-label={`Delete ${calendar.name}`}>
                      Delete
                    </Button>
                  )}
                </Paper>
              ))}
            </Box>
          ))}

        <BusinessHoursEditorDrawer open={editorOpen} onClose={() => setEditorOpen(false)} calendar={editing} onSave={onSave} />

        {deleting !== null && (
          <ConfirmationDialog
            open
            title={`Delete ${deleting.name}`}
            message="The calendar is removed for good. A calendar that policies or the workspace settings still use cannot be deleted."
            confirmLabel="Delete calendar"
            destructive
            onClose={() => setDeleting(null)}
            onConfirm={async () => {
              try {
                await onDelete(deleting);
              } catch (caught) {
                // A calendar in use needs a plain explanation, not the API's wording.
                if (mapError(caught).code === 'IN_USE') throw new HttpError(409, { code: 'IN_USE', message: IN_USE_MESSAGE });
                throw caught;
              }
              toast({ message: `${deleting.name} deleted`, severity: 'success' });
              // The Delete button is gone: keep the keyboard user in the page.
              window.setTimeout(() => headingRef.current?.focus(), 0);
            }}
          />
        )}
      </Box>
    </DesignSystemScope>
  );
}
