import type { Meta, StoryObj } from '@storybook/react'
import { Icon } from '../src/renderer/src/components/Icon'

const meta: Meta<typeof Icon> = {
  title: 'Components/Icon',
  component: Icon,
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof Icon>

export const Default: Story = {
  args: { name: 'terminal', size: 14 },
}

export const Large: Story = {
  args: { name: 'gear', size: 24 },
}
