import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { DataTable } from '../../src/components/tickets/DataTable';
import { renderWithProviders } from '../render';

/**
 * `useVirtualRows` sizes its viewport from the container's `clientHeight`, which jsdom always
 * reports as 0. Mocking it on the prototype lets these tests mount every row, like a tall enough
 * scrollable pane would.
 */
function mockClientHeight(height: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: height });
}

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 0 });
});

interface Row {
  id: string;
  name: string;
}

function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: `row-${index + 1}`, name: `Row ${index + 1}` }));
}

const columns = [{ key: 'name', header: 'Name', render: (row: Row) => row.name }];

describe('DataTable', () => {
  it('clamps the roving tab stop and focus to the last row when rows shrink after End', async () => {
    mockClientHeight(2000);
    const user = userEvent.setup();
    const rows = makeRows(5);
    const { rerender } = renderWithProviders(<DataTable columns={columns} rows={rows} getRowId={(row) => row.id} label="Rows" />);

    const dataRows = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-rowindex') !== null);
    dataRows[0]!.focus();
    await user.keyboard('{End}');

    const focusedRows = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-rowindex') !== null);
    expect(focusedRows[4]!).toHaveFocus();

    const fewerRows = makeRows(3);
    rerender(<DataTable columns={columns} rows={fewerRows} getRowId={(row) => row.id} label="Rows" />);

    const remainingRows = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-rowindex') !== null);
    const focusable = remainingRows.filter((row) => row.getAttribute('tabindex') === '0');
    expect(focusable).toHaveLength(1);
    expect(focusable[0]).toBe(remainingRows[remainingRows.length - 1]);
    expect(document.activeElement).toBe(remainingRows[remainingRows.length - 1]);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('does not steal focus back into the grid after a blur to dead space, then a shrink', () => {
    mockClientHeight(2000);
    const rows = makeRows(5);
    const { rerender } = renderWithProviders(<DataTable columns={columns} rows={rows} getRowId={(row) => row.id} label="Rows" />);

    const dataRows = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-rowindex') !== null);
    dataRows[4]!.focus();
    expect(dataRows[4]!).toHaveFocus();

    // A blur to nowhere focusable (dead space, a window blur): the row stays in the DOM, so this
    // is a real focus loss, not a shrink removing the focused row. `.blur()` (unlike
    // `fireEvent.blur`) actually moves `document.activeElement`, which then falls back to <body>.
    dataRows[4]!.blur();
    expect(document.activeElement).toBe(document.body);

    const fewerRows = makeRows(3);
    rerender(<DataTable columns={columns} rows={fewerRows} getRowId={(row) => row.id} label="Rows" />);

    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus through several rows while ArrowDown is held', async () => {
    mockClientHeight(2000);
    const user = userEvent.setup();
    const rows = makeRows(6);
    renderWithProviders(<DataTable columns={columns} rows={rows} getRowId={(row) => row.id} label="Rows" />);

    const dataRows = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-rowindex') !== null);
    dataRows[0]!.focus();
    await user.keyboard('{ArrowDown>3/}');

    const focusedRows = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-rowindex') !== null);
    expect(focusedRows[3]!).toHaveFocus();
  });
});
