# Task 03 — usable project engine choices

Implemented 2026-09-07. This card changes the product; it does not claim the later learned-memory integrations are finished.

In Settings → Agent sessions → Project tools → Document retrieval, choose **Automatic**, **Lexical**, or **Require hybrid**. Applying configuration stops this project's services and preserves the previous configuration. Lexical mode skips model admission/loading while retaining model paths for a later switch. Required hybrid reports missing models or unavailable embeddings instead of returning lexical results. Automatic keeps the existing explicit fallback behavior. Native-agent query results include requested and actual mode.

The generated native-agent MCP connection now provides `project_engines`: canonical facts, installed document/code engines, service ownership and setup instructions. Reading this inventory does not start optional services. The connection remains pinned to its registered project/checkout. It does not imply that another CLI's private conversation is shared.

A real app configuration attempt also exposed `/var` versus `/private/var` directory aliases. ProjectDoctor now canonicalizes its configuration directory before bounded file operations. The file confinement checks remain intact; a regression covers initial save, revision-checked update and backup through a symlinked app-data root.

## Engine matrix and decisions

| Role | Recommended implementation | Credible alternative and disposition |
|---|---|---|
| Durable facts, corrections and decisions | Existing SQLite/FTS5 authority with stable IDs, revisions, provenance and explicit corrections | Engram is a strong MIT agent-agnostic SQLite/MCP alternative. Replacing the existing store would require preserving these contracts and migrating IDs/history. No new-head parity/quality benchmark was performed, so this is a contract-based retention decision, not a claim that current Engram failed. |
| Source documents | Existing QMD 2.8.3 chunking/model layer plus LanceDB 0.38.0 FTS/vector/reranking pipeline; explicit lexical/automatic/required-hybrid selection added here | QMD's standalone search and Qdrant remain Task11 comparisons. Qdrant adds a service to own; no measured local-corpus gain justifies that replacement here. Historical 4B retrieval results are historical evidence, not a new benchmark. |
| Checkout code relationships | codebase-memory-mcp 0.10.8, canonical shared cache and separate checkout sessions from Task04 | A temporal-memory graph is not a substitute for source-call relationships. Additional navigation belongs to Task12. |
| Learned recall and reflection | Hindsight as a derived, project-bank-scoped service in Task23 | Canonical facts remain SQLite. Hindsight needs a configured model/provider and database/service owner; retain/recall/reflect are not direct replacements for revision-checked edits. memU is not admitted: this inspection did not resolve the licensing of the selected repository contents. |
| Temporal relationships | Graphiti projection of attributed canonical revisions in Task23, backend selected by a working deployment | Upstream now deprecates Kuzu. Ladybug is a maintained MIT candidate to investigate, but a compatible Graphiti driver is not established by its repository description. FalkorDB's server LICENSE is SSPL, despite Graphiti's Apache license; it is not admitted by association. Qualify Neo4j/Ladybug/other backend terms and behavior before selecting. |

Hindsight and Graphiti remain required Task23 work, including resumable projection, deletion/supersession handling, freshness and usable app/agent operations. This card does not expose nonfunctional toggles for them.

## Fresh source inspection

Repository snapshots were read on 2026-09-07. Actual admitted package versions remain pinned separately from upstream research heads. Raw research is in `research/tool-trials/second-pass-engines` beside this checkout.

| Repository | Inspected revision | License finding |
|---|---|---|
| [Engram](https://github.com/Gentleman-Programming/engram/tree/f8c4cdf75f827361f7e80033ce9f997284bc205d) | f8c4cdf75f827361f7e80033ce9f997284bc205d | MIT |
| [QMD](https://github.com/tobi/qmd/tree/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9) | dbfd0b4736aeaf761d1a16ca8e424f071df8feb9 | MIT |
| [LanceDB](https://github.com/lancedb/lancedb/tree/0111a72dc3ad7eebc52d197bb5447e26ce02df43) | 0111a72dc3ad7eebc52d197bb5447e26ce02df43 | Apache-2.0 |
| [Hindsight](https://github.com/vectorize-io/hindsight/tree/83ef402e85372875f11a94652e1395a50c743060) | 83ef402e85372875f11a94652e1395a50c743060 | MIT |
| [Graphiti](https://github.com/getzep/graphiti/tree/b943c9e8486cdc7fe6cb2f4cfe151ae53f0a884d) | b943c9e8486cdc7fe6cb2f4cfe151ae53f0a884d | Apache-2.0; graph servers need separate admission |
| [Ladybug](https://github.com/ladybugdb/ladybug/tree/3517aaf98b93c51766ae930977f7dc86a324f4ca) | 3517aaf98b93c51766ae930977f7dc86a324f4ca | MIT |
| [Qdrant](https://github.com/qdrant/qdrant/tree/6ab21cac18ebb6f4ae29102c7f8f5cc11affd5de) | 6ab21cac18ebb6f4ae29102c7f8f5cc11affd5de | Apache-2.0 |
| [memU](https://github.com/NevaMind-AI/memU/tree/385bdb30cda7f5265368934b8008ce2b73283283) | 385bdb30cda7f5265368934b8008ce2b73283283 | Unresolved; not admitted |
| [FalkorDB](https://github.com/FalkorDB/FalkorDB/blob/393302586164e83bb6f396c7eb6a2986083f53bf/LICENSE) | 393302586164e83bb6f396c7eb6a2986083f53bf | Server SSPL |

## Recommendations for browser/control cards

- [Playwright MCP](https://github.com/microsoft/playwright-mcp/tree/8a13ef8e9f7385a0f89477922127f31cbfde9761) (Apache-2.0): retain as Task15's initial candidate for structured browser inspection and testing. Its README documents isolated profiles and explicitly says origin filters are not a security boundary. App-owned project contexts and target validation remain necessary.
- [PinchTab](https://github.com/pinchtab/pinchtab/tree/ef903395ca8d951112ae35aae9b00166cdae17c9) (MIT): compare for persistent profiles and multiple browser instances. Its own README describes API/MCP/dashboard as privileged operator surfaces; replacing Playwright requires project ownership and equivalent inspection/results, not merely a smaller binary.
- [Cua](https://github.com/trycua/cua/tree/e926a34a9ac5283f17c414f17c4992e0a09d106e) (README identifies MIT, LICENSE.md): investigate the current native background driver for Task16 and Lume for Task24. Background support varies by platform/window; source claims are not proof that every application can accept background input. Preserve the existing explicit target and desktop lease boundaries. Actual selected driver files/transitive terms are rechecked on admission.

## Verification and limits

- Focused parser/MCP/ProjectDoctor tests cover strict mode values, pinned inventory requests, no implicit starts and symlinked configuration save/update.
- `tests/project-documents.test.ts`, test “honors lexical selection without reading models and refuses lexical fallback when hybrid is required”, runs against actual admitted QMD/LanceDB packages. It supplies invalid model bytes to lexical mode, indexes/searches, verifies missing-model hybrid rejection, verifies an unembedded required-hybrid index cannot silently return lexical results, and reopens the retained lexical index.
- [Live app receipt](live-engines.json): actual development Electron window, UI configuration, exact app-generated OMP stdio MCP command, project document indexing/query/source read, engine disable, durable-memory search and continued input in the same terminal session. Owned app/daemon cleanup succeeded.
- This live flow qualifies the generated native-agent tool connection, not a model-generated OMP turn or fresh hybrid relevance benchmark. No provider request or user-app replacement was made. Task11 owns retrieval quality improvements; Task23 owns learned/temporal integration.
