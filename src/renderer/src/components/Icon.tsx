// Minimal inline SVG icon set (no dependency); 16x16 viewBox.

const paths: Record<string, string> = {
  file: 'M8 1.5h4.5L15 4v10.5H8z M8 1.5V4h3',
  dir: 'M1.5 3.5h5l1.5 2h7v8h-13.5z',
  terminal: 'M2 4l4 4-4 4 M7 11.5h7',
  git: 'M5 3c0 1-.8 1.8-1.8 1.8S1.5 4 1.5 3s.7-1.8 1.7-1.8S5 2 5 3zM14.5 3c0 1-.8 1.8-1.8 1.8s-1.7-.8-1.7-1.8.7-1.8 1.7-1.8S14.5 2 14.5 3zM3.2 4.8V11c0 1.4 1.1 2.5 2.5 2.5h2M12.8 4.8V7c0 1-.8 1.8-1.8 1.8H8 M8 2v12',
  plus: 'M8 3v10 M3 8h10',
  x: 'M4 4l8 8 M12 4l-8 8',
  search: 'M7 2.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM10.5 10.5L14 14',
  refresh: 'M13.5 6A5.5 5.5 0 003 8 M2.5 10a5.5 5.5 0 0010.5-2 M2 3v3h3 M14 13v-3h-3',
  gear: 'M8 5.2A2.8 2.8 0 108 10.8 2.8 2.8 0 008 5.2zM8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M3.5 12.5l1.2-1.2M11.3 4.7l1.2-1.2',
  stop: 'M5 5h6v6H5z',
  play: 'M5 3l9 5-9 5z',
  split: 'M2 2h12v12H2z M8 2v12',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M8 5.7a2.3 2.3 0 100 4.6 2.3 2.3 0 000-4.6z',
  edit: 'M3 13h2.5L12 6.5 9.5 4 3 10.5V13z M8.7 4.8l2.5 2.5',
  // donwells status iconography
  activity: 'M2 8.5h3l2-5 3 9 2-4h2',
  check: 'M3 8.5l3.5 3.5L13 4.5',
  'check-circle': 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM5.5 8l1.8 1.8L11 6',
  up: 'M3 10.5l5-5 5 5',
  down: 'M3 5.5l5 5 5-5',
  columns: 'M2 3h5v10H2z M9 3h5v10H9z',
  question: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM6 6a2 2 0 113.4 1.4c-.6.6-1.4 1-1.4 1.9 M8 12h.01',
  clock: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5V8l2.5 1.5',
  panelLeft: 'M2 2.5h12v11H2z M6 2.5v11',
  panelRight: 'M2 2.5h12v11H2z M10 2.5v11',
  globe: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM1.5 8h13M8 1.5c-1.8 1.7-2.8 4-2.8 6.5S6.2 12.8 8 14.5c1.8-1.7 2.8-4 2.8-6.5S9.8 3.2 8 1.5z',
  robot: 'M5.5 6.5h5M5.5 9.5h5M6 2.5h4M8 2.5v2M4 4.5h8a2 2 0 012 2v5a2 2 0 01-2 2H4a2 2 0 01-2-2v-5a2 2 0 012-2z',
  bolt: 'M8.5 1.5L3 9h4l-1 6L12.5 6h-4l1-4.5z',
  mobile: 'M5 1.5h6a1 1 0 011 1v11a1 1 0 01-1 1H5a1 1 0 01-1-1v-11a1 1 0 011-1zM7 12h2',
  chevrons: 'M6 3.5L10.5 8 6 12.5',
  alert: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5V9 M8 11.5h.01'
}

type IconProps = {
  name: keyof typeof paths & string
  size?: number
  className?: string
}

export function Icon({ name, size = 14, className }: IconProps) {
  const d = paths[name] ?? ''
  const segs = d.split(' M')
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {segs.map((s, i) => <path key={i} d={i === 0 ? s : `M${s}`} />)}
    </svg>
  )
}