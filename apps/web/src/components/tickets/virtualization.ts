import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Fixed-row-height virtualization shared by `DataTable` and `TicketList`: only the rows inside
 * the scrolled viewport (plus overscan) are ever mounted, so long ticket lists and tables stay
 * cheap to render and scroll. Callers own the scroll container (`containerRef`) and its keyboard
 * handling; this hook only tracks scroll position and viewport size and turns them into a range.
 */

export interface VirtualRange {
  /** Index of the first row to render (inclusive). */
  startIndex: number;
  /** Index one past the last row to render (exclusive). */
  endIndex: number;
  /** Pixel offset of the rendered block from the top of the scrollable content. */
  offsetY: number;
  /** Total scrollable height, so the container reserves space for every row. */
  totalHeight: number;
}

export interface UseVirtualRowsOptions {
  count: number;
  rowHeight: number;
  /** Extra rows rendered above and below the viewport, so a fast scroll or a moved keyboard focus doesn't flash empty space. */
  overscan?: number;
}

export interface UseVirtualRowsResult {
  containerRef: (node: HTMLDivElement | null) => void;
  onScroll: () => void;
  range: VirtualRange;
  /** Scrolls just enough to bring `index` fully into view; used for keyboard row navigation. */
  scrollToRow: (index: number) => void;
}

export function useVirtualRows({ count, rowHeight, overscan = 4 }: UseVirtualRowsOptions): UseVirtualRowsResult {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    elementRef.current = node;
    if (node !== null) setViewportHeight(node.clientHeight);
  }, []);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const element = elementRef.current;
    if (element !== null) setScrollTop(element.scrollTop);
  }, []);

  const range = useMemo<VirtualRange>(() => {
    const totalHeight = count * rowHeight;
    if (count === 0 || rowHeight <= 0) return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight };
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visibleRows = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
    const endIndex = Math.min(count, startIndex + visibleRows);
    return { startIndex, endIndex, offsetY: startIndex * rowHeight, totalHeight };
  }, [count, rowHeight, overscan, scrollTop, viewportHeight]);

  const scrollToRow = useCallback(
    (index: number) => {
      const element = elementRef.current;
      if (element === null) return;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
    },
    [rowHeight],
  );

  return { containerRef, onScroll, range, scrollToRow };
}
