import { writeFileSync } from 'node:fs'

if (process.env.SKILL_FIXTURE_MARKER) writeFileSync(process.env.SKILL_FIXTURE_MARKER, 'executed')
process.stdout.write('fixture script invoked explicitly\n')
