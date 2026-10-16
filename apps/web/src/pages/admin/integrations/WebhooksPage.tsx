import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useId, useRef, useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { Drawer } from '../../../components/shell/Drawer';
import { Form, FormError, FormField, SubmitButton, useFormIssue } from '../../../components/shell/Form';
import { Modal } from '../../../components/shell/Modal';
import { useToast } from '../../../components/shell/Toast';
import { useMe } from '../../../data/auth';
import { mapError } from '../../../data/errors';
import {
  toWebhookInput,
  useCreateWebhook,
  useDeleteWebhook,
  useRotateWebhookSecret,
  useUpdateWebhook,
  useWebhookDeliveries,
  useWebhooks,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
} from '../../../data/webhooks';

/**
 * Webhooks (US18, FR-090, FR-091): endpoints with their events and switch, add / edit / delete,
 * a one-time display of the signing secret after adding an endpoint or rotating its secret, and
 * each endpoint's delivery history (every attempt of the last 30 days). Each action follows its
 * `webhook.*` permission.
 */

export const WEBHOOK_EVENT_OPTIONS: readonly { value: WebhookEvent; label: string; hint?: string }[] = [
  { value: 'ticket.created', label: 'Ticket created' },
  { value: 'ticket.updated', label: 'Ticket updated' },
  { value: 'ticket.assigned', label: 'Ticket assigned' },
  { value: 'ticket.closed', label: 'Ticket closed' },
  { value: 'message.created', label: 'Message added', hint: 'Customer messages and public replies; internal notes are never sent' },
];

const EVENT_LABELS = new Map(WEBHOOK_EVENT_OPTIONS.map((option) => [option.value, option.label]));

const STATUS_LABELS: Record<WebhookDelivery['status'], string> = {
  pending: 'Waiting',
  succeeded: 'Delivered',
  failed: 'Failed, will retry',
  gave_up: 'Gave up',
};

const STATUS_COLORS: Record<WebhookDelivery['status'], 'default' | 'success' | 'warning' | 'error'> = {
  pending: 'default',
  succeeded: 'success',
  failed: 'warning',
  gave_up: 'error',
};

const formatTime = (iso: string) => new Date(iso).toLocaleString();

type Pending =
  | { kind: 'create' }
  | { kind: 'edit'; webhook: Webhook }
  | { kind: 'delete'; webhook: Webhook }
  | { kind: 'rotate'; webhook: Webhook }
  | { kind: 'history'; webhook: Webhook };

