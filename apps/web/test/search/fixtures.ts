import { http, HttpResponse } from 'msw';

import { makeTicketSummary } from '../desk/fixtures';
import { API } from '../msw/handlers';

import type { SearchCustomerResult, SearchTicketResult, SearchTickets200 } from '../../src/api/generated/model';

export function ticketResult(id: string, number: number, title: string, highlight?: string): SearchTicketResult {
  return {
    type: 'ticket',
    ticket: makeTicketSummary({ id, number, title, customer: { id: 'c-1', name: 'Cara Customer' } }),
    ...(highlight === undefined ? {} : { highlight }),
  };
}

export function customerResult(id: string, name: string, email: string): SearchCustomerResult {
  return { type: 'customer', customer: { id, name }, email };
}

/** Answers `GET /search` with `respond(url)` and records every request URL. */
export function searchHandler(respond: (url: URL) => SearchTickets200, seen: URL[] = []) {
  return http.get(`${API}/search`, ({ request }) => {
    const url = new URL(request.url);
    seen.push(url);
    return HttpResponse.json<SearchTickets200>(respond(url));
  });
}
