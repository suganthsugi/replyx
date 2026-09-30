import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { useEffect, useRef, type ReactNode } from 'react';

import { ArrowDownIcon, ArrowUpIcon, CloseIcon } from '../foundations/icons';
import { useAnnounce } from '../foundations/LiveRegion';

/**
 * A short list whose order matters (sort keys, columns), edited with Move up / Move down / Remove
 * buttons instead of drag and drop. Focus stays on the button that was pressed (or its opposite
 * when the item reaches an end), moves to a neighbour after a removal, and every change is
 * announced.
 */

export interface OrderedListProps<T> {
  /** Accessible name of the list, e.g. "Columns". */
  label: string;
  /** What one item is called in announcements, e.g. "column". */
  noun: string;
  items: readonly T[];
  getKey: (item: T) => string;
  /** The item's name for buttons and announcements. */
  getLabel: (item: T) => string;
  /** The row content (defaults to the label); may include extra controls. */
  renderItem?: (item: T, index: number) => ReactNode;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  /** Called after the last item is removed so the caller can move focus to its Add control. */
  onEmptied?: () => void;
  disabled?: boolean;
  emptyText?: string;
}

type FocusRequest = { key: string; action: 'up' | 'down' | 'remove' };

export function OrderedList<T>({
  label,
  noun,
  items,
  getKey,
  getLabel,
  renderItem,
  onMove,
  onRemove,
  onEmptied,
  disabled = false,
  emptyText,
}: OrderedListProps<T>) {
  const announce = useAnnounce();
  const listRef = useRef<HTMLUListElement>(null);
  const focusRequest = useRef<FocusRequest | null>(null);

  useEffect(() => {
    const request = focusRequest.current;
    if (request === null) return;
    focusRequest.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-item="${request.key}"] [data-action="${request.action}"]:not(:disabled)`)?.focus();
  });

  if (items.length === 0) {
    return emptyText === undefined ? null : (
      <Typography variant="body2" color="text.secondary">
        {emptyText}
      </Typography>
    );
  }

  const move = (index: number, delta: -1 | 1) => {
    const item = items[index];
    if (item === undefined) return;
    const target = index + delta;
    const atEnd = delta === -1 ? target === 0 : target === items.length - 1;
    focusRequest.current = { key: getKey(item), action: atEnd ? (delta === -1 ? 'down' : 'up') : delta === -1 ? 'up' : 'down' };
    onMove(index, target);
    announce(`${getLabel(item)} moved to position ${target + 1} of ${items.length}.`);
  };

  const remove = (index: number) => {
    const item = items[index];
    if (item === undefined) return;
    const neighbour = items[index + 1] ?? items[index - 1];
    focusRequest.current = neighbour === undefined ? null : { key: getKey(neighbour), action: 'remove' };
    onRemove(index);
    announce(`${getLabel(item)} removed. ${items.length - 1} ${noun}${items.length - 1 === 1 ? '' : 's'} left.`);
    if (neighbour === undefined) onEmptied?.();
  };

  return (
    <Box
      ref={listRef}
      component="ul"
      aria-label={label}
      sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}
    >
      {items.map((item, index) => {
        const name = getLabel(item);
        return (
          <Box
            key={getKey(item)}
            component="li"
            data-item={getKey(item)}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.5, pl: 3, border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper' }}
          >
            <Typography variant="caption" color="text.secondary" aria-hidden="true" sx={{ width: 20 }}>
              {index + 1}
            </Typography>
            <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
              {renderItem === undefined ? <Typography variant="body2">{name}</Typography> : renderItem(item, index)}
            </Box>
            <IconButton size="small" data-action="up" aria-label={`Move ${name} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>
              <ArrowUpIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              data-action="down"
              aria-label={`Move ${name} down`}
              disabled={disabled || index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDownIcon fontSize="small" />
            </IconButton>
            <IconButton size="small" data-action="remove" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => remove(index)}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
        );
      })}
    </Box>
  );
}
