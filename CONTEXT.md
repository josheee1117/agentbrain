# agentbrain Domain Glossary

## Authority and storage

### Evidence Layer (L1)

The authoritative event history. L1 records observations, assertions, proposals, decisions about proposals, corrections, conflicts, lifecycle changes, imports and purge operations. L1 is authoritative about what was recorded and how it evolved; an assertion inside L1 is not automatically true.

**Alias:** 证据层（L1）.

### Memory Projection Layer (L2)

Deterministic read models derived from L1. L2 represents what the system currently considers active, disputed, superseded, archived or otherwise relevant. Human edits become new L1 events; they do not mutate L2 as a second truth source.

**Alias:** 记忆投影层（L2）.

### Operational Index Layer (L3)

Rebuildable retrieval state such as lexical indexes, embeddings, caches and index watermarks. L3 is never semantic or recovery authority.

**Alias:** 运行索引层（L3）.

### Durable Work Store

Persistent work intent and recovery state for captured intake, pending extraction, proposals, publication, retries, deadlines and purge progress. It is not semantic authority, but deleting it can lose accepted work and is therefore not equivalent to rebuilding L3.

### Canonical Owner

The one local agentbrain store authorized to own semantic state. Export, backup and optional Git history do not become competing canonical owners.

## Memory semantics

### Proposition

The canonical semantic statement derived from L1 evidence. A proposition has orthogonal facets for provenance, authority, subject, scope, temporal horizon, trigger, maturity, contestability, confidence, sensitivity, consumer hints and causal lineage.

### Descriptive Proposition

A proposition describing a project, system, external domain or past event.

### Normative Proposition

A proposition expressing a preference, constraint, obligation, recommendation or working principle. Being normative does not itself mean the proposition must always be injected.

### Meta-lifecycle Proposition

A proposition that changes another proposition's scope or lifecycle, such as correction, rescope, supersession, withdrawal, archive or reactivation.

### Proposal

A model- or Agent-generated proposition candidate that has not yet been accepted into the current memory read model. Proposal admission state is separate from the semantic state of accepted propositions.

### Decision View

User-readable L2 vocabulary for a selected course, its rationale, alternatives and applicability. The L2 contract decides its exact materialization; it is never a separate canonical ontology.

### Maxim View

User-readable L2 vocabulary for a reusable principle, constraint or heuristic. The L2 contract decides its exact materialization; it is never a separate canonical ontology.

### Preference View

User-readable L2 vocabulary for an explicit or carefully inferred tendency belonging to a Human or Agent subject. The L2 contract decides its exact materialization; it is never a separate canonical ontology.

### Knowledge Claim View

User-readable L2 vocabulary for a verifiable descriptive proposition. The L2 contract decides its exact materialization; it is neither a Wiki platform nor a separate canonical ontology.

### Corroboration Count

The number of distinct Sessions in which a proposition was actually used and not contradicted. It counts sessions, not retrievals: being surfaced by a search is not use, and one session cannot corroborate a proposition twice. The count measures usage maturity and may affect ranking among eligible memories; it does not change evidence authority, admission, modality or default injection eligibility.

### Unreconciled Proposition

A proposition whose relation to existing memory remains unresolved after the automatic decision chain. It is excluded from current conclusions until a Human resolves the relation, including explicitly confirming that nothing needs to be superseded; usage counts cannot resolve it.

### Pitfall

A normative proposition with a trigger: in a stated situation, do not do X, because Y. Pitfalls are rendered under the Maxim View, not as a fifth canonical kind. Unlike other Maxims, Pitfalls are pushed to the Agent proactively, because an Agent does not know to search for a pitfall before stepping into it.

**Alias:** 坑.

### Source Pointer

The default provenance record for evidence captured from a Session: the Pi session file path, the leaf entry id at capture time, and a one-line summary. Reconstructing how a decision was discussed means reading the transcript at that pointer on demand; agentbrain does not store the discussion text itself.

### Policy View

A stable L2 selection of normative propositions relevant to a particular consumer and scope.

### Context Brief

A small, stable, budgeted L2 composition used to start a session. It is not the entire Loadout or memory corpus.

### Procedure View

A read model of procedural experience: how a recurring class of work is normally performed. It does not imply an executable Workflow engine.

## Identity and access

### Human

The person whose local memory the system serves.

### Agent Definition

A stable Agent role and its default Loadout policy, such as development, review or research.

### Agent Execution

One concrete run of an Agent Definition.

### Project

A stable semantic boundary for engineering or knowledge work. A Project can relate to multiple Repositories.

### Repository

A code repository identity associated with a Project. Filesystem location alone does not grant Project identity.

### Session

One Pi conversation session. Session is a source and activation boundary, not a durable user identity.

### Ephemeral Session

A Session that leaves no durable record of its own. agentbrain can observe that a Session is ephemeral but cannot tell why: a delegated child execution and a deliberately unrecorded parent session are indistinguishable to it. Evidence captured from an Ephemeral Session is recorded and marked as such rather than discarded, and is excluded from projection by default.

### Work Unit

A bounded task or delegation. Work Unit does not imply a general Task management platform.

### Semantic Scope

What subject, project, session or work unit a proposition describes. Scope is not authorization.

### Capability

The explicit right of an Agent Execution to read or perform a bounded memory operation. Capability is not created by semantic similarity or Loadout attachment.

### Delegation Grant

A bounded memory authorization from a parent execution to a named child Work Unit, limited by the parent’s rights and revocable independently of memory content. Its concrete host integration remains a design candidate.

### Loadout

A persistent selection policy describing which memory views, profiles, budgets and external asset references an Agent Definition normally uses. Loadout neither grants capability nor means all attached content is injected.

### Session Activation

The subset of a Loadout enabled for one Session.

### Delegated Memory Slice

The bounded memory set or retrieval capability a parent Agent gives a child Agent for one Work Unit. Child Agents do not inherit the parent's full Loadout by default.

### Delegation Lineage

The recorded relation between a parent Agent Execution and the child execution it delegated to. Lineage is a required input to the delegation boundary rather than something reconstructed afterwards: when the delegating party does not supply it, the resulting evidence is marked degraded instead of being recorded as undelegated.

## Reading and lifecycle

### Memory Card

A structured retrieval result containing identity, readable view, content, scope, state, provenance, conflicts, score explanation, token estimate and degradation flags. The Pi adapter decides how a Memory Card is rendered.

### Archive

A reversible lifecycle state excluded from default reading while preserving content and lineage.

### Semantic Forgetting

A request or policy that prevents content from normal retrieval and injection while preserving only the audit information allowed by the privacy contract.

### Physical Purge

A controlled removal of records in a declared range and the content derived from them; all transitively dependent results lose eligibility, while unrelated evidence remains valid. Purge operates on ranges, never on a single proposition or event; it cannot promise deletion of copies outside agentbrain's control.

_Avoid_: Hard delete, wipe.

### Purge Range

The declared boundary of a Physical Purge together with the enumerated set of records that purge actually removed. The declaration states the intent and stays readable afterwards; the enumeration is what makes the purge verifiable when history is replayed. A range whose membership could be recomputed differently later is not a Purge Range.

## External asset boundaries

### Skill Reference

An opaque reference from a Loadout to an independently managed executable Skill asset. The memory kernel does not own Skill installation, versioning or execution.

### Workflow Reference

An opaque reference to an independently managed executable workflow. Procedure memory does not make agentbrain a Workflow engine.

### Vault Reference

A non-secret reference to an independent security domain. Secret plaintext is not ordinary memory content.
