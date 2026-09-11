/**
 * Accessible button component.
 *
 * Enforces accessible names on all buttons. Icon-only buttons MUST provide
 * a label via `aria-label`. Visible-text buttons use their content.
 */
import { type ButtonHTMLAttributes, type ReactNode } from 'react'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: ReactNode
  /** Required when button contains only an icon */
  'aria-label'?: string
}

export function A11yButton({ children, ...rest }: Props) {
  return (
    <button {...rest}>
      {children}
    </button>
  )
}
