/**
 * What a push or email notification says (notification-digest.job.ts builds it). `url` is a path
 * on the tenant's host; `tag` lets the browser replace an older notification of the same burst.
 */
export interface ChannelMessage {
  title: string;
  body: string | null;
  url: string;
  tag: string;
}
