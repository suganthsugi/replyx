import Box from '@mui/material/Box';
import { useLayoutEffect, useRef, useState } from 'react';

import { useVirtualRows } from './virtualization';

import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';

/**
 * A virtualized, keyboard-navigable data table (plan.md "Shared component system"): an ARIA grid
 * where each row is one tab stop (arrow keys move the active row, Enter/Space activates it), and
 * only the rows near the scrolled viewport are mounted. Column headers and cells carry the
 * `columnheader`/`gridcell` roles a grid needs; loading, empty and error states are the caller's
 * job (ui-components rule 2) since this component only knows about the rows it was given.
 */

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** A `grid-template-columns` track, e.g. `'96px'` or `'2fr'`. Defaults to `'1fr'`. */
  width?: string;
  align?: 'left' | 'right' | 'center';
}

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  getRowId: (row: T) => string;
  /** Accessible name for the grid. */
  label: string;
  onRowActivate?: (row: T) => void;
  selectedId?: string;
  rowHeight?: number;
  height?: number | string;
  overscan?: number;
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  label,
  onRowActivate,
  selectedId,
  rowHeight = 44,
  height = 480,
  overscan = 6,
}: DataTableProps<T>) {
  const { containerRef, onScroll, range, scrollToRow } = useVirtualRows({ count: rows.length, rowHeight, overscan });
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const containerElRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef(false);
  // Whether focus is currently inside the grid, tracked via focusin/focusout (bubbling)
  // instead of `document.activeElement`: when a shrink removes the focused row in the same
  // commit, the browser has already moved `document.activeElement` to <body> by the time our
  // layout effect below runs, so that check can never see the row was focused.
  const focusWithinRef = useRef(false);

  // Keep the roving tab stop in range when the row set shrinks (a view switch, a live update
  // removing a row, a refetch). If focus was inside the grid when its target row disappeared,
  // flag that focus should follow the clamped row instead of falling through to <body>.
  useLayoutEffect(() => {
    const maxIndex = Math.max(0, rows.length - 1);
    if (activeIndex > maxIndex) {
      if (focusWithinRef.current) {
        pendingFocusRef.current = true;
      }
      setActiveIndex(maxIndex);
    }
  }, [rows.length, activeIndex]);

  // Focus the active row once it has a mounted ref. Keyboard navigation (or the clamp above) may
  // target a row outside the currently virtualized range; this retries as `range` grows to
  // include it, instead of assuming a fixed scroll timing.
  useLayoutEffect(() => {
    if (!pendingFocusRef.current) return;
    const node = rowRefs.current.get(activeIndex);
    if (node !== undefined) {
      node.focus();
      pendingFocusRef.current = false;
    }
  }, [activeIndex, range]);

  const focusRow = (index: number) => {
    if (rows.length === 0) return;
    const clamped = Math.max(0, Math.min(index, rows.length - 1));
    pendingFocusRef.current = true;
    setActiveIndex(clamped);
    scrollToRow(clamped);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(activeIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRow(rows.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      const row = rows[activeIndex];
      if (row !== undefined) {
        event.preventDefault();
        onRowActivate?.(row);
      }
    }
  };

  const gridTemplateColumns = columns.map((column) => column.width ?? '1fr').join(' ');

  return (
    <Box
      role="grid"
      aria-label={label}
      aria-rowcount={rows.length}
      onKeyDown={onKeyDown}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, overflow: 'hidden' }}
    >
      <Box role="row" sx={{ display: 'grid', gridTemplateColumns, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
        {columns.map((column) => (
          <Box
            key={column.key}
            role="columnheader"
            sx={{ px: 3, py: 2, typography: 'overline', color: 'text.secondary', textAlign: column.align ?? 'left' }}
          >
            {column.header}
          </Box>
        ))}
      </Box>
      <Box
        ref={(node: HTMLDivElement | null) => {
          containerRef(node);
          containerElRef.current = node;
        }}
        onScroll={onScroll}
        onFocus={() => {
          focusWithinRef.current = true;
        }}
        onBlur={(event: FocusEvent<HTMLDivElement>) => {
          const related = event.relatedTarget as Node | null;
          if (related !== null) {
            // Focus moved to a known element: it only left the grid if that element is outside it.
            if (containerElRef.current?.contains(related) !== true) {
              focusWithinRef.current = false;
            }
            return;
          }
          // No relatedTarget happens both when focus genuinely leaves to nowhere focusable (a
          // click into dead space, a window blur) and when the focused row is removed from the
          // DOM by a shrink in the same commit. Tell them apart by whether the blurred row is
          // still connected: a real blur leaves it in the tree; the DOM's node-removal algorithm
          // detaches a node before running its removal steps (which include unfocusing), so a
          // removal-caused blur fires on an already-detached row.
          if ((event.target as Node).isConnected) {
            focusWithinRef.current = false;
          }
        }}
        sx={{ height, overflowY: 'auto', position: 'relative' }}
      >
        <Box sx={{ height: range.totalHeight, position: 'relative' }}>
          <Box sx={{ position: 'absolute', top: range.offsetY, left: 0, right: 0 }}>
            {rows.slice(range.startIndex, range.endIndex).map((row, offset) => {
              const index = range.startIndex + offset;
              const id = getRowId(row);
              return (
                <Box
                  key={id}
                  ref={(node: HTMLDivElement | null) => {
                    if (node === null) rowRefs.current.delete(index);
                    else rowRefs.current.set(index, node);
                  }}
                  role="row"
                  aria-rowindex={index + 1}
                  aria-selected={selectedId !== undefined ? id === selectedId : undefined}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => {
                    setActiveIndex(index);
                    onRowActivate?.(row);
                  }}
                  sx={{
                    display: 'grid',
                    gridTemplateColumns,
                    height: rowHeight,
                    alignItems: 'center',
                    boxSizing: 'border-box',
                    cursor: onRowActivate !== undefined ? 'pointer' : undefined,
                    bgcolor: id === selectedId ? 'action.selected' : 'background.paper',
                    borderBottom: 1,
                    borderColor: 'divider',
                    '&:hover': onRowActivate !== undefined ? { bgcolor: 'action.hover' } : undefined,
                  }}
                >
                  {columns.map((column) => (
                    <Box key={column.key} role="gridcell" sx={{ px: 3, minWidth: 0, textAlign: column.align ?? 'left' }}>
                      {column.render(row)}
                    </Box>
                  ))}
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
