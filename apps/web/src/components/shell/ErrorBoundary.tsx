import { Component, type ErrorInfo, type ReactNode } from 'react';

import { EmptyState } from '../foundations/EmptyState';

/**
 * Catches render errors in an area (customer chat, workspace pane) so one broken component
 * doesn't blank the app. Shows a generic message (never the error text) with a retry that
 * re-renders the children; `resetKeys` changing (e.g. the route) also resets it.
 */

export interface ErrorBoundaryProps {
  children: ReactNode;
  title?: string;
  message?: string;
  /** Reported errors (logging/telemetry); the UI never shows them. */
  onError?: (error: Error, info: ErrorInfo) => void;
  resetKeys?: readonly unknown[];
}

interface State {
  failed: boolean;
  resetKeys: readonly unknown[];
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { failed: false, resetKeys: this.props.resetKeys ?? [] };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    const keys = props.resetKeys ?? [];
    const changed = keys.length !== state.resetKeys.length || keys.some((key, index) => !Object.is(key, state.resetKeys[index]));
    return changed ? { failed: false, resetKeys: keys } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly retry = () => this.setState({ failed: false });

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <EmptyState
        variant="error"
        title={this.props.title ?? 'Something went wrong'}
        message={this.props.message ?? 'This part of the page could not be shown. Try again, or reload the page.'}
        onRetry={this.retry}
      />
    );
  }
}
