import type { ReactNode } from "react";
const paths: Record<string, ReactNode> = {
  expand: <path d="m6 9 6 6 6-6" />, collapse: <path d="m6 15 6-6 6 6" />,
  open: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path d="m3 3 6 6m12-6-6 6M3 21l6-6m12 6-6-6"/></>,
  enter: <><path d="M5 4v9h13m-5-5 5 5-5 5"/><path d="M20 4v16"/></>,
  reference: <><path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0)"/></>,
  neighbors: <><circle cx="12" cy="12" r="3"/><circle cx="4" cy="4" r="2"/><circle cx="20" cy="4" r="2"/><circle cx="20" cy="20" r="2"/><path d="m6 6 4 4m4 0 4-4m-4 8 4 4"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  grip: <><path d="M8 5h.01M8 12h.01M8 19h.01M16 5h.01M16 12h.01M16 19h.01" strokeWidth="3"/></>,
  agent: <><rect x="4" y="6" width="16" height="14" rx="4"/><path d="M12 3v3M1 12h3m16 0h3M8 16h8"/><circle cx="8" cy="11" r="1"/><circle cx="16" cy="11" r="1"/></>,
  chat: <path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z"/>,
  done: <path d="m5 12 4 4L19 6"/>,
};
export function CardIcon({ name }: { name: string }) { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>; }
