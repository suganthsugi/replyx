import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { AddIcon, CloseIcon } from '../foundations/icons';
import { useAnnounce } from '../foundations/LiveRegion';

import {
  ALL_DAY_RANGE,
  DEFAULT_RANGE,
  MAX_HOLIDAYS,
  MAX_RANGES_PER_DAY,
  WEEKDAYS,
  addHoliday,
  browserTimeZone,
  copyDayToAll,
  isAllDay,
  rangeHint,
  removeHoliday,
  setDayRanges,
  timeZoneOptions,
  toInputTime,
  type BusinessHoursErrors,
  type BusinessHoursValue,
  type TimeRange,
  type Weekday,
} from './business-hours-model';

/**
 * The weekly schedule of a business-hours calendar (US12): a time zone, per weekday an Open switch
 * with one or more start/end ranges, and a sorted list of holiday dates. Controlled and
 * presentational; the page owns the schedule name, the Save / Cancel buttons and validation
 * (`validateBusinessHours`, whose result goes back in as `errors`, keyed like the API paths).
 *
 * Keyboard only: every range has labelled time inputs ("Monday start 1") and a Remove button, a row
 * can be copied to the other days or set to 24 hours, focus moves to a new range or a neighbour
 * after a removal, and each change is announced.
 */

export type { BusinessHoursErrors, BusinessHoursValue } from './business-hours-model';

export interface BusinessHoursEditorProps {
  value: BusinessHoursValue;
  onChange: (next: BusinessHoursValue) => void;
  disabled?: boolean;
  /** Messages by path, e.g. `{ 'intervals.mon.0.to': 'Enter an end time.' }`. */
  errors?: BusinessHoursErrors;
}

export function BusinessHoursEditor({ value, onChange, disabled = false, errors = {} }: BusinessHoursEditorProps) {
  const idBase = useId();
  const announce = useAnnounce();
  const rootRef = useRef<HTMLDivElement>(null);
  const focusRequest = useRef<string | null>(null);

  // Runs after every render: a handler sets the request and it is served once the target exists.
  useEffect(() => {
    const request = focusRequest.current;
    if (request === null) return;
    focusRequest.current = null;
    rootRef.current?.querySelector<HTMLElement>(`[data-focus="${request}"]:not(:disabled)`)?.focus();
  });

  const setRanges = (day: Weekday, ranges: TimeRange[]) => onChange({ ...value, intervals: setDayRanges(value.intervals, day, ranges) });

  return (
    <Box ref={rootRef} sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <TimeZoneSection
        value={value.timezone}
        onChange={(timezone) => onChange({ ...value, timezone })}
        disabled={disabled}
        error={errors['timezone']}
      />

      <Section title="Weekly hours" description="Turn a day on and set when it is open. A range that ends before it starts continues into the next day.">
        {errors['intervals'] !== undefined && (
          <Typography variant="body2" color="error">
            {errors['intervals']}
          </Typography>
        )}
        <Box component="ul" aria-label="Weekly hours" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {WEEKDAYS.map(({ key, label }) => (
            <DayRow
              key={key}
              idBase={idBase}
              day={key}
              label={label}
              ranges={value.intervals[key]}
              errors={errors}
              disabled={disabled}
              onRanges={(ranges) => setRanges(key, ranges)}
              onCopyToAll={() => {
                onChange({ ...value, intervals: copyDayToAll(value.intervals, key) });
                announce(`${label} hours copied to all other days.`);
              }}
              requestFocus={(target) => {
                focusRequest.current = target;
              }}
              announce={announce}
            />
          ))}
        </Box>
      </Section>

      <HolidaySection
        holidays={value.holidays}
        onChange={(holidays) => onChange({ ...value, holidays })}
        disabled={disabled}
        errors={errors}
        requestFocus={(target) => {
          focusRequest.current = target;
        }}
      />
    </Box>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Box component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Typography component="h3" variant="overline" color="text.secondary">
          {title}
        </Typography>
        {description !== undefined && (
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        )}
      </Box>
      {children}
    </Box>
  );
}

function TimeZoneSection({
  value,
  onChange,
  disabled,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  error: string | undefined;
}) {
  const own = useMemo(() => browserTimeZone(), []);
  const options = useMemo(() => {
    const all = timeZoneOptions();
    // A stored zone this browser does not list stays choosable (and visible) instead of vanishing.
    return value === '' || all.includes(value) ? all : [value, ...all];
  }, [value]);
  return (
    <Section title="Time zone">
      <Autocomplete<string, false, true, false>
        size="small"
        fullWidth
        disableClearable
        autoHighlight
        disabled={disabled}
        options={options}
        value={value}
        onChange={(_event, next) => onChange(next)}
        isOptionEqualToValue={(option, current) => option === current}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Time zone"
            required
            error={error !== undefined}
            helperText={error ?? `Hours are in this time zone. Your browser is set to ${own}.`}
          />
        )}
      />
    </Section>
  );
}

