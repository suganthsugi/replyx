import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  defaultBusinessHours,
  toBusinessHoursInput,
  toBusinessHoursValue,
  validateBusinessHours,
  type BusinessHoursValue,
} from '../../src/components/builders/business-hours-model';
import { BusinessHoursEditor, type BusinessHoursEditorProps } from '../../src/components/builders/BusinessHoursEditor';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

function Harness({ initial, onValue, ...props }: Partial<BusinessHoursEditorProps> & { initial?: BusinessHoursValue; onValue?: (v: BusinessHoursValue) => void }) {
  const [value, setValue] = useState(initial ?? defaultBusinessHours('Europe/Berlin'));
  return (
    <BusinessHoursEditor
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

const live = (container: HTMLElement, mode: 'polite' | 'assertive' = 'polite') => container.ownerDocument.querySelector(`[aria-live="${mode}"]`);

describe('BusinessHoursEditor', () => {
  it('renders every weekday with labelled controls and is free of axe violations', async () => {
    const { container } = renderWithProviders(<Harness />);
    expect(screen.getByRole('combobox', { name: /^Time zone/ })).toHaveValue('Europe/Berlin');
    expect(screen.getByRole('switch', { name: 'Monday open' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Saturday open' })).not.toBeChecked();
    expect(screen.getByLabelText('Monday start 1')).toHaveValue('09:00');
    expect(screen.getByLabelText('Monday end 1')).toHaveValue('17:00');
    expect(screen.queryByLabelText('Saturday start 1')).not.toBeInTheDocument();
    expect(screen.getByText('No holidays added.')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('opens and closes a day and announces it', async () => {
    const onValue = vi.fn<(v: BusinessHoursValue) => void>();
    const { container } = renderWithProviders(<Harness onValue={onValue} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Saturday open' }));
    expect(onValue.mock.lastCall?.[0].intervals.sat).toEqual([{ from: '09:00', to: '17:00' }]);
    expect(screen.getByLabelText('Saturday start 1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Monday open' }));
    expect(onValue.mock.lastCall?.[0].intervals.mon).toEqual([]);
    expect(screen.queryByLabelText('Monday start 1')).not.toBeInTheDocument();
    expect(live(container)).toHaveTextContent('Monday closed.');
  });

  it('edits times and shows a hint when a range crosses midnight', () => {
    const onValue = vi.fn<(v: BusinessHoursValue) => void>();
    renderWithProviders(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('Monday start 1'), { target: { value: '22:00' } });
    fireEvent.change(screen.getByLabelText('Monday end 1'), { target: { value: '02:00' } });
    expect(onValue.mock.lastCall?.[0].intervals.mon).toEqual([{ from: '22:00', to: '02:00' }]);
    expect(screen.getByText('Ends the next day at 02:00.')).toBeInTheDocument();
    expect(screen.getByLabelText('Monday end 1')).toHaveAccessibleDescription('Ends the next day at 02:00.');
  });

  it('adds a range and focuses it, then removes it and focuses the neighbour', async () => {
    const onValue = vi.fn<(v: BusinessHoursValue) => void>();
    const { container } = renderWithProviders(<Harness onValue={onValue} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add range for Monday' }));
    expect(onValue.mock.lastCall?.[0].intervals.mon).toEqual([
      { from: '09:00', to: '17:00' },
      { from: '17:00', to: '23:00' },
    ]);
    expect(screen.getByLabelText('Monday start 2')).toHaveFocus();
    expect(live(container)).toHaveTextContent('Range 2 added to Monday.');

    await userEvent.click(screen.getByRole('button', { name: 'Remove Monday range 2' }));
    expect(onValue.mock.lastCall?.[0].intervals.mon).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove Monday range 1' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Monday range 1' }));
    expect(onValue.mock.lastCall?.[0].intervals.mon).toEqual([]);
    expect(screen.getByRole('switch', { name: 'Monday open' })).toHaveFocus();
    expect(live(container)).toHaveTextContent('Last range removed. Monday is closed.');
  });

  it('sets a day to 24 hours', async () => {
    const onValue = vi.fn<(v: BusinessHoursValue) => void>();
    renderWithProviders(<Harness onValue={onValue} />);
    await userEvent.click(screen.getByRole('button', { name: 'Tuesday 24 hours' }));
    expect(onValue.mock.lastCall?.[0].intervals.tue).toEqual([{ from: '00:00', to: '24:00' }]);
    expect(screen.getByLabelText('Tuesday end 1')).toHaveValue('00:00');
    expect(screen.getAllByText('Open all day.')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Tuesday 24 hours' })).toBeDisabled();
  });

  it('copies a day to all the others', async () => {
    const onValue = vi.fn<(v: BusinessHoursValue) => void>();
    const { container } = renderWithProviders(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('Monday end 1'), { target: { value: '12:30' } });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to all weekdays from Monday' }));
    const { intervals } = onValue.mock.lastCall?.[0] ?? defaultBusinessHours();
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const) expect(intervals[day]).toEqual([{ from: '09:00', to: '12:30' }]);
    expect(live(container)).toHaveTextContent('Monday hours copied to all other days.');
  });

  it('picks a time zone', async () => {
    const onValue = vi.fn<(v: BusinessHoursValue) => void>();
    renderWithProviders(<Harness onValue={onValue} />);
    const input = screen.getByRole('combobox', { name: /^Time zone/ });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'Asia/Tokyo');
    await userEvent.click(await screen.findByRole('option', { name: 'Asia/Tokyo' }));
    expect(onValue.mock.lastCall?.[0].timezone).toBe('Asia/Tokyo');
  });

  it('adds holidays sorted, ignores duplicates, and removes them by name', async () => {
    const onValue = vi.fn<(v: BusinessHoursValue) => void>();
    const { container } = renderWithProviders(<Harness onValue={onValue} />);
    const date = screen.getByLabelText('Holiday date');
    fireEvent.change(date, { target: { value: '2026-12-25' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add holiday' }));
    fireEvent.change(date, { target: { value: '2026-01-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add holiday' }));
    expect(onValue.mock.lastCall?.[0].holidays).toEqual(['2026-01-01', '2026-12-25']);
    expect(live(container)).toHaveTextContent('Holiday 2026-01-01 added. 2 holidays in the list.');
    expect(date).toHaveFocus();

    fireEvent.change(date, { target: { value: '2026-12-25' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add holiday' }));
    expect(onValue.mock.lastCall?.[0].holidays).toEqual(['2026-01-01', '2026-12-25']);
    expect(date).toHaveAccessibleDescription('2026-12-25 is already in the list.');
    expect(live(container)).toHaveTextContent('2026-12-25 is already in the list.');

    await userEvent.click(screen.getByRole('button', { name: 'Remove holiday 2026-12-25' }));
    expect(onValue.mock.lastCall?.[0].holidays).toEqual(['2026-01-01']);
    expect(screen.queryByRole('button', { name: 'Remove holiday 2026-12-25' })).not.toBeInTheDocument();
  });

  it('asks for a date when none is chosen', async () => {
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add holiday' }));
    expect(screen.getByLabelText('Holiday date')).toHaveAccessibleDescription('Choose a date to add.');
    expect(screen.getByLabelText('Holiday date')).toBeInvalid();
  });

  it('shows errors on their fields and is free of axe violations', async () => {
    const initial = toBusinessHoursValue({ timezone: 'Europe/Berlin', intervals: { mon: [{ from: '', to: '17:00' }, { from: '09:00', to: '10:00' }] } });
    const { container } = renderWithProviders(
      <Harness
        initial={initial}
        errors={{
          timezone: 'Choose a time zone from the list.',
          'intervals.mon.0.from': 'Enter a start time.',
          'intervals.mon': 'Monday: ranges overlap. Merge them or move one.',
        }}
      />,
    );
    expect(screen.getByLabelText('Monday start 1')).toBeInvalid();
    expect(screen.getByLabelText('Monday start 1')).toHaveAccessibleDescription('Enter a start time.');
    expect(screen.getByRole('switch', { name: 'Monday open' })).toHaveAccessibleDescription('Monday: ranges overlap. Merge them or move one.');
    expect(screen.getByRole('combobox', { name: /^Time zone/ })).toHaveAccessibleDescription('Choose a time zone from the list.');
    await expectNoAxeViolations(container);
  });

  it('disables every control', () => {
    renderWithProviders(<Harness disabled />);
    expect(screen.getByRole('combobox', { name: /^Time zone/ })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Monday open' })).toBeDisabled();
    expect(screen.getByLabelText('Monday start 1')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add range for Monday' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add holiday' })).toBeDisabled();
  });
});

describe('business hours model', () => {
  it('accepts the default schedule', () => {
    expect(validateBusinessHours(defaultBusinessHours('Europe/Berlin'))).toEqual({});
  });

  it('flags a bad zone, no open day, empty and equal times, and overlaps', () => {
    const closed = toBusinessHoursValue({ timezone: 'Mars/Base', intervals: {} });
    expect(validateBusinessHours(closed)).toEqual({
      timezone: 'Choose a time zone from the list.',
      intervals: 'Open at least one day.',
    });

    const bad = toBusinessHoursValue({
      timezone: 'UTC',
      intervals: {
        mon: [{ from: '', to: '17:00' }],
        tue: [{ from: '09:00', to: '' }],
        wed: [{ from: '09:00', to: '09:00' }],
        thu: [
          { from: '09:00', to: '12:00' },
          { from: '11:00', to: '13:00' },
        ],
        fri: [
          { from: '09:00', to: '12:00' },
          { from: '12:00', to: '17:00' },
        ],
      },
    });
    const errors = validateBusinessHours(bad);
    expect(errors['intervals.mon.0.from']).toBe('Enter a start time.');
    expect(errors['intervals.tue.0.to']).toBe('Enter an end time.');
    expect(errors['intervals.wed.0']).toMatch(/start and end are the same/);
    expect(errors['intervals.thu']).toMatch(/overlap/);
    expect(errors['intervals.fri']).toBeUndefined();
  });

  it('allows 00:00 to 24:00 and flags a range from the night before that reaches into the next morning', () => {
    const allDay = toBusinessHoursValue({ timezone: 'UTC', intervals: { mon: [{ from: '00:00', to: '24:00' }], tue: [{ from: '00:00', to: '00:00' }] } });
    expect(validateBusinessHours(allDay)).toEqual({});

    const clash = toBusinessHoursValue({
      timezone: 'UTC',
      intervals: { mon: [{ from: '22:00', to: '02:00' }], tue: [{ from: '01:00', to: '05:00' }] },
    });
    expect(validateBusinessHours(clash)['intervals.tue']).toMatch(/starts before/);

    const fine = toBusinessHoursValue({
      timezone: 'UTC',
      intervals: { mon: [{ from: '22:00', to: '02:00' }], tue: [{ from: '02:00', to: '05:00' }] },
    });
    expect(validateBusinessHours(fine)).toEqual({});
  });

  it('flags an invalid holiday date', () => {
    const value = { ...defaultBusinessHours('UTC'), holidays: ['2026-02-30'] };
    expect(validateBusinessHours(value)['holidays.0']).toMatch(/not a valid date/);
  });

  it('round-trips the API shape, sending only open days', () => {
    const value = toBusinessHoursValue({ timezone: 'UTC', intervals: { mon: [{ from: '08:00', to: '16:00' }] }, holidays: ['2026-12-25', '2026-01-01', '2026-01-01'] });
    expect(value.intervals.tue).toEqual([]);
    expect(value.holidays).toEqual(['2026-01-01', '2026-12-25']);
    expect(toBusinessHoursInput(value)).toEqual({
      timezone: 'UTC',
      intervals: { mon: [{ from: '08:00', to: '16:00' }] },
      holidays: ['2026-01-01', '2026-12-25'],
    });
  });
});
