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
  split: 'M2 2h12v12H2z M8 2v12'
}

type IconProps = {
  name: keyof typeof paths & string
  size?: number
  className?: string
}

export function Icon({ name, size = 14, className }: IconProps) {
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
      <path d={paths[name]} />
    </svg>
  )
}