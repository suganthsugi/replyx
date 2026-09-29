import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { Modal } from '../../../components/shell/Modal';
import { useToast } from '../../../components/shell/Toast';
import { useMe } from '../../../data/auth';
import { mapError } from '../../../data/errors';
import {
  useTenantSettings,
  useUpdateTenantSettings,
  type TenantSettings,
  type TenantSettingsUpdate,
} from '../../../data/settings';
import {
  AA_NORMAL_TEXT_CONTRAST,
  CONTRAST_SAFETY_MARGIN,
  nearestAACompliantShade,
} from '../../../theme/brand-accent';

import { BrandPreview, contrastStatus, PRIMARY_HEX_PATTERN } from './BrandPreview';

/**
 * Organization settings (FR-005): the workspace name, the customer chat's brand color with a live
 * contrast check and preview, the welcome and out-of-hours messages, time zone, self-registration,
 * the grace period, the after-close and offline-notification behaviors and data retention (a
 * shortened ticket period that would purge closed tickets asks for confirmation first). Viewing needs
 * `tenant_settings.view`; saving needs `tenant_settings.edit` (otherwise the form is read-only).
 * Only changed fields are sent. The API is the authority on contrast: a rejected color comes back
 * with a passing shade, offered as "Use suggested color".
 */

const MAX_NAME = 120;
const MAX_MESSAGE = 500;
const MIN_GRACE = 1;
const MAX_GRACE = 720;
const COLOR_PATH = 'brandColors.primary';
/** What the native color picker shows while the field holds no usable color. */
const PICKER_FALLBACK = '#0d9488';

const AFTER_CLOSE_OPTIONS = [
  {
    value: 'new_follow_up',
    label: 'Start a new conversation',
    hint: 'A message after the conversation closed starts a fresh one, linked to the old one.',
  },
  {
    value: 'reopen_previous',
    label: 'Reopen the previous conversation',
    hint: 'A message after the conversation closed reopens it.',
  },
] as const;

const OFFLINE_OPTIONS = [
  {
    value: 'email',
    label: 'Email them the reply',
    hint: 'Customers who left the chat get the reply by email.',
  },
  {
    value: 'off',
    label: 'Do not notify',
    hint: 'Customers only see the reply when they come back.',
  },
] as const;

const TICKET_RETENTION_OPTIONS = [
  'forever',
  'P1Y',
  'P2Y',
  'P3Y',
  'P4Y',
  'P5Y',
  'P6Y',
  'P7Y',
] as const;
const AUDIT_RETENTION_OPTIONS = ['forever', 'P1Y', 'P2Y', 'P3Y', 'P5Y', 'P7Y', 'P10Y'] as const;

/** "forever" -> "Forever", "P3Y" -> "3 years". */
function retentionLabel(value: string): string {
  if (value === 'forever') return 'Forever';
  const years = Number(/^P(\d+)Y$/.exec(value)?.[1]);
  if (!Number.isFinite(years)) return value;
  return years === 1 ? '1 year' : `${years} years`;
}

/** A save the API held back until the person confirms how many closed tickets it will delete. */
interface PendingPurge {
  patch: TenantSettingsUpdate;
  purgeCount: number;
  /** Set when a retry came back with a different count. */
  changedFrom?: number;
}

function ticketCount(count: number): string {
  return `${count.toLocaleString('en')} closed ${count === 1 ? 'ticket' : 'tickets'}`;
}

