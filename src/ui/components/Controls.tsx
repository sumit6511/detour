import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

export interface Choice<T extends string | number> {
  value: T;
  label: ReactNode;
  note?: ReactNode;
  disabled?: boolean;
}

/** A row of mutually exclusive options with a sliding highlight. Real radio inputs underneath. */
export function Segmented<T extends string | number>({
  name,
  value,
  choices,
  onChange,
  label,
}: {
  name: string;
  value: T;
  choices: Choice<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {choices.map((choice) => {
        const checked = choice.value === value;
        return (
          <label key={String(choice.value)} className={checked ? "is-checked" : undefined}>
            <input
              type="radio"
              name={name}
              id={`${name}-${choice.value}`}
              checked={checked}
              disabled={choice.disabled}
              onChange={() => onChange(choice.value)}
            />
            {checked ? (
              <motion.span
                layoutId={`seg-${name}`}
                className="segmented__thumb"
                transition={{ type: "spring", stiffness: 520, damping: 38 }}
              />
            ) : null}
            <span className="segmented__label">
              {choice.label}
              {choice.note ? <small>{choice.note}</small> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function Switch({
  id,
  checked,
  onChange,
  label,
  note,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  note?: string;
}) {
  return (
    <label className="switch-row" htmlFor={id}>
      <span>
        <span className="switch-row__label">{label}</span>
        {note ? <span className="switch-row__note">{note}</span> : null}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

/** A number that rolls to its new value instead of snapping. */
export function Ticker({ value, className }: { value: number | string; className?: string }) {
  return (
    <span className={`ticker ${className ?? ""}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: "-70%", opacity: 0 }}
          animate={{ y: "0%", opacity: 1 }}
          exit={{ y: "70%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 480, damping: 34 }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
