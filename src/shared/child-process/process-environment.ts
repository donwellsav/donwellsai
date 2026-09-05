const PRIVATE_PROCESS_KEYS: Record<string, true> = {
  DONWELLS_DAEMON_TOKEN: true,
  ELECTRON_RUN_AS_NODE: true
}

/** Strip inherited app authority and the outer terminal integration before spawning. */
export function sanitizedProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  const outerProgram = source.TERM_PROGRAM?.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  const outerPrefix = outerProgram ? `${outerProgram}_` : undefined
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && PRIVATE_PROCESS_KEYS[key] !== true &&
      (!outerPrefix || !key.startsWith(outerPrefix))) clean[key] = value
  }
  for (const [key, value] of Object.entries(additions)) {
    if (value === undefined) delete clean[key]
    else clean[key] = value
  }
  return clean
}
