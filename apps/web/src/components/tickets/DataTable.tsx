import Box from '@mui/material/Box';
import { useRef, useState } from 'react';

import { useVirtualRows } from './virtualization';

import type { KeyboardEvent, ReactNode } from 'react';

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

  const focusRow = (index: number) => {
    if (rows.length === 0) return;
    const clamped = Math.max(0, Math.min(index, rows.length - 1));
    setActiveIndex(clamped);
    scrollToRow(clamped);
    // The target row may not exist in the DOM yet on the frame the scroll lands; focus it once
    // the next render has mounted it.
    requestAnimationFrame(() => rowRefs.current.get(clamped)?.focus());
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
      <Box ref={containerRef} onScroll={onScroll} sx={{ height, overflowY: 'auto', position: 'relative' }}>
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
