import { useId, type ReactNode } from 'react';

/**
 * Labelled form controls for the wizard.
 *
 * Every control here gets an accessible name from a real `<label>` and wires
 * its help text and error through `aria-describedby`, so §15's "every input has
 * an accessible name" and "errors are associated with the relevant field" hold
 * by construction rather than by remembering to do it six times.
 */

interface FieldShellProps {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: (ids: { controlId: string; describedBy: string | undefined }) => ReactNode;
}

function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const controlId = useId();
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="min-w-0">
      <label htmlFor={controlId} className="block text-xs font-medium text-ink-muted">
        {label}
      </label>
      {children({ controlId, describedBy: describedBy || undefined })}
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1 text-xs font-medium text-pa">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL_CLASS =
  'mt-1 w-full rounded-control border border-line-strong bg-canvas px-2 py-1.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink';

interface SelectFieldProps<T extends string | number> {
  readonly label: string;
  readonly value: T | null;
  readonly options: readonly { value: T; label: string }[];
  readonly onChange: (value: T | null) => void;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly disabled?: boolean;
  /** Numeric options round-trip through the DOM's string values. */
  readonly numeric?: boolean;
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  placeholder,
  hint,
  error,
  disabled,
  numeric,
}: SelectFieldProps<T>) {
  return (
    <FieldShell label={label} {...(hint ? { hint } : {})} {...(error ? { error } : {})}>
      {({ controlId, describedBy }) => (
        <select
          id={controlId}
          className={CONTROL_CLASS}
          disabled={disabled}
          value={value === null ? '' : String(value)}
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          {...(error ? { 'aria-invalid': true } : {})}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') {
              onChange(null);
              return;
            }
            onChange((numeric ? Number(raw) : raw) as T);
          }}
        >
          {placeholder === undefined ? null : <option value="">{placeholder}</option>}
          {options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}

interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string;
  readonly maxLength?: number;
  readonly type?: 'text' | 'date';
  readonly placeholder?: string;
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  maxLength,
  type = 'text',
  placeholder,
}: TextFieldProps) {
  return (
    <FieldShell label={label} {...(hint ? { hint } : {})} {...(error ? { error } : {})}>
      {({ controlId, describedBy }) => (
        <input
          id={controlId}
          type={type}
          className={CONTROL_CLASS}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          {...(error ? { 'aria-invalid': true } : {})}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldShell>
  );
}

interface RadioGroupProps<T extends string> {
  readonly legend: string;
  readonly value: T | null;
  readonly options: readonly { value: T; label: string; description?: string }[];
  readonly onChange: (value: T) => void;
  readonly hint?: string;
  readonly error?: string;
  readonly name: string;
}

/**
 * A radio group in a fieldset.
 *
 * Used where the choice is a *convention the user must confirm* — sign
 * direction, date format — rather than a value picked from a long list. A
 * fieldset with a legend makes the question itself part of each option's
 * accessible context, which a bare select cannot express.
 */
export function RadioGroup<T extends string>({
  legend,
  value,
  options,
  onChange,
  hint,
  error,
  name,
}: RadioGroupProps<T>) {
  const groupId = useId();
  const hintId = `${groupId}-hint`;
  const errorId = `${groupId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <fieldset {...(describedBy ? { 'aria-describedby': describedBy } : {})}>
      <legend className="text-xs font-medium text-ink-muted">{legend}</legend>
      <div className="mt-1.5 space-y-1.5">
        {options.map((option) => {
          const id = `${groupId}-${option.value}`;
          return (
            <div key={option.value} className="flex items-start gap-2">
              <input
                id={id}
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                className="mt-0.5 size-4 shrink-0 accent-ink"
              />
              <label htmlFor={id} className="min-w-0 text-sm text-ink">
                {option.label}
                {option.description ? (
                  <span className="block text-xs text-ink-muted">{option.description}</span>
                ) : null}
              </label>
            </div>
          );
        })}
      </div>
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1 text-xs font-medium text-pa">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
