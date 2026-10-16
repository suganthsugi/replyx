import type { ListTicketsParams } from '../api/generated/model';

/**
 * Query keys of the ticket hooks (tickets.ts). Their own module, so code that only touches the
 * ticket cache (the AI responder events, which the customer chat also uses) doesn't pull the staff
 * ticket hooks and client into the customer bundle (T266).
 */

export type TicketFilters = Omit<ListTicketsParams, 'limit' | 'cursor'>;

export const ticketKeys = {
  all: ['tickets'] as const,
  list: (filters: TicketFilters) => [...ticketKeys.all, 'list', filters] as const,
  detail: (id: string) => [...ticketKeys.all, 'detail', id] as const,
  history: (id: string) => [...ticketKeys.all, 'history', id] as const,
};
