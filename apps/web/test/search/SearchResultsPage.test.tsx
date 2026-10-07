import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import SearchResultsPage from '../../src/pages/desk/search/SearchResultsPage';
import { makeView, viewsHandler } from '../desk/fixtures';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import { customerResult, searchHandler, ticketResult } from './fixtures';


function renderPage(route: string) {
  return renderWithProviders(<SearchResultsPage />, { route });
}

describe('SearchResultsPage', () => {
  it('asks for a search term when the URL has none, without calling the API', async () => {
    const seen: URL[] = [];
    server.use(searchHandler(() => ({ items: [], nextCursor: null }), seen), viewsHandler([makeView()]));
    const { container } = renderPage('/desk/search');
    expect(await screen.findByRole('heading', { name: 'Search tickets and customers' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Search results' })).toBeInTheDocument();
    expect(seen).toHaveLength(0);
    await expectNoAxeViolations(container);
  });

  it('shows a loading state, then tickets with highlighted snippets and customers, and announces the count', async () => {
    server.use(
      viewsHandler([makeView({ id: 'view-7' })]),
      searchHandler(() => ({
        items: [
          ticketResult('t-1', 4471, 'Invoice question', 'Please resend ⟦invoice⟧ 4471 today'),
          customerResult('c-9', 'Ines Invoice', 'ines@example.com'),
        ],
        nextCursor: null,
      })),
    );
    const { container } = renderPage('/desk/search?q=invoice');
    expect(screen.getByText('Loading search results')).toBeInTheDocument();

    const list = await screen.findByRole('list', { name: 'Search results' });
    const link = await within(list).findByRole('link', { name: /Invoice question/ });
    expect(link).toHaveAttribute('href', '/desk/inbox/view-7/t-1');
    const mark = within(link).getByText('invoice');
    expect(mark.tagName).toBe('MARK');
    expect(link).toHaveTextContent('Please resend invoice 4471 today');

    expect(within(list).getByText('Ines Invoice')).toBeInTheDocument();
    expect(within(list).getByText('ines@example.com')).toBeInTheDocument();
    expect(within(list).getAllByRole('link')).toHaveLength(1);

    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('2 results for invoice');
    await expectNoAxeViolations(container);
  });

  it('never renders markup in a snippet as HTML', async () => {
    server.use(
      viewsHandler([makeView()]),
      searchHandler(() => ({ items: [ticketResult('t-1', 1, 'Odd', '<img src=x onerror=alert(1)> ⟦hi⟧')], nextCursor: null })),
    );
    const { container } = renderPage('/desk/search?q=hi');
    await screen.findByRole('list', { name: 'Search results' });
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)> hi');
  });

  it('keeps the filter in the URL and sends it to the API', async () => {
    const seen: URL[] = [];
    server.use(
      viewsHandler([makeView()]),
      searchHandler(
        (url) => ({
          items:
            url.searchParams.get('type') === 'customers'
              ? [customerResult('c-1', 'Cara Customer', 'cara@example.com')]
              : [ticketResult('t-1', 1, 'A ticket')],
          nextCursor: null,
        }),
        seen,
      ),
    );
    renderPage('/desk/search?q=cara');
    expect(await screen.findByText('A ticket')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Customers' }));
    expect(await screen.findByText('cara@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Customers' })).toHaveAttribute('aria-pressed', 'true');
    expect(seen.at(-1)?.searchParams.get('type')).toBe('customers');
    expect(seen.at(-1)?.searchParams.get('q')).toBe('cara');
  });

  it('reads the filter from the URL on load', async () => {
    const seen: URL[] = [];
    server.use(viewsHandler([makeView()]), searchHandler(() => ({ items: [ticketResult('t-1', 1, 'A ticket')], nextCursor: null }), seen));
    renderPage('/desk/search?q=a&type=tickets');
    await screen.findByText('A ticket');
    expect(screen.getByRole('button', { name: 'Tickets' })).toHaveAttribute('aria-pressed', 'true');
    expect(seen[0]?.searchParams.get('type')).toBe('tickets');
  });

  it('loads more results with the cursor', async () => {
    server.use(
      viewsHandler([makeView()]),
      searchHandler((url) =>
        url.searchParams.get('cursor') === 'page-2'
          ? { items: [ticketResult('t-2', 2, 'Second page ticket')], nextCursor: null }
          : { items: [ticketResult('t-1', 1, 'First page ticket')], nextCursor: 'page-2' },
      ),
    );
    renderPage('/desk/search?q=ticket');
    await screen.findByText('First page ticket');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second page ticket')).toBeInTheDocument();
    expect(screen.getByText('First page ticket')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    server.use(viewsHandler([makeView()]), searchHandler(() => ({ items: [], nextCursor: null })));
    const { container } = renderPage('/desk/search?q=zzz');
    expect(await screen.findByRole('heading', { name: 'No results for "zzz"' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows an error state with a retry', async () => {
    let fail = true;
    server.use(
      viewsHandler([makeView()]),
      http.get(`${API}/search`, () =>
        fail
          ? errorResponse(500, 'INTERNAL', 'Boom')
          : HttpResponse.json({ items: [ticketResult('t-1', 1, 'Recovered')], nextCursor: null }),
      ),
    );
    const { container } = renderPage('/desk/search?q=x');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load search results");
    await expectNoAxeViolations(container);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recovered')).toBeInTheDocument();
  });

  it('searches again from the form', async () => {
    const seen: URL[] = [];
    server.use(viewsHandler([makeView()]), searchHandler(() => ({ items: [ticketResult('t-1', 1, 'Found')], nextCursor: null }), seen));
    renderPage('/desk/search');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search tickets and customers' }), '  refund {Enter}');
    expect(await screen.findByText('Found')).toBeInTheDocument();
    expect(seen[0]?.searchParams.get('q')).toBe('refund');
  });
});
