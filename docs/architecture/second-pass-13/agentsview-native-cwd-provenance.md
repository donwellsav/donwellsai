# AgentsView native cwd patch

- Upstream source: AgentsView annotated tag `v0.42.0` (`94b3676f3cfcb32d95ff07547db727e3c95564ba`), peeled commit `ff8fb4e84823b9583eba417afc243140caabdcb0`.
- Local patch: [`agentsview-0.42.0-native-cwd.patch`](./agentsview-0.42.0-native-cwd.patch), SHA-256 `746bb17b292554e9dafeadd58c8985afb22db6ca9a0c32ae56ba117d10eb91c7`.
- Patch behavior: reads Hermes `sessions.cwd`; reads Kimi `state.json` only when its ID matches the native session directory, retaining its version, ID and `cwd` (or legacy `workDir`); accepts an explicitly selected Kimi `wd_*` workspace root without scanning its parent; preserves native cwd and derives project attribution from it.
- Built binary: `/tmp/donwells-agentsview-0.42.0-native-cwd`, SHA-256 `1c9365fd70b3bca35ff1997dfb1fcebc06bb0804d95d9a6401af9583a53af05a`.
- Embedded identity: `agentsview v0.42.0-donwells-cwd3 (commit ff8fb4e+native-cwd3, built 2026-09-07T14:35:00Z)`.

Focused verification:

```sh
go test ./internal/parser -run 'TestKimiProvider(UsesCurrentStateCwdWhenWireHasNoConfigUpdate|CwdCapabilityAndParse)|Test(ParseHermesArchive|BuildHermesStateResult)' -count=1
```

Rebuild from the patched upstream checkout:

```sh
CGO_ENABLED=1 go build -tags fts5 \
  -ldflags='-X main.version=v0.42.0-donwells-cwd3 -X main.commit=ff8fb4e+native-cwd3 -X main.buildDate=2026-09-07T14:35:00Z' \
  -o /tmp/donwells-agentsview-0.42.0-native-cwd ./cmd/agentsview
```
