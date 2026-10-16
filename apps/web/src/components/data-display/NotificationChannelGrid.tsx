import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Typography from '@mui/material/Typography';

/**
 * The event × channel grid behind notification preferences and the tenant defaults (US15,
 * FR-079/FR-080): one row per event, one checkbox per channel. A real table, so a screen reader
 * announces the event and the channel for each checkbox; every checkbox also carries both in its
 * accessible name. On a phone the table scrolls sideways inside its focusable region instead of
 * squeezing the labels.
 */

export type ChannelKey = 'inApp' | 'push' | 'email';

export interface ChannelToggles {
  inApp: boolean;
  push: boolean;
  email: boolean;
}

export type NotificationEvents = Record<string, ChannelToggles>;

export const NOTIFICATION_EVENT_LABELS: readonly { event: string; label: string; help: string }[] = [
  { event: 'ticket.assigned_to_me', label: 'Assigned to me', help: 'A ticket is assigned to you' },
  { event: 'message.customer_on_my_ticket', label: 'Customer replied on my ticket', help: 'The customer writes on a ticket you own' },
  { event: 'mention', label: 'Mentioned', help: 'Someone @mentions you in a reply or note' },
  { event: 'ticket.my_ticket_changed', label: 'My ticket changed', help: 'The state or priority of a ticket you own changes' },
  { event: 'ticket.reminder_reached', label: 'Reminder reached', help: 'A pending reminder on your ticket is due' },
  { event: 'ticket.arrived_in_group', label: 'New ticket in my groups', help: 'A ticket arrives in a group you can see' },
  { event: 'ticket.ungrouped_created', label: 'New ticket needs triage', help: 'A ticket arrives without a group' },
  { event: 'message.customer_on_unassigned', label: 'Customer wrote on an unassigned ticket', help: 'In a group you can see' },
  { event: 'sla.warning', label: 'SLA warning', help: 'A ticket is close to breaching its target' },
  { event: 'sla.breached', label: 'SLA breached', help: 'A ticket breached its target' },
  { event: 'ai.paused', label: 'AI assistant paused', help: 'The assistant stopped (key or credit problem)' },
  { event: 'automation.rule', label: 'Automation rule', help: 'An automation rule asks to notify you' },
];

export const CHANNEL_LABELS: readonly { key: ChannelKey; label: string }[] = [
  { key: 'inApp', label: 'In-app' },
  { key: 'push', label: 'Desktop' },
  { key: 'email', label: 'Email' },
];

export interface NotificationChannelGridProps {
  /** Names the table for assistive technology. */
  caption: string;
  events: NotificationEvents;
  onChange: (event: string, channel: ChannelKey, value: boolean) => void;
  disabled?: boolean;
  /** Channels shown dimmed but still editable (the master switch is off). */
  mutedChannels?: readonly ChannelKey[];
}

const cell = { px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider', textAlign: 'center' as const };

export function NotificationChannelGrid({ caption, events, onChange, disabled = false, mutedChannels = [] }: NotificationChannelGridProps) {
  const rows = NOTIFICATION_EVENT_LABELS.filter((row) => events[row.event] !== undefined);
  return (
    <Box
      role="region"
      aria-label={caption}
      tabIndex={0}
      sx={{ overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 } }}
    >
      <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', minWidth: 480 }}>
        <Box component="caption" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
          {caption}
        </Box>
        <thead>
          <tr>
            <Box component="th" scope="col" sx={{ ...cell, textAlign: 'left' }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Event
              </Typography>
            </Box>
            {CHANNEL_LABELS.map((channel) => (
              <Box component="th" scope="col" key={channel.key} sx={{ ...cell, width: 96 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {channel.label}
                </Typography>
              </Box>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.event}>
              <Box component="th" scope="row" sx={{ ...cell, textAlign: 'left', fontWeight: 'normal' }}>
                <Typography variant="body2">{row.label}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {row.help}
                </Typography>
              </Box>
              {CHANNEL_LABELS.map((channel) => (
                <Box component="td" key={channel.key} sx={{ ...cell, opacity: mutedChannels.includes(channel.key) ? 0.6 : 1 }}>
                  <Checkbox
                    checked={events[row.event]?.[channel.key] ?? false}
                    onChange={(changeEvent) => onChange(row.event, channel.key, changeEvent.target.checked)}
                    disabled={disabled}
                    slotProps={{ input: { 'aria-label': `${channel.label} for ${row.label}` } }}
                  />
                </Box>
              ))}
            </tr>
          ))}
        </tbody>
      </Box>
    </Box>
  );
}