interface DayRowProps {
  idBase: string;
  day: Weekday;
  label: string;
  ranges: readonly TimeRange[];
  errors: BusinessHoursErrors;
  disabled: boolean;
  onRanges: (next: TimeRange[]) => void;
  onCopyToAll: () => void;
  requestFocus: (target: string) => void;
  announce: (text: string) => void;
}

function DayRow({ idBase, day, label, ranges, errors, disabled, onRanges, onCopyToAll, requestFocus, announce }: DayRowProps) {
  const open = ranges.length > 0;
  const dayError = errors[`intervals.${day}`];
  const errorId = `${idBase}-${day}-error`;

  const toggleOpen = (next: boolean) => {
    if (next) {
      onRanges([{ ...DEFAULT_RANGE }]);
      announce(`${label} open, ${DEFAULT_RANGE.from} to ${DEFAULT_RANGE.to}.`);
    } else {
      onRanges([]);
      announce(`${label} closed.`);
    }
  };

  const editRange = (index: number, part: keyof TimeRange, time: string) =>
    onRanges(ranges.map((range, i) => (i === index ? { ...range, [part]: time } : range)));

  const addRange = () => {
    if (ranges.length >= MAX_RANGES_PER_DAY) return;
    const last = ranges[ranges.length - 1];
    // Start the new range after the last one when that leaves room; otherwise the default hours.
    const from = last !== undefined && last.to !== '24:00' && last.to > last.from && last.to < '22:00' ? last.to : DEFAULT_RANGE.from;
    const to = from > DEFAULT_RANGE.from ? '23:00' : DEFAULT_RANGE.to;
    onRanges([...ranges, { from, to }]);
    requestFocus(`${day}:from:${ranges.length}`);
    announce(`Range ${ranges.length + 1} added to ${label}.`);
  };

  const removeRange = (index: number) => {
    const next = ranges.filter((_range, i) => i !== index);
    onRanges(next);
    if (next.length === 0) {
      requestFocus(`${day}:switch`);
      announce(`Last range removed. ${label} is closed.`);
    } else {
      requestFocus(`${day}:remove:${Math.min(index, next.length - 1)}`);
      announce(`Range ${index + 1} removed from ${label}. ${next.length} ${next.length === 1 ? 'range' : 'ranges'} left.`);
    }
  };

  const setAllDay = () => {
    onRanges([{ ...ALL_DAY_RANGE }]);
    announce(`${label} open 24 hours.`);
  };

  return (
    <Box
      component="li"
      data-day={day}
      sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 3, p: 3, border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper' }}
    >
      <Box sx={{ minWidth: '11rem', pt: 0.5 }}>
        <FormControlLabel
          label={label}
          disabled={disabled}
          control={
            <Switch
              checked={open}
              onChange={(event) => toggleOpen(event.target.checked)}
              slotProps={{
                input: {
                  'aria-label': `${label} open`,
                  'aria-describedby': dayError === undefined ? undefined : errorId,
                  // `data-*` is valid on an input, but the slot's type only lists known attributes.
                  ...({ 'data-focus': `${day}:switch` } as object),
                },
              }}
            />
          }
        />
      </Box>

      <Box sx={{ flex: 1, minWidth: '16rem', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {!open && (
          <Typography variant="body2" color="text.secondary" sx={{ pt: 1 }}>
            Closed
          </Typography>
        )}
        {ranges.map((range, index) => {
          const path = `intervals.${day}.${index}`;
          const hint = rangeHint(range);
          const hintId = `${idBase}-${day}-${index}-hint`;
          const rangeError = errors[path];
          return (
            <Box key={index} data-range={`${day}:${index}`} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2 }}>
                <TimeField
                  label={`${label} start ${index + 1}`}
                  value={range.from}
                  onChange={(time) => editRange(index, 'from', time)}
                  disabled={disabled}
                  error={errors[`${path}.from`]}
                  focusKey={`${day}:from:${index}`}
                />
                <TimeField
                  label={`${label} end ${index + 1}`}
                  value={toInputTime(range.to)}
                  onChange={(time) => editRange(index, 'to', time)}
                  disabled={disabled}
                  error={errors[`${path}.to`] ?? rangeError}
                  describedBy={hint === undefined ? undefined : hintId}
                />
                <IconButton
                  size="small"
                  aria-label={`Remove ${label} range ${index + 1}`}
                  data-focus={`${day}:remove:${index}`}
                  disabled={disabled}
                  onClick={() => removeRange(index)}
                  sx={{ mt: 0.5 }}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Box>
              {hint !== undefined && (
                <Typography id={hintId} variant="caption" color="text.secondary">
                  {hint}
                </Typography>
              )}
            </Box>
          );
        })}
        {dayError !== undefined && (
          <Typography id={errorId} variant="body2" color="error">
            {dayError}
          </Typography>
        )}
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
        {open && (
          <>
            <Button
              size="small"
              startIcon={<AddIcon />}
              aria-label={`Add range for ${label}`}
              disabled={disabled || ranges.length >= MAX_RANGES_PER_DAY}
              onClick={addRange}
            >
              Add range
            </Button>
            <Button size="small" aria-label={`${label} 24 hours`} disabled={disabled || isAllDay(ranges)} onClick={setAllDay}>
              24 hours
            </Button>
          </>
        )}
        <Button size="small" aria-label={`Copy to all weekdays from ${label}`} disabled={disabled} onClick={onCopyToAll}>
          Copy to all weekdays
        </Button>
      </Box>
    </Box>
  );
}