function timeZones(current: string): string[] {
  const supported =
    (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ??
    [];
  return [...new Set([current, 'UTC', ...supported])].sort((a, b) => a.localeCompare(b));
}

function parseGrace(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return parsed >= MIN_GRACE && parsed <= MAX_GRACE ? parsed : undefined;
}

export default function OrganizationSettingsPage() {
  const settingsQuery = useTenantSettings();
  const meQuery = useMe();
  const held = new Set(meQuery.data?.permissions ?? []);
  // The form needs both: without the caller's permissions it would flash as read-only.
  const loading = !settingsQuery.isError && (settingsQuery.isPending || meQuery.isPending);

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 800 }}>
        <Typography component="h1" variant="h1" sx={{ mb: 2 }}>
          Organization settings
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 640 }}>
          How your workspace looks and behaves for customers: its name, chat color, messages and
          what happens after a conversation is closed.
        </Typography>

        {loading && <Skeleton variant="block" label="organization settings" />}

        {settingsQuery.isError && (
          <EmptyState
            variant="error"
            title="Couldn't load organization settings"
            message={settingsQuery.error?.message}
            onRetry={() => void settingsQuery.refetch()}
          />
        )}

        {!loading && settingsQuery.data !== undefined && (
          <SettingsForm settings={settingsQuery.data} canEdit={held.has('tenant_settings.edit')} />
        )}
      </Box>
    </DesignSystemScope>
  );
}

