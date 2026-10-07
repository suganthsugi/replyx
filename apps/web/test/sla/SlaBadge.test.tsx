import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SlaBadge } from '../../src/components/tickets/SlaBadge';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

import type { SlaSummary } from '../../src/data/tickets';

const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

describe('SlaBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('renders nothing for a ticket outside any policy', () => {
    const { container } = renderWithProviders(<SlaBadge sla={{ status: 'none' }} />);
    expect(container.querySelector('[data-sla-status]')).toBeNull();
    expect(screen.queryByText(/left|overdue/i)).toBeNull();
  });

  it('shows time left, and gives assistive technology the full sentence instead', async () => {
    const sla: SlaSummary = { status: 'ok', target: 'first_response', nextDueAt: at(45) };
    const { container } = renderWithProviders(<SlaBadge sla={sla} />);
    expect(screen.getByText('45m left')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('First response due in 45 minutes')).toBeInTheDocument();
    expect(container.querySelector('[data-sla-status="success"]')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('marks an at-risk ticket with a warning icon and says so in words', async () => {
    const sla: SlaSummary = { status: 'warning', target: 'first_response', nextDueAt: at(12) };
    const { container } = renderWithProviders(<SlaBadge sla={sla} />);
    expect(screen.getByText('12m left')).toBeInTheDocument();
    expect(screen.getByText('First response due in 12 minutes, at risk')).toBeInTheDocument();
    expect(container.querySelector('[data-sla-status="warning"]')).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    await expectNoAxeViolations(container);
  });

  it('shows how long a breached ticket is overdue', async () => {
    const sla: SlaSummary = { status: 'breached', target: 'resolution', nextDueAt: at(-5) };
    const { container } = renderWithProviders(<SlaBadge sla={sla} />);
    expect(screen.getByText('Overdue 5m')).toBeInTheDocument();
    expect(screen.getByText('Resolution overdue by 5 minutes')).toBeInTheDocument();
    expect(container.querySelector('[data-sla-status="error"]')).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    await expectNoAxeViolations(container);
  });

  it('ticks on the shared clock: on track, then at-risk wording, then overdue before the server records a breach', () => {
    const sla: SlaSummary = { status: 'ok', target: 'next_response', nextDueAt: at(1) };
    const { container } = renderWithProviders(<SlaBadge sla={sla} />);
    expect(screen.getByText('1m left')).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(45_000));
    expect(screen.getByText('<1m left')).toBeInTheDocument();
    expect(screen.getByText('Next response due in less than a minute')).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(30_000));
    expect(screen.getByText('Overdue <1m')).toBeInTheDocument();
    expect(screen.getByText('Next response just became overdue')).toBeInTheDocument();
    expect(container.querySelector('[data-sla-status="error"]')).not.toBeNull();

    act(() => void vi.advanceTimersByTime(5 * 60_000));
    expect(screen.getByText(/^Overdue [56]m$/)).toBeInTheDocument();
  });

  it('keeps one interval for a list of badges and stops it on unmount', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const sla: SlaSummary = { status: 'ok', target: 'resolution', nextDueAt: at(600) };
    const { unmount } = renderWithProviders(
      <>
        <SlaBadge sla={sla} />
        <SlaBadge sla={sla} />
        <SlaBadge sla={sla} />
      </>,
    );
    expect(spy.mock.calls.filter(([, ms]) => ms === 15_000)).toHaveLength(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    spy.mockRestore();
  });
});
