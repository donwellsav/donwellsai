import { expect, it } from 'vitest'
import { isolatedProviderEnvironment, sanitizedTemplateEnvironment } from './process-environment'

it('keeps template additions within the isolated allowlist and below trusted overlays', () => {
  const environment = isolatedProviderEnvironment({
    isolationRoot: '/private/isolated',
    inherited: { LANG: 'en', HOME: '/parent' },
    templateEnvironment: { LANG: 'fr', HOME: '/template', XDG_CONFIG_HOME: '/template/config', HERMES_HOME: '/template/hermes', OPENAI_API_KEY: 'template', UNLISTED_TOKEN: 'template', DONWELLS_DAEMON_TOKEN: 'template' },
    driverEnvironment: { HERMES_HOME: '/private/isolated/hermes' },
    credentialEnvironment: { OPENAI_API_KEY: 'broker' }
  })
  expect(environment.LANG).toBe('fr')
  expect(environment.HOME).toBe('/private/isolated')
  expect(environment.XDG_CONFIG_HOME).toBe('/private/isolated/config')
  expect(environment.HERMES_HOME).toBe('/private/isolated/hermes')
  expect(environment.OPENAI_API_KEY).toBe('broker')
  expect(environment).not.toHaveProperty('UNLISTED_TOKEN')
  expect(environment).not.toHaveProperty('DONWELLS_DAEMON_TOKEN')
})

it('does not supply credentials in none mode or template values when absent', () => {
  const base = { isolationRoot: '/private/isolated', inherited: { LANG: 'en' } }
  const without = isolatedProviderEnvironment(base)
  expect(without.LANG).toBe('en')
  expect(without).not.toHaveProperty('OPENAI_API_KEY')
  const none = isolatedProviderEnvironment({ ...base, templateEnvironment: { OPENAI_API_KEY: 'template', UNLISTED_TOKEN: 'template', HOME: '/template' } })
  expect(none).toEqual(without)
})

it('removes private and hook keys case-insensitively from external template additions', () => {
  expect(sanitizedTemplateEnvironment({ TEMPLATE_MARKER: 'yes', donwells_daemon_token: 'private', ELECTRON_RUN_AS_NODE: '1', Donwells_Agent_Hook_Socket: 'wrong' })).toEqual({ TEMPLATE_MARKER: 'yes' })
})