function TimeField({
  label,
  value,
  onChange,
  disabled,
  error,
  focusKey,
  describedBy,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  error: string | undefined;
  focusKey?: string;
  describedBy?: string | undefined;
}) {
  return (
    <TextField
      type="time"
      label={label}
      size="small"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      error={error !== undefined}
      helperText={error}
      sx={{ width: '9.5rem' }}
      slotProps={{
        inputLabel: { shrink: true },
        htmlInput: {
          ...(focusKey === undefined ? {} : { 'data-focus': focusKey }),
          ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
        },
      }}
    />
  );
}

function HolidaySection({
  holidays,
  onChange,
  disabled,
  errors,
  requestFocus,
}: {
  holidays: readonly string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  errors: BusinessHoursErrors;
  requestFocus: (target: string) => void;
}) {
  const announce = useAnnounce();
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | undefined>(undefined);

  const add = () => {
    const result = addHoliday(holidays, draft);
    switch (result.outcome) {
      case 'invalid':
        setDraftError('Choose a date to add.');
        announce('Choose a date to add.');
        return;
      case 'duplicate':
        setDraftError(`${draft} is already in the list.`);
        announce(`${draft} is already in the list.`);
        return;
      case 'full':
        setDraftError(`A calendar can have up to ${MAX_HOLIDAYS} holidays.`);
        announce(`A calendar can have up to ${MAX_HOLIDAYS} holidays.`);
        return;
      case 'added':
        onChange(result.holidays);
        setDraft('');
        setDraftError(undefined);
        requestFocus('holiday-date');
        announce(`Holiday ${draft} added. ${result.holidays.length} ${result.holidays.length === 1 ? 'holiday' : 'holidays'} in the list.`);
    }
  };

  const remove = (date: string) => {
    const next = removeHoliday(holidays, date);
    onChange(next);
    requestFocus('holiday-date');
    announce(`Holiday ${date} removed. ${next.length} ${next.length === 1 ? 'holiday' : 'holidays'} left.`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Enter adds the date instead of submitting the page's form.
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  };

  return (
    <Section title="Holidays" description="Days the business is closed, whatever the weekly hours say.">
      {errors['holidays'] !== undefined && (
        <Typography variant="body2" color="error">
          {errors['holidays']}
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'flex-start' }}>
        <TextField
          type="date"
          label="Holiday date"
          size="small"
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setDraftError(undefined);
          }}
          onKeyDown={onKeyDown}
          error={draftError !== undefined}
          helperText={draftError}
          sx={{ width: '12rem' }}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'data-focus': 'holiday-date' } }}
        />
        <Button variant="outlined" size="small" startIcon={<AddIcon />} disabled={disabled} onClick={add} sx={{ mt: 0.5 }}>
          Add holiday
        </Button>
      </Box>
      {holidays.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No holidays added.
        </Typography>
      ) : (
        <Box component="ul" aria-label="Holidays" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
          {holidays.map((date, index) => {
            const error = errors[`holidays.${index}`];
            return (
              <Box component="li" key={date} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Chip
                  variant="outlined"
                  color={error === undefined ? 'default' : 'error'}
                  label={
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                      {date}
                      <IconButton size="small" aria-label={`Remove holiday ${date}`} disabled={disabled} onClick={() => remove(date)}>
                        <CloseIcon fontSize="inherit" />
                      </IconButton>
                    </Box>
                  }
                  sx={{ pr: 0 }}
                />
                {error !== undefined && (
                  <Typography variant="caption" color="error">
                    {error}
                  </Typography>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Section>
  );
}