export default function WebhooksPage() {
  const webhooksQuery = useWebhooks();
  const updateWebhook = useUpdateWebhook();
  const deleteWebhook = useDeleteWebhook();
  const rotateSecret = useRotateWebhookSecret();
  const held = new Set(useMe().data?.permissions ?? []);
  const toast = useToast();
  const announce = useAnnounce();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // Apart from `pending`: the confirmation dialog closes itself after rotating.
  const [shownSecret, setShownSecret] = useState<{ secret: string; url: string } | null>(null);
  const close = () => setPending(null);

  const canCreate = held.has('webhook.create');
  const canEdit = held.has('webhook.edit');
  const canDelete = held.has('webhook.delete');
  const webhooks = webhooksQuery.data?.items ?? [];

  const toggle = (webhook: Webhook, enabled: boolean) => {
    updateWebhook.mutateAsync({ id: webhook.id, body: toWebhookInput(webhook, { enabled }) }).then(
      () => announce(`${webhook.url} switched ${enabled ? 'on' : 'off'}.`),
      (caught: unknown) => toast({ message: `The endpoint was not changed. ${mapError(caught).message}`, severity: 'error' }),
    );
  };

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap', mb: 2 }}>
          <Typography component="h1" variant="h1" ref={headingRef} tabIndex={-1} sx={{ outline: 'none' }}>
            Webhooks
          </Typography>
          {canCreate && webhooksQuery.isSuccess && (
            <Button variant="contained" onClick={() => setPending({ kind: 'create' })}>
              Add endpoint
            </Button>
          )}
        </Box>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          Send ticket and message events to your own systems. Each request is signed with the endpoint&apos;s secret, and a failed
          delivery is retried for about a day.
        </Typography>

        {webhooksQuery.isPending && <Skeleton variant="list" rows={3} label="webhook endpoints" />}

        {webhooksQuery.isError && (
          <EmptyState variant="error" title="Couldn't load webhooks" message={webhooksQuery.error?.message} onRetry={() => void webhooksQuery.refetch()} />
        )}

        {webhooksQuery.isSuccess && webhooks.length === 0 && (
          <EmptyState
            title="No webhook endpoints yet"
            message="Add an endpoint to receive an HTTPS request whenever a ticket is created, changes or gets a message."
            action={canCreate ? { label: 'Add endpoint', onClick: () => setPending({ kind: 'create' }) } : undefined}
          />
        )}

        {webhooksQuery.isSuccess && webhooks.length > 0 && (
          <List aria-label="Webhook endpoints" disablePadding sx={{ border: 1, borderColor: 'divider', borderRadius: 2 }}>
            {webhooks.map((webhook, index) => (
              <ListItem key={webhook.id} divider={index < webhooks.length - 1} sx={{ py: 3 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
                  <Switch
                    size="small"
                    checked={webhook.enabled}
                    disabled={!canEdit}
                    onChange={(event) => toggle(webhook, event.target.checked)}
                    slotProps={{ input: { 'aria-label': `Send events to ${webhook.url}` } }}
                  />
                  <Box sx={{ flex: 1, minWidth: 220 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, fontFamily: 'monospace', overflowWrap: 'anywhere' }} color={webhook.enabled ? 'text.primary' : 'text.secondary'}>
                      {webhook.url}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {webhook.events.map((event) => EVENT_LABELS.get(event) ?? event).join(', ')}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
                      {!webhook.enabled && <Chip size="small" label="Off" />}
                      {webhook.lastDeliveryStatus !== null && (
                        <Chip size="small" color={STATUS_COLORS[webhook.lastDeliveryStatus]} label={`Last delivery: ${STATUS_LABELS[webhook.lastDeliveryStatus]}`} />
                      )}
                    </Box>
                  </Box>
                  <Button size="small" onClick={() => setPending({ kind: 'history', webhook })} aria-label={`Delivery history for ${webhook.url}`}>
                    History
                  </Button>
                  {canEdit && (
                    <>
                      <Button size="small" onClick={() => setPending({ kind: 'edit', webhook })} aria-label={`Edit ${webhook.url}`}>
                        Edit
                      </Button>
                      <Button size="small" onClick={() => setPending({ kind: 'rotate', webhook })} aria-label={`New secret for ${webhook.url}`}>
                        New secret
                      </Button>
                    </>
                  )}
                  {canDelete && (
                    <Button size="small" color="error" onClick={() => setPending({ kind: 'delete', webhook })} aria-label={`Delete ${webhook.url}`}>
                      Delete
                    </Button>
                  )}
                </Box>
              </ListItem>
            ))}
          </List>
        )}

        {(pending?.kind === 'create' || pending?.kind === 'edit') && (
          <WebhookDialog
            webhook={pending.kind === 'edit' ? pending.webhook : undefined}
            onClose={close}
            onCreated={(secret, url) => {
              setPending(null);
              setShownSecret({ secret, url });
            }}
          />
        )}

        {shownSecret !== null && <SecretDialog secret={shownSecret.secret} url={shownSecret.url} onClose={() => setShownSecret(null)} />}

        {pending?.kind === 'rotate' && (
          <ConfirmationDialog
            open
            title="Replace the signing secret"
            message={`Requests to ${pending.webhook.url} are signed with the new secret from now on, retries included. Update your endpoint right away, or it will reject them.`}
            confirmLabel="Replace secret"
            onClose={close}
            onConfirm={async () => {
              const { secret } = await rotateSecret.mutateAsync(pending.webhook.id);
              setShownSecret({ secret, url: pending.webhook.url });
            }}
          />
        )}

        {pending?.kind === 'delete' && (
          <ConfirmationDialog
            open
            title="Delete endpoint"
            message={`${pending.webhook.url} stops getting events, and its delivery history is removed for good.`}
            confirmLabel="Delete endpoint"
            destructive
            onClose={close}
            onConfirm={async () => {
              await deleteWebhook.mutateAsync(pending.webhook.id);
              toast({ message: 'Endpoint deleted', severity: 'success' });
              // The Delete button is gone: keep the keyboard user in the page.
              window.setTimeout(() => headingRef.current?.focus(), 0);
            }}
          />
        )}

        <DeliveriesDrawer webhook={pending?.kind === 'history' ? pending.webhook : undefined} onClose={close} />
      </Box>
    </DesignSystemScope>
  );
}

function WebhookDialog({ webhook, onClose, onCreated }: { webhook: Webhook | undefined; onClose: () => void; onCreated: (secret: string, url: string) => void }) {
  const createWebhook = useCreateWebhook();
  const updateWebhook = useUpdateWebhook();
  const toast = useToast();
  const [url, setUrl] = useState(webhook?.url ?? 'https://');
  const [events, setEvents] = useState<WebhookEvent[]>(webhook?.events ?? ['ticket.created']);
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const title = webhook === undefined ? 'Add endpoint' : 'Edit endpoint';

  return (
    <Modal open onClose={onClose} title={title}>
      <Form
        label={title}
        onSubmit={async () => {
          const body = { url: url.trim(), events, enabled };
          if (webhook === undefined) {
            const created = await createWebhook.mutateAsync(body);
            onCreated(created.secret, created.url);
          } else {
            await updateWebhook.mutateAsync({ id: webhook.id, body });
            toast({ message: 'Endpoint saved', severity: 'success' });
            onClose();
          }
        }}
      >
        <FormField
          name="url"
          label="Endpoint URL"
          helperText="An https address on your server that accepts POST requests."
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
          type="url"
          slotProps={{ htmlInput: { maxLength: 2000, inputMode: 'url', spellCheck: false } }}
        />
        <EventsField value={events} onChange={setEvents} />
        <FormControlLabel control={<Switch checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />} label={enabled ? 'On: send events' : 'Off: send nothing'} />
        <FormError />
        <SubmitButton disabled={events.length === 0}>{webhook === undefined ? 'Add endpoint' : 'Save'}</SubmitButton>
      </Form>
    </Modal>
  );
}

function EventsField({ value, onChange }: { value: WebhookEvent[]; onChange: (events: WebhookEvent[]) => void }) {
  const helperId = useId();
  const issue = useFormIssue('events');
  const empty = value.length === 0;
  const toggle = (event: WebhookEvent, checked: boolean) =>
    onChange(checked ? WEBHOOK_EVENT_OPTIONS.map((option) => option.value).filter((option) => option === event || value.includes(option)) : value.filter((item) => item !== event));
  return (
    <FormControl component="fieldset" error={issue !== undefined || empty} aria-describedby={helperId}>
      <FormLabel component="legend">Events</FormLabel>
      <FormGroup>
        {WEBHOOK_EVENT_OPTIONS.map((option) => (
          <Box key={option.value}>
            <FormControlLabel control={<Checkbox checked={value.includes(option.value)} onChange={(event) => toggle(option.value, event.target.checked)} />} label={option.label} />
            {option.hint !== undefined && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: 8, mt: -1 }}>
                {option.hint}
              </Typography>
            )}
          </Box>
        ))}
      </FormGroup>
      <FormHelperText id={helperId}>{issue ?? (empty ? 'Choose at least one event.' : ' ')}</FormHelperText>
    </FormControl>
  );
}

