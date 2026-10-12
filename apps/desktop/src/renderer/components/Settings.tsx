// The settings sheet, opened from the app menu or Cmd+,. Every change applies
// and saves at once, so there is no Save button.
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { CRATE_ORDERS } from '../../shared/protocol.js';
import { formatClock } from '../lanes.js';
import { useSettings } from '../hooks/useSettings.js';
import {
  CRATE_ORDER_LABELS,
  DEFAULTS,
  JOIN_LEAD,
  JOIN_LEAD_TIGHT,
  MOTIONS,
  clampLead,
  type Motion,
} from '../settings.js';

const MOTION_LABELS: Record<Motion, string> = { system: 'Match macOS', reduce: 'Reduce' };

// The preview's outgoing record spans the slider's whole range; the next record gets the rest.
const OUT_SHARE = 0.8;
const OUT_BARS = 56;
const IN_BARS = 14;

// A fixed, made-up level per bar so the picture reads as music without being any track.
const level = (i: number) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;

  return 0.35 + 0.65 * (x - Math.floor(x));
};

function Choice<T extends string>({
  name,
  label,
  options,
  labels,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option} className={option === value ? 'on' : undefined}>
          <input
            type="radio"
            name={name}
            value={option}
            checked={option === value}
            onChange={() => onChange(option)}
          />
          {labels[option]}
        </label>
      ))}
    </div>
  );
}

function JoinLead({ lead, onChange }: { lead: number; onChange: (lead: number) => void }) {
  // Where the join starts, as a share of the preview's outgoing record.
  const at = (JOIN_LEAD.max - lead) / JOIN_LEAD.max;

  return (
    <div className="jl" style={{ '--at': at, '--out': OUT_SHARE } as CSSProperties}>
      <div className="jl-bars" aria-hidden="true">
        <div className="jl-out">
          {Array.from({ length: OUT_BARS }, (_, i) => (
            <i
              key={i}
              className={(i + 0.5) / OUT_BARS >= at ? 'on' : undefined}
              style={{ height: `${level(i) * Math.min(1, (OUT_BARS - i) / 8) * 100}%` }}
            />
          ))}
        </div>
        <div className="jl-in">
          {Array.from({ length: IN_BARS }, (_, i) => (
            <i key={i} style={{ height: `${level(i + 99) * Math.min(1, (i + 1) / 6) * 100}%` }} />
          ))}
        </div>
        <span className="jl-cue" />
      </div>
      <div className="jl-ticks mono" aria-hidden="true">
        {[120, 90, 60, 30].map((s) => (
          <span
            key={s}
            style={{ left: `${((JOIN_LEAD.max - s) / JOIN_LEAD.max) * 100 * OUT_SHARE}%` }}
          >
            −{formatClock(s)}
          </span>
        ))}
        <span style={{ left: `${OUT_SHARE * 100}%` }}>next</span>
      </div>
      <input
        className="jl-range"
        type="range"
        dir="rtl"
        min={JOIN_LEAD.min}
        max={JOIN_LEAD.max}
        step={JOIN_LEAD.step}
        value={lead}
        aria-label="How long before the end Hear the join starts"
        aria-valuetext={`${lead} seconds before the end`}
        onChange={(e) => onChange(clampLead(Number(e.target.value)))}
      />
    </div>
  );
}

function Row({
  title,
  hint,
  value,
  children,
}: {
  title: string;
  hint: string;
  value?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-copy">
        <b>{title}</b>
        <p>{hint}</p>
      </div>
      {value}
      <div className="set-control">{children}</div>
    </div>
  );
}

export function Settings() {
  const { settings, update, open, setOpen } = useSettings();
  const dialog = useRef<HTMLDialogElement>(null);
  const lead = settings.joinLead;

  useEffect(() => {
    const node = dialog.current!;

    if (open && !node.open) {
      node.showModal();
      // The join is why the sheet usually opens, so it gets focus rather than Close.
      node.querySelector<HTMLInputElement>('.jl-range')?.focus();
    } else if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="settings"
      aria-labelledby="settings-title"
      onClose={() => setOpen(false)}
      // A click on the backdrop lands on the dialog itself.
      onClick={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <header>
        <h2 id="settings-title">Settings</h2>
        <button
          type="button"
          className="ib"
          aria-label="Close settings"
          onClick={() => setOpen(false)}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </header>

      <section aria-labelledby="set-listen">
        <h3 id="set-listen" className="set-head">
          Listen
        </h3>
        <Row
          title="Hear the join"
          hint="How far before the end of a track it starts, so you hear it run into the next."
          value={
            <output className="set-led" aria-hidden="true">
              {lead}
              <span>s</span>
            </output>
          }
        >
          <JoinLead lead={lead} onChange={(joinLead) => update({ joinLead })} />
          <div className="set-foot">
            <p className={lead < JOIN_LEAD_TIGHT ? 'tight' : undefined}>
              {lead < JOIN_LEAD_TIGHT
                ? `Under ${JOIN_LEAD_TIGHT} s, Music may not have time to blend the two.`
                : 'Drag left for a longer run-up.'}
            </p>
            {lead !== DEFAULTS.joinLead && (
              <button
                type="button"
                className="link"
                onClick={() => update({ joinLead: DEFAULTS.joinLead })}
              >
                Reset to {DEFAULTS.joinLead} s
              </button>
            )}
          </div>
        </Row>
      </section>

      <section aria-labelledby="set-crate">
        <h3 id="set-crate" className="set-head">
          Crate
        </h3>
        <Row title="Fill it with" hint="What the crate holds when you're not searching.">
          <Choice
            name="crate-order"
            label="Fill the crate with"
            options={CRATE_ORDERS}
            labels={CRATE_ORDER_LABELS}
            value={settings.crateOrder}
            onChange={(crateOrder) => update({ crateOrder })}
          />
        </Row>
      </section>

      <section aria-labelledby="set-motion">
        <h3 id="set-motion" className="set-head">
          Motion
        </h3>
        <Row title="Movement" hint="Reduce makes records snap into place instead of gliding.">
          <Choice
            name="motion"
            label="Movement"
            options={MOTIONS}
            labels={MOTION_LABELS}
            value={settings.motion}
            onChange={(motion) => update({ motion })}
          />
        </Row>
      </section>

      <footer className="mono">Changes save as you make them.</footer>
    </dialog>
  );
}
