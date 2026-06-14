import React from "react";

// One icon set, uniform 1.75 stroke, sized to neighbouring text via `size`.
type P = { size?: number; className?: string };
const svg = (path: React.ReactNode) => ({ size = 16, className = "" }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{path}</svg>
);

export const Shield = svg(<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />);
export const Bolt = svg(<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />);
export const Plus = svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const Trash = svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></>);
export const Refresh = svg(<><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>);
export const Check = svg(<path d="M20 6L9 17l-5-5" />);
export const Alert = svg(<><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z" /></>);
export const TrendDown = svg(<><path d="M3 7l6 6 4-4 8 8" /><path d="M21 17v-4h-4" /></>);
export const Lock = svg(<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 1 1 8 0v4" /></>);
export const Layers = svg(<><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></>);
export const Copy = svg(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>);

export const Spinner = ({ size = 16, className = "" }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.7s" repeatCount="indefinite" />
    </path>
  </svg>
);
