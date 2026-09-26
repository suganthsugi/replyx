/**
 * Small component-level types for ticket components that don't have a generated API counterpart
 * yet (ui-components rule 4): ticket history and live presence. Once their endpoints and hooks
 * (T145, T155) exist, callers map the response onto these shapes; they don't need to change here.
 */

/** One line in the ticket's audit trail, e.g. "Priority set to High by Sam". */
export interface HistoryEvent {
  id: string;
  text: string;
  createdAt: string;
}

/** Someone else with this ticket open right now. */
export interface PresenceUser {
  id: string;
  name: string;
  status: 'viewing' | 'typing';
}
