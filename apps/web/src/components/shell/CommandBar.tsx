import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { isCustomerResult, isTicketResult, useQuickSearch, type SearchScope } from '../../data/search';
import { SearchHighlight } from '../data-display/SearchHighlight';
import { useAnnounce } from '../foundations/LiveRegion';

import { Modal } from './Modal';

/**
 * Ctrl/Cmd+K command bar (T153): jumps to a view by name or a ticket by number. With
 * `onOpenSearch` it also runs a quick search (US13, T233) over tickets and customers and offers
 * "See all results", which opens the search results page.
 */

export interface CommandBarView {
  id: string;
  name: string;
}

export interface CommandBarProps {
  views: readonly CommandBarView[];
  onSelectView: (viewId: string) => void;
  onOpenTicketNumber: (ticketNumber: number) => void;
  /** Opens a ticket found by search. */
  onOpenTicket?: (ticketId: string) => void;
  /** Opens the search results page; its presence turns search on in the command bar. */
  onOpenSearch?: (query: string, type?: SearchScope) => void;
}

type CommandResult =
  | { kind: 'ticket'; key: string; label: string; ticketNumber: number }
  | { kind: 'view'; key: string; label: string; viewId: string }
  | { kind: 'found-ticket'; key: string; label: string; detail: string | undefined; highlight: string | undefined; ticketId: string }
  | { kind: 'found-customer'; key: string; label: string; detail: string; email: string }
  | { kind: 'see-all'; key: string; label: string; query: string };

const TICKET_NUMBER_PATTERN = /^#?(\d+)$/;

export function CommandBar({ views, onSelectView, onOpenTicketNumber, onOpenTicket, onOpenSearch }: CommandBarProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const announce = useAnnounce();
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const searchEnabled = onOpenSearch !== undefined;
  const search = useQuickSearch(open && searchEnabled ? query : '');

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  const results = useMemo<CommandResult[]>(() => {
    const trimmed = query.trim();
    const list: CommandResult[] = [];

    const ticketMatch = TICKET_NUMBER_PATTERN.exec(trimmed);
    if (ticketMatch?.[1] !== undefined) {
      const ticketNumber = Number(ticketMatch[1]);
      list.push({ kind: 'ticket', key: `ticket-${ticketNumber}`, label: `Open ticket ${ticketNumber}`, ticketNumber });
    }

    const needle = trimmed.toLowerCase();
    for (const view of views) {
      if (needle === '' || view.name.toLowerCase().includes(needle)) {
        list.push({ kind: 'view', key: `view-${view.id}`, label: view.name, viewId: view.id });
      }
    }

    if (searchEnabled && trimmed !== '') {
      for (const item of search.data ?? []) {
        if (isTicketResult(item)) {
          list.push({
            kind: 'found-ticket',
            key: `found-ticket-${item.ticket.id}`,
            label: `#${item.ticket.number} ${item.ticket.title}`,
            detail: item.ticket.customer.name,
            highlight: item.highlight,
            ticketId: item.ticket.id,
          });
        } else if (isCustomerResult(item)) {
          list.push({ kind: 'found-customer', key: `found-customer-${item.customer.id}`, label: item.customer.name, detail: item.email, email: item.email });
        }
      }
      list.push({ kind: 'see-all', key: 'see-all', label: `See all results for "${trimmed}"`, query: trimmed });
    }
    return list;
  }, [query, views, searchEnabled, search.data]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    announce(results.length === 0 ? 'No matches' : `${results.length} result${results.length === 1 ? '' : 's'}`);
  }, [results, open, announce]);

  const searching = open && searchEnabled && query.trim() !== '' && search.isFetching;
  const searchError = open && searchEnabled ? search.error?.message : undefined;
  useEffect(() => {
    if (searching) announce('Searching');
  }, [searching, announce]);
  useEffect(() => {
    if (searchError !== undefined) announce(`Search is unavailable: ${searchError}`, 'assertive');
  }, [searchError, announce]);

  const close = () => setOpen(false);

  const commit = (result: CommandResult) => {
    close();
    if (result.kind === 'ticket') onOpenTicketNumber(result.ticketNumber);
    else if (result.kind === 'view') onSelectView(result.viewId);
    else if (result.kind === 'found-ticket') onOpenTicket?.(result.ticketId);
    // A customer has no profile page of their own yet, so choosing one shows their tickets.
    else if (result.kind === 'found-customer') onOpenSearch?.(result.email, 'tickets');
    else onOpenSearch?.(result.query);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      const result = results[activeIndex];
      if (result !== undefined) {
        event.preventDefault();
        commit(result);
      }
    }
  };

  const activeOption = results[activeIndex];
  const activeOptionId = activeOption !== undefined ? `${listboxId}-${activeOption.key}` : undefined;

  return (
    <Modal open={open} onClose={close} title="Jump to" maxWidth="sm">
      <TextField
        inputRef={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        label="Jump to a view or ticket number"
        placeholder={searchEnabled ? 'Type a view, a ticket number such as #1234, or search' : 'Type a view name or a ticket number, e.g. #1234'}
        fullWidth
        autoFocus
        autoComplete="off"
        slotProps={{
          htmlInput: {
            role: 'combobox',
            'aria-expanded': open,
            'aria-controls': listboxId,
            'aria-activedescendant': activeOptionId,
            'aria-autocomplete': 'list',
          },
        }}
      />
      {results.length === 0 ? (
        <Typography color="text.secondary" sx={{ px: 1, pt: 3 }}>
          {query.trim() === '' ? 'Start typing a view name or a ticket number.' : 'No matches.'}
        </Typography>
      ) : (
        <List role="listbox" id={listboxId} aria-label="Command results" dense sx={{ mt: 2, maxHeight: 320, overflowY: 'auto' }}>
          {results.map((result, index) => (
            <ListItemButton
              key={result.key}
              id={`${listboxId}-${result.key}`}
              role="option"
              aria-selected={index === activeIndex}
              selected={index === activeIndex}
              onClick={() => commit(result)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <ListItemText primary={result.label} secondary={optionSecondary(result)} />
            </ListItemButton>
          ))}
        </List>
      )}
      {searching && (
        <Typography variant="caption" color="text.secondary" sx={{ px: 1, pt: 1, display: 'block' }}>
          Searching…
        </Typography>
      )}
      {searchError !== undefined && (
        <Typography variant="caption" color="error" sx={{ px: 1, pt: 1, display: 'block' }}>
          Search is unavailable: {searchError}
        </Typography>
      )}
    </Modal>
  );
}

function optionSecondary(result: CommandResult): ReactNode {
  switch (result.kind) {
    case 'ticket':
      return 'Ticket';
    case 'view':
      return 'View';
    case 'found-ticket':
      return result.highlight === undefined || result.highlight === '' ? (
        result.detail
      ) : (
        <>
          {result.detail} · <SearchHighlight highlight={result.highlight} />
        </>
      );
    case 'found-customer':
      return `Customer · ${result.detail}`;
    case 'see-all':
      return 'Search page';
  }
}
