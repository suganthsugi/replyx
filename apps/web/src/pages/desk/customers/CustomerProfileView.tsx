import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { StatePill } from '../../../components/tickets/StatePill';

import type { CustomerHistoryMessage, CustomerProfile } from '../../../data/customers';
import type { TicketSummary } from '../../../data/tickets';

/**
 * The full customer profile (spec US16 scenario 2, FR-069): contact details, tags, satisfaction,
 * open and closed tickets, and the whole message history the viewer may see, newest first,
 * without data access. `CustomerProfilePage` feeds it; tests target this view.
 */

export interface CustomerProfileViewProps {
  status: 'pending' | 'error' | 'ready';
  errorMessage?: string;
  onRetry: () => void;
  customer?: CustomerProfile;
  history: {
    status: 'pending' | 'error' | 'ready';
    errorMessage?: string;
    items: CustomerHistoryMessage[];
    hasMore: boolean;
    loadingMore: boolean;
    onLoadMore: () => void;
    onRetry: () => void;
  };
  onOpenTicket: (ticketId: string) => void;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="dt">
        {label}
      </Typography>
      <Typography variant="body2" component="dd" sx={{ m: 0 }}>
        {value ?? '—'}
      </Typography>
    </Box>
  );
}

function TicketList({ title, tickets, onOpenTicket, emptyMessage }: { title: string; tickets: TicketSummary[]; onOpenTicket: (id: string) => void; emptyMessage: string }) {
  return (
    <Box component="section" aria-label={title}>
      <Typography component="h2" variant="h3" sx={{ mb: 2 }}>
        {title} ({tickets.length})
      </Typography>
      {tickets.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {emptyMessage}
        </Typography>
      ) : (
        <List disablePadding>
          {tickets.map((ticket) => (
            <li key={ticket.id}>
            <ListItemButton onClick={() => onOpenTicket(ticket.id)} sx={{ borderRadius: 1.5, mb: 1, border: 1, borderColor: 'divider', gap: 2 }}>
              <StatePill state={ticket.state} />
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                #{ticket.number}
              </Typography>
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ticket.title}
              </Typography>
            </ListItemButton>
            </li>
          ))}
        </List>
      )}
    </Box>
  );
}

export function CustomerProfileView({ status, errorMessage, onRetry, customer, history, onOpenTicket }: CustomerProfileViewProps) {
  return (
    <DesignSystemScope>
      <Box component="main" id="desk-main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        {status === 'pending' && <Skeleton variant="block" label="customer profile" />}
        {status === 'error' && <EmptyState variant="error" title="Couldn't load this customer" message={errorMessage} onRetry={onRetry} />}
        {status === 'ready' && customer !== undefined && (
          <>
            <Typography component="h1" variant="h1" sx={{ mb: 1 }}>
              {customer.name}
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 5 }}>
              {customer.email}
            </Typography>

            <Box sx={{ display: 'grid', gap: 5, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, mb: 6 }}>
              <Paper variant="outlined" component="section" aria-label="Contact details" sx={{ p: 4 }}>
                <Typography component="h2" variant="h3" sx={{ mb: 3 }}>
                  Contact details
                </Typography>
                <Box component="dl" sx={{ display: 'grid', gap: 2, gridTemplateColumns: '1fr 1fr', m: 0 }}>
                  <Detail label="Phone" value={customer.phone} />
                  <Detail label="Company" value={customer.company} />
                  <Detail label="Customer since" value={dateTime.format(new Date(customer.createdAt))} />
                  <Detail label="Last message" value={customer.lastMessageAt === null ? null : dateTime.format(new Date(customer.lastMessageAt))} />
                </Box>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 3 }} aria-label="Tags" role="list">
                  {customer.tags.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No tags
                    </Typography>
                  ) : (
                    customer.tags.map((tag) => <Chip key={tag.id} role="listitem" size="small" label={tag.name} />)
                  )}
                </Box>
              </Paper>
              <Paper variant="outlined" component="section" aria-label="Satisfaction" sx={{ p: 4 }}>
                <Typography component="h2" variant="h3" sx={{ mb: 3 }}>
                  Satisfaction
                </Typography>
                {customer.satisfaction.average === null ? (
                  <Typography variant="body2" color="text.secondary">
                    No ratings yet
                  </Typography>
                ) : (
                  <>
                    <Typography variant="h2" component="p">
                      {customer.satisfaction.average.toFixed(1)} / 5
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {customer.satisfaction.responses} {customer.satisfaction.responses === 1 ? 'rating' : 'ratings'}
                    </Typography>
                  </>
                )}
              </Paper>
            </Box>

            <Box sx={{ display: 'grid', gap: 5, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, mb: 6 }}>
              <TicketList title="Open tickets" tickets={customer.openTickets} onOpenTicket={onOpenTicket} emptyMessage="No open tickets." />
              <TicketList title="Closed tickets" tickets={customer.closedTickets} onOpenTicket={onOpenTicket} emptyMessage="No closed tickets." />
            </Box>

            <Box component="section" aria-label="Conversation history">
              <Typography component="h2" variant="h3" sx={{ mb: 2 }}>
                Conversation history
              </Typography>
              {history.status === 'pending' && <Skeleton variant="list" rows={4} label="conversation history" />}
              {history.status === 'error' && <EmptyState variant="error" title="Couldn't load the history" message={history.errorMessage} onRetry={history.onRetry} headingLevel={3} />}
              {history.status === 'ready' &&
                (history.items.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No messages you can see yet.
                  </Typography>
                ) : (
                  <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {history.items.map((message) => (
                      <Paper
                        key={message.id}
                        component="li"
                        variant="outlined"
                        sx={{ p: 3, ...(message.visibility === 'internal' ? { bgcolor: 'warning.light', borderColor: 'warning.main' } : {}) }}
                      >
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, mb: 1 }}>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {message.authorKind === 'customer' ? customer.name : (message.author?.name ?? 'Support')}
                          </Typography>
                          {message.visibility === 'internal' && <Chip size="small" label="Internal note" />}
                          <Typography variant="caption" color="text.secondary">
                            <time dateTime={message.createdAt}>{dateTime.format(new Date(message.createdAt))}</time>
                          </Typography>
                          <Button size="small" onClick={() => onOpenTicket(message.ticketId)} sx={{ ml: 'auto' }} aria-label={`Open ticket #${message.ticketNumber}`}>
                            #{message.ticketNumber}
                          </Button>
                        </Box>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {message.body}
                        </Typography>
                      </Paper>
                    ))}
                  </Box>
                ))}
              {history.status === 'ready' && history.hasMore && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                  <Button onClick={history.onLoadMore} disabled={history.loadingMore}>
                    {history.loadingMore ? 'Loading…' : 'Load older messages'}
                  </Button>
                </Box>
              )}
            </Box>
          </>
        )}
      </Box>
    </DesignSystemScope>
  );
}