function Section({
  title,
  description,
  headingRef,
  children,
}: {
  title: string;
  description?: string;
  /** Makes the heading a programmatic focus target (tabIndex -1), e.g. to land focus after a dialog closes. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        bgcolor: 'background.paper',
        p: 4,
      }}
    >
      <Box>
        <Typography
          id={headingId}
          ref={headingRef}
          tabIndex={headingRef === undefined ? undefined : -1}
          component="h2"
          variant="overline"
          color="text.secondary"
          sx={{ display: 'block' }}
        >
          {title}
        </Typography>
        {description !== undefined && (
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        )}
      </Box>
      {children}
    </Box>
  );
}

function SettingsForm({ settings, canEdit }: { settings: TenantSettings; canEdit: boolean }) {
  const update = useUpdateTenantSettings();
  const toast = useToast();
  const announce = useAnnounce();

  const [name, setName] = useState(settings.name);
  const [color, setColor] = useState(settings.brandColors.primary ?? '');
  const [welcome, setWelcome] = useState(settings.welcomeMessage ?? '');
  const [outOfHours, setOutOfHours] = useState(settings.outOfHoursMessage ?? '');
  const [timezone, setTimezone] = useState(settings.timezone);
  const [selfRegistration, setSelfRegistration] = useState(settings.selfRegistration);
  const [grace, setGrace] = useState(String(settings.gracePeriodHours));
  const [afterClose, setAfterClose] = useState(settings.afterCloseBehavior);
  const [offline, setOffline] = useState(settings.offlineCustomerNotification);
  // The API's answer for the color it last rejected: the issue and a shade that passes.
  const [retention, setRetention] = useState(settings.retentionPeriod);
  const [auditRetention, setAuditRetention] = useState(settings.auditRetention);
  const [pendingPurge, setPendingPurge] = useState<PendingPurge | null>(null);
  const [confirming, setConfirming] = useState(false);
  // After a confirmed save the Save button is disabled, so the dialog can't hand focus back to it.
  const [refocusRetention, setRefocusRetention] = useState(false);
  const retentionHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!refocusRetention || pendingPurge !== null) return;
    // Next frame: the dialog's own focus restore has run by then.
    const frame = requestAnimationFrame(() => {
      retentionHeading.current?.focus();
      setRefocusRetention(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [refocusRetention, pendingPurge]);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<{
    color: string;
    issue: string;
    suggestion?: string;
  } | null>(null);

  const readOnly = !canEdit;
  const colorStatus = contrastStatus(color);
  const colorFormatInvalid = color !== '' && !colorStatus.valid;
  const rejectedNow = rejected !== null && rejected.color === color ? rejected : null;
  const liveFail = colorStatus.valid && !colorStatus.passes;
  const suggestion =
    rejectedNow?.suggestion ??
    (liveFail
      ? nearestAACompliantShade(color, '#ffffff', AA_NORMAL_TEXT_CONTRAST + CONTRAST_SAFETY_MARGIN)
      : undefined);
  const graceValue = parseGrace(grace);

  const errors = {
    name:
      name.trim() === ''
        ? 'Enter a name'
        : name.length > MAX_NAME
          ? `Use at most ${MAX_NAME} characters`
          : undefined,
    welcome: welcome.length > MAX_MESSAGE ? `Use at most ${MAX_MESSAGE} characters` : undefined,
    outOfHours:
      outOfHours.length > MAX_MESSAGE ? `Use at most ${MAX_MESSAGE} characters` : undefined,
    grace:
      graceValue === undefined
        ? `Enter a whole number of hours from ${MIN_GRACE} to ${MAX_GRACE}`
        : undefined,
  };

  const patch: TenantSettingsUpdate = {};
  if (name.trim() !== settings.name) patch.name = name.trim();
  // Compare what the API would store (trimmed messages, lower-case color), so a saved form isn't dirty again.
  if (
    color.toLowerCase() !== (settings.brandColors.primary ?? '').toLowerCase() &&
    colorStatus.valid
  )
    patch.brandColors = { primary: color.toLowerCase() };
  if (welcome.trim() !== (settings.welcomeMessage ?? ''))
    patch.welcomeMessage = welcome.trim() === '' ? null : welcome.trim();
  if (outOfHours.trim() !== (settings.outOfHoursMessage ?? ''))
    patch.outOfHoursMessage = outOfHours.trim() === '' ? null : outOfHours.trim();
  if (timezone !== settings.timezone) patch.timezone = timezone;
  if (selfRegistration !== settings.selfRegistration) patch.selfRegistration = selfRegistration;
  if (graceValue !== undefined && graceValue !== settings.gracePeriodHours)
    patch.gracePeriodHours = graceValue;
  if (afterClose !== settings.afterCloseBehavior) patch.afterCloseBehavior = afterClose;
  if (offline !== settings.offlineCustomerNotification) patch.offlineCustomerNotification = offline;

  if (retention !== settings.retentionPeriod) patch.retentionPeriod = retention;
  if (auditRetention !== settings.auditRetention) patch.auditRetention = auditRetention;

  const dirty = Object.keys(patch).length > 0;
  const invalid =
    Object.values(errors).some((message) => message !== undefined) || colorFormatInvalid;

  const save = async () => {
    setRejected(null);
    try {
      await update.mutateAsync(patch);
    } catch (caught) {
      const mapped = mapError(caught);
      if (mapped.retentionConfirmation !== undefined) {
        // Not a failure: ask first, then resend this same patch from the dialog.
        setConfirmError(null);
        setPendingPurge({ patch, purgeCount: mapped.retentionConfirmation.purgeCount });
        return;
      }
      const issue = mapped.fieldErrors?.[COLOR_PATH];
      if (issue !== undefined) {
        setRejected({ color, issue, suggestion: mapped.fieldSuggestions?.[COLOR_PATH] });
        // The live check may have passed this color; tell the person the API disagreed.
        if (issue === 'insufficient_contrast' && !liveFail)
          announce(
            'The server says this color does not have enough contrast with white text.',
            'polite',
          );
      }
      // The shell `Form` maps the same error onto the other fields.
      throw caught;
    }
    toast({ message: 'Organization settings saved', severity: 'success' });
  };

  const cancelPurge = () => {
    setPendingPurge(null);
    setConfirmError(null);
    announce('Nothing was deleted or saved.', 'polite');
  };

  const confirmPurge = async () => {
    if (pendingPurge === null) return;
    const { patch: held, purgeCount } = pendingPurge;
    setConfirming(true);
    setConfirmError(null);
    try {
      await update.mutateAsync({ ...held, confirmPurgeCount: purgeCount });
      setPendingPurge(null);
      setRefocusRetention(true);
      toast({ message: 'Organization settings saved', severity: 'success' });
    } catch (caught) {
      const mapped = mapError(caught);
      if (mapped.retentionConfirmation !== undefined) {
        // The count moved since it was shown: ask again with the new one.
        const next = mapped.retentionConfirmation.purgeCount;
        setPendingPurge({ patch: held, purgeCount: next, changedFrom: purgeCount });
        announce(
          `The number of tickets to delete changed to ${next.toLocaleString('en')}. Confirm again to continue.`,
          'assertive',
        );
      } else {
        setConfirmError(mapped.message);
        announce(mapped.message, 'assertive');
      }
    } finally {
      setConfirming(false);
    }
  };

  const colorHelper = colorFormatInvalid
    ? 'Use a six-digit hex color like #1D4ED8'
    : liveFail || rejectedNow?.issue === 'insufficient_contrast'
      ? 'This color does not contrast enough with white text, so chat bubbles and buttons would be hard to read.'
      : rejectedNow !== null
        ? 'Check the format of this color'
        : 'Fills the customer chat bubbles and button; white text sits on it.';

  return (
    <>
      <Form label="Organization settings" onSubmit={save}>
        {readOnly && (
          <Alert severity="info">You can view these settings but not change them.</Alert>
        )}

        <Section title="Organization">
          <FormField
            name="name"
            label="Organization name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={readOnly}
            required
            error={errors.name !== undefined}
            helperText={errors.name ?? 'Shown to customers in the chat header and emails.'}
          />
          <FormField
            name="timezone"
            label="Time zone"
            select
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            disabled={readOnly}
            helperText="Used for business hours and the times shown in emails."
            slotProps={{ select: { native: true } }}
          >
            {timeZones(settings.timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </FormField>
        </Section>

        <Section
          title="Branding"
          description="The chat color customers see. It needs enough contrast for white text to stay readable."
        >
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
            <TextField
              name={COLOR_PATH}
              label="Primary color"
              value={color}
              onChange={(event) => setColor(event.target.value.trim())}
              disabled={readOnly}
              placeholder="#0D9488"
              error={colorFormatInvalid || liveFail || rejectedNow !== null}
              helperText={colorHelper}
              slotProps={{ htmlInput: { maxLength: 7, spellCheck: false, autoComplete: 'off' } }}
              fullWidth
            />
            <Box
              component="input"
              type="color"
              aria-label="Pick the primary color"
              value={colorStatus.valid ? color.toLowerCase() : PICKER_FALLBACK}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setColor(event.target.value)}
              disabled={readOnly}
              sx={{
                width: 56,
                height: 56,
                p: 0.5,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                bgcolor: 'background.paper',
                cursor: readOnly ? 'default' : 'pointer',
                flexShrink: 0,
              }}
            />
          </Box>
          {suggestion !== undefined && !readOnly && PRIMARY_HEX_PATTERN.test(suggestion) && (
            // Not role=alert: the preview announces a contrast change politely, so this stays a visible note.
            <Alert
              severity="warning"
              role="note"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    setColor(suggestion);
                    setRejected(null);
                  }}
                >
                  Use suggested color
                </Button>
              }
            >
              {suggestion.toUpperCase()} is the closest color that passes.
            </Alert>
          )}
          <BrandPreview color={color} welcomeMessage={welcome} tenantName={name} />
        </Section>

        <Section title="Customer chat">
          <FormField
            name="welcomeMessage"
            label="Welcome message"
            multiline
            minRows={2}
            value={welcome}
            onChange={(event) => setWelcome(event.target.value)}
            disabled={readOnly}
            error={errors.welcome !== undefined}
            helperText={
              errors.welcome ??
              `Greets customers who open the chat. ${welcome.length}/${MAX_MESSAGE}`
            }
          />
          <FormField
            name="outOfHoursMessage"
            label="Out-of-hours message"
            multiline
            minRows={2}
            value={outOfHours}
            onChange={(event) => setOutOfHours(event.target.value)}
            disabled={readOnly}
            error={errors.outOfHours !== undefined}
            helperText={
              errors.outOfHours ??
              `Shown when nobody is available. ${outOfHours.length}/${MAX_MESSAGE}`
            }
          />
          <FormField
            name="offlineCustomerNotification"
            label="When a customer has left the chat"
            select
            value={offline}
            onChange={(event) => setOffline(event.target.value as typeof offline)}
            disabled={readOnly}
            helperText={OFFLINE_OPTIONS.find((option) => option.value === offline)?.hint}
            slotProps={{ select: { native: true } }}
          >
            {OFFLINE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </FormField>
        </Section>

        <Section title="Sign-up and closing">
          <Box>
            <FormControlLabel
              control={
                <Switch
                  checked={selfRegistration}
                  onChange={(event) => setSelfRegistration(event.target.checked)}
                  disabled={readOnly}
                />
              }
              label="Let customers sign up themselves"
            />
            <Typography variant="caption" color="text.secondary" component="p">
              {selfRegistration
                ? 'Anyone with an email address can start a chat.'
                : 'Customers cannot create their own account.'}
            </Typography>
          </Box>
          <FormField
            name="gracePeriodHours"
            label="Grace period (hours)"
            type="number"
            value={grace}
            onChange={(event) => setGrace(event.target.value)}
            disabled={readOnly}
            error={errors.grace !== undefined}
            helperText={
              errors.grace ??
              'How long a resolved conversation stays open to a reply before it closes.'
            }
            slotProps={{
              htmlInput: { min: MIN_GRACE, max: MAX_GRACE, step: 1, inputMode: 'numeric' },
            }}
          />
          <FormField
            name="afterCloseBehavior"
            label="When a customer writes after it closed"
            select
            value={afterClose}
            onChange={(event) => setAfterClose(event.target.value as typeof afterClose)}
            disabled={readOnly}
            helperText={AFTER_CLOSE_OPTIONS.find((option) => option.value === afterClose)?.hint}
            slotProps={{ select: { native: true } }}
          >
            {AFTER_CLOSE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </FormField>
        </Section>

        <Section
          title="Data retention"
          headingRef={retentionHeading}
          description="How long closed tickets and the audit log are kept before they are deleted for good."
        >
          <FormField
            name="retentionPeriod"
            label="Keep closed tickets"
            select
            value={retention}
            onChange={(event) => setRetention(event.target.value as typeof retention)}
            disabled={readOnly}
            helperText="Tickets are deleted daily once they have been closed for this long."
            slotProps={{ select: { native: true } }}
          >
            {TICKET_RETENTION_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {retentionLabel(value)}
              </option>
            ))}
          </FormField>
          <FormField
            name="auditRetention"
            label="Keep audit log"
            select
            value={auditRetention}
            onChange={(event) => setAuditRetention(event.target.value as typeof auditRetention)}
            disabled={readOnly}
            helperText="The audit log keeps its own period, at least 1 year."
            slotProps={{ select: { native: true } }}
          >
            {AUDIT_RETENTION_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {retentionLabel(value)}
              </option>
            ))}
          </FormField>
        </Section>

        <FormError />
        {!readOnly && (
          <Box>
            <SubmitButton disabled={!dirty || invalid}>Save changes</SubmitButton>
          </Box>
        )}
      </Form>
      <Modal
        open={pendingPurge !== null}
        onClose={cancelPurge}
        title="Delete closed tickets?"
        maxWidth="xs"
        busy={confirming}
        actions={
          <>
            <Button onClick={cancelPurge} disabled={confirming}>
              Cancel
            </Button>
            <Button
              variant="contained"
              color="error"
              onClick={() => void confirmPurge()}
              disabled={confirming}
              aria-busy={confirming}
            >
              {pendingPurge === null
                ? 'Delete and save'
                : `Delete ${ticketCount(pendingPurge.purgeCount)} and save`}
            </Button>
          </>
        }
      >
        {pendingPurge !== null && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {pendingPurge.changedFrom !== undefined && (
              <Alert severity="warning" role="note">
                The number changed from {pendingPurge.changedFrom.toLocaleString('en')} since you
                last looked.
              </Alert>
            )}
            <Typography>
              Shortening retention permanently deletes {ticketCount(pendingPurge.purgeCount)}{' '}
              (messages, attachments and history) older than{' '}
              {retentionLabel(pendingPurge.patch.retentionPeriod ?? retention)}. This can&apos;t be
              undone.
            </Typography>
            {confirmError !== null && <Alert severity="error">{confirmError}</Alert>}
          </Box>
        )}
      </Modal>
    </>
  );
}
