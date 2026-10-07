import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useEffect, useState, type FormEvent } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';

import { SearchHighlight } from '../../../components/data-display/SearchHighlight';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { StatePill } from '../../../components/tickets/StatePill';
import {
  isCustomerResult,
  isTicketResult,
  SEARCH_MAX_QUERY_LENGTH,
  useSearchResults,
  type SearchCustomerResult,
  type SearchScope,
  type SearchTicketResult,
} from '../../../data/search';
import { useViews } from '../../../data/views';
import { WORKSPACE_BASE } from '../../../routes/area';

/**
 * Search results (US13, FR-070): tickets and customers the signed-in person can access, with a
 * Tickets / Customers / All filter and the query both kept in the URL (`?q=…&type=…`) so a result
 * list can be shared or reloaded. Results load a page at a time through "Load more".
 */

const SCOPES: readonly { value: SearchScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'tickets', label: 'Tickets' },
  { value: 'customers', label: 'Customers' },
];

function parseScope(value: string | null): SearchScope {
  return SCOPES.find((scope) => scope.value === value)?.value ?? 'all';
}

export default function SearchResultsPage() {
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').slice(0, SEARCH_MAX_QUERY_LENGTH);
  const type = parseScope(params.get('type'));
  const [draft, setDraft] = useState(q);
  const announce = useAnnounce();
  const results = useSearchResults(q, type);
  const views = useViews();
  const ticketViewId = views.data?.[0]?.id;

  useEffect(() => setDraft(q), [q]);

  const trimmedQuery = results.query;
  const loadedCount = results.items.length;
  const { isSuccess, hasNextPage } = results;
  useEffect(() => {
    if (!isSuccess) return;
    announce(
      loadedCount === 0
        ? `No results for ${trimmedQuery}`
        : `${loadedCount} result${loadedCount === 1 ? '' : 's'} for ${trimmedQuery}${hasNextPage ? ', more available' : ''}`,
    );
  }, [isSuccess, loadedCount, hasNextPage, trimmedQuery, announce]);

  const update = (next: { q?: string; type?: SearchScope }) => {
    const nextQ = next.q ?? q;
    const nextType = next.type ?? type;
    const nextParams = new URLSearchParams();
    if (nextQ !== '') nextParams.set('q', nextQ);
    if (nextType !== 'all') nextParams.set('type', nextType);
    setParams(nextParams);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update({ q: draft.trim() });
  };

  return (
    <Box component="main" id="desk-main" sx={{ maxWidth: 760, mx: 'auto', p: 4 }}>
      <Typography component="h1" variant="h2" sx={{ mb: 3 }}>
        Search results
      </Typography>

      <Box component="form" role="search" aria-label="Search tickets and customers" onSubmit={submit} sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <TextField
          type="search"
          label="Search tickets and customers"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          size="small"
          fullWidth
          autoComplete="off"
          slotProps={{ htmlInput: { maxLength: SEARCH_MAX_QUERY_LENGTH } }}
        />
        <Button type="submit" variant="contained">
          Search
        </Button>
      </Box>

      <ToggleButtonGroup
        exclusive
        size="small"
        value={type}
        aria-label="Show"
        onChange={(_event, value: SearchScope | null) => {
          if (value !== null) update({ type: value });
        }}
        sx={{ mb: 3 }}
      >
        {SCOPES.map((scope) => (
          <ToggleButton key={scope.value} value={scope.value}>
            {scope.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {trimmedQuery === '' ? (
        <EmptyState title="Search tickets and customers" message="Type a ticket number, a name, an email or words from a message." />
      ) : results.isPending ? (
        <Skeleton variant="list" rows={6} label="search results" />
      ) : results.isError && loadedCount === 0 ? (
        <EmptyState
          variant="error"
          title="Couldn't load search results"
          message={results.error?.message}
          onRetry={() => void results.refetch()}
        />
      ) : loadedCount === 0 ? (
        <EmptyState title={`No results for "${trimmedQuery}"`} message="Try a shorter part of a name or email, or check the spelling of a tag." />
      ) : (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {loadedCount} result{loadedCount === 1 ? '' : 's'}
            {hasNextPage ? ' so far' : ''} for "{trimmedQuery}"
          </Typography>
          <List aria-label="Search results" disablePadding>
            {results.items.map((item) =>
              isTicketResult(item) ? (
                <TicketResultRow key={`ticket-${item.ticket.id}`} result={item} viewId={ticketViewId} />
              ) : isCustomerResult(item) ? (
                <CustomerResultRow key={`customer-${item.customer.id}`} result={item} />
              ) : null,
            )}
          </List>
          {results.isError && (
            <Typography role="alert" color="error" variant="body2" sx={{ textAlign: 'center', py: 1 }}>
              {results.error?.message ?? "Couldn't load more results."}
            </Typography>
          )}
          {hasNextPage && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <Button onClick={() => void results.fetchNextPage()} disabled={results.isFetchingNextPage}>
                {results.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

const rowSx = { borderRadius: 2, alignItems: 'flex-start', flexDirection: 'column', gap: 1 } as const;

function TicketResultRow({ result, viewId }: { result: SearchTicketResult; viewId: string | undefined }) {
  const { ticket } = result;
  const content = (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <StatePill state={ticket.state} />
        <Typography variant="caption" color="text.secondary">
          #{ticket.number}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {ticket.title}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {ticket.customer.name}
      </Typography>
      {result.highlight !== undefined && result.highlight !== '' && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          <SearchHighlight highlight={result.highlight} />
        </Typography>
      )}
    </>
  );
  return (
    <ListItem disablePadding>
      {viewId === undefined ? (
        <Box sx={{ ...rowSx, display: 'flex', width: '100%', px: 4, py: 2 }}>{content}</Box>
      ) : (
        <ListItemButton component={RouterLink} to={`${WORKSPACE_BASE}/inbox/${viewId}/${ticket.id}`} sx={rowSx}>
          {content}
        </ListItemButton>
      )}
    </ListItem>
  );
}

/** No customer profile route exists yet, so a customer is shown as plain text. */
function CustomerResultRow({ result }: { result: SearchCustomerResult }) {
  return (
    <ListItem sx={{ ...rowSx, display: 'flex', gap: 0.5, px: 4, py: 2 }}>
      <Typography variant="caption" color="text.secondary">
        Customer
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {result.customer.name}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {result.email}
      </Typography>
    </ListItem>
  );
}
