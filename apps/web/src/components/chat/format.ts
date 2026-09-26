/** Times in the chat: "3:12 PM" today, "Mon 3:12 PM" this week, "Sep 22, 3:12 PM" before that. */
export function formatChatTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** "Sep 22" for dividers between past conversations. */
export function formatChatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