/** The signing secret, once. Nothing keeps it after this dialog closes. */
function SecretDialog({ secret, url, onClose }: { secret: string; url: string; onClose: () => void }) {
  const toast = useToast();
  const copy = () => {
    navigator.clipboard.writeText(secret).then(
      () => toast({ message: 'Secret copied', severity: 'success' }),
      () => toast({ message: 'Couldn’t copy. Select the secret and copy it yourself.', severity: 'error' }),
    );
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Signing secret"
      actions={
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Alert severity="warning">Copy this secret now. It is shown only once; if you lose it, replace it with a new one.</Alert>
        <Typography variant="body2">
          Use it on <Box component="span" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{url}</Box> to check the{' '}
          <Box component="code">ReplyX-Signature</Box> header of each request.
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
          <TextField
            label="Secret"
            value={secret}
            fullWidth
            slotProps={{ htmlInput: { readOnly: true, spellCheck: false, style: { fontFamily: 'monospace' } } }}
            onFocus={(event) => event.target.select()}
          />
          <Button variant="outlined" onClick={copy} sx={{ mt: 1 }}>
            Copy
          </Button>
        </Box>
      </Box>
    </Modal>
  );
}

function DeliveriesDrawer({ webhook, onClose }: { webhook: Webhook | undefined; onClose: () => void }) {
  const query = useWebhookDeliveries(webhook?.id);
  const deliveries = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Drawer open={webhook !== undefined} onClose={onClose} title="Delivery history" width={520}>
      {webhook !== undefined && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Typography variant="body2" color="text.secondary" sx={{ flex: 1, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
              {webhook.url}
            </Typography>
            <Button size="small" onClick={() => void query.refetch()} disabled={query.isFetching}>
              Refresh
            </Button>
          </Box>
          {query.isPending && <Skeleton variant="list" rows={4} label="deliveries" />}
          {query.isError && <EmptyState variant="error" title="Couldn't load the history" message={query.error?.message} onRetry={() => void query.refetch()} headingLevel={3} />}
          {query.isSuccess && deliveries.length === 0 && (
            <EmptyState title="No deliveries yet" message="Attempts show here for 30 days, starting with the next event this endpoint is subscribed to." headingLevel={3} />
          )}
          {deliveries.length > 0 && (
            <List aria-label="Delivery attempts" disablePadding>
              {deliveries.map((delivery) => (
                <ListItem key={delivery.id} divider disableGutters sx={{ display: 'block', py: 2 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                    <Chip size="small" color={STATUS_COLORS[delivery.status]} label={STATUS_LABELS[delivery.status]} />
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {EVENT_LABELS.get(delivery.eventType) ?? delivery.eventType}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Attempt {delivery.attempt} of 8
                    </Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {formatTime(delivery.attemptedAt ?? delivery.createdAt)}
                    {delivery.responseCode !== null && ` · HTTP ${delivery.responseCode}`}
                    {delivery.durationMs !== null && ` · ${delivery.durationMs} ms`}
                  </Typography>
                  {delivery.error !== null && delivery.error !== `HTTP ${delivery.responseCode}` && (
                    <Typography variant="body2" color="text.secondary">
                      {delivery.error}
                    </Typography>
                  )}
                  {delivery.nextAttemptAt !== null && delivery.status !== 'succeeded' && (
                    <Typography variant="body2" color="text.secondary">
                      {delivery.status === 'pending' ? 'Due' : 'Next attempt'} {formatTime(delivery.nextAttemptAt)}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                    Event {delivery.eventId}
                  </Typography>
                </ListItem>
              ))}
            </List>
          )}
          {query.hasNextPage && (
            <Button onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              Load older attempts
            </Button>
          )}
        </Box>
      )}
    </Drawer>
  );
}
