"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { layoutPresenceLights, type PresenceEntry, type PresenceTone } from "../lib/presence.mjs";
import { registerBackCloser } from "./backstack";

const STATUS_LABELS: Record<PresenceTone, string> = {
  office: "In office", online: "Home / online", site: "On site", off: "Offline", other: "Location not set",
};
const STATUS_ORDER: PresenceTone[] = ["office", "online", "site", "off", "other"];

function PresenceLights({ people, compact = false }: { people: PresenceEntry[]; compact?: boolean }) {
  const lights = useMemo(() => layoutPresenceLights(people), [people]);
  const active = people.filter(person => person.isIn).length;
  return (
    <svg className={compact ? "home-presence-lights is-compact" : "home-presence-lights"}
      viewBox="0 0 144 144" aria-hidden={compact || undefined} role={compact ? undefined : "img"}
      aria-label={compact ? undefined : `${active} active out of ${people.length} employees. One light per employee, three rows filled ray by ray.`}>
      {lights.map(light => <circle key={light.user.id} cx={light.x} cy={light.y} r={light.dotRadius}
        className={`home-presence-light is-${light.tone}`} data-employee-id={light.user.id}>
        {!compact && <title>{`${light.user.name}: ${STATUS_LABELS[light.tone]}`}</title>}
      </circle>)}
      <text x="72" y={compact ? "79" : "72"} textAnchor="middle" className="home-presence-total">{active}</text>
      {!compact && <text x="72" y="87" textAnchor="middle" className="home-presence-caption">active</text>}
    </svg>
  );
}

export function HomePresenceIndicator({ people, ready, onViewEmployees }: {
  people: PresenceEntry[]; ready: boolean; onViewEmployees: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const active = people.filter(person => person.isIn).length;
  const counts = Object.fromEntries(STATUS_ORDER.map(tone => [tone, people.filter(person => person.tone === tone).length]));
  const summary = ready
    ? `${active} active of ${people.length} employees: ${counts.office} in office, ${counts.online} home or online, ${counts.site} on site, ${counts.off} offline${counts.other ? `, ${counts.other} location not set` : ""}`
    : "Loading employee presence";

  useEffect(() => {
    if (!open) return;
    return registerBackCloser(() => dialogRef.current?.close());
  }, [open]);

  return <>
    <button type="button" className="home-presence-trigger" aria-label={`Show presence lights. ${summary}`}
      aria-haspopup="dialog" aria-controls={id} aria-expanded={open} title={summary}
      onClick={() => { dialogRef.current?.showModal(); setOpen(true); }}>
      {ready ? <PresenceLights people={people} compact /> : <span className="home-presence-loading" aria-hidden="true">.</span>}
    </button>
    <dialog ref={dialogRef} id={id} className="home-presence-dialog" aria-labelledby={`${id}-title`}
      onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}>
      <div className="home-presence-dialog-content">
        <div className="home-presence-heading">
          <div><h3 id={`${id}-title`}>Live Presence</h3><p>{ready ? `${people.length} employees � one light per employee` : "Loading employee presence."}</p></div>
          <button type="button" className="home-presence-close" aria-label="Close presence lights" onClick={() => dialogRef.current?.close()}><X size={18} /></button>
        </div>
        {ready && people.length > 0 ? <div className="home-presence-detail">
          <PresenceLights people={people} />
          <dl className="home-presence-legend" aria-live="polite" aria-atomic="true">
            {STATUS_ORDER.filter(tone => tone !== "other" || counts.other > 0).map(tone => <div key={tone}>
              <dt><i className={`home-presence-swatch is-${tone}`} aria-hidden="true" />{STATUS_LABELS[tone]}</dt><dd>{counts[tone]}</dd>
            </div>)}
          </dl>
        </div> : <p className="home-presence-empty">{ready ? "No enabled employees to show yet." : "Waiting for the employee roster and attendance data."}</p>}
        <div className="home-presence-footer"><span>Three rows � inner to outer � clockwise</span>
          <button type="button" onClick={() => { dialogRef.current?.close(); onViewEmployees(); }}>View employee list <ArrowRight size={15} /></button>
        </div>
      </div>
    </dialog>
  </>;
}
