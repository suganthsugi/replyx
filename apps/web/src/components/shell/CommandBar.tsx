import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { useAnnounce } from '../foundations/LiveRegion';

import { Modal } from './Modal';

/**
 * Ctrl/Cmd+K command bar (T153): jumps to a view by name or a ticket by number. Full search
 * across messages and customers arrives in US13 (T233), which extends this component.
 */

export interface CommandBarView {
  id: string;
  name: string;
}

export interface CommandBarProps {
  views: readonly CommandBarView[];
  onSelectView: (viewId: string) => void;
  onOpenTicketNumber: (ticketNumber: number) => void;
}

type CommandResult =
  | { kind: 'ticket'; key: string; label: string; ticketNumber: number }
  | { kind: 'view'; key: string; label: string; viewId: string };

const TICKET_NUMBER_PATTERN = /^#?(\d+)$/;

export function CommandBar({ views, onSelectView, onOpenTicketNumber }: CommandBarProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const announce = useAnnounce();
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

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
    return list;
  }, [query, views]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    announce(results.length === 0 ? 'No matches' : `${results.length} result${results.length === 1 ? '' : 's'}`);
  }, [results, open, announce]);

  const close = () => setOpen(false);

  const commit = (result: CommandResult) => {
    close();
    if (result.kind === 'ticket') onOpenTicketNumber(result.ticketNumber);
    else onSelectView(result.viewId);
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
        placeholder="Type a view name or a ticket number, e.g. #1234"
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
              <ListItemText primary={result.label} secondary={result.kind === 'ticket' ? 'Ticket' : 'View'} />
            </ListItemButton>
          ))}
        </List>
      )}
    </Modal>
  );
}
