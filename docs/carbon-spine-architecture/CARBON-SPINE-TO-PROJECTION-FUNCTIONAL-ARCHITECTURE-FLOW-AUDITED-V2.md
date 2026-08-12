# Carbon Spine-to-Projection Functional Architecture Handoff

**Status:** implementation-oriented synthesis of the current Carbon/Marrow architecture discussions and KB decisions; **audited 2026-08-12 against the August 10 canonical master and August 11 final owner clarification, with a second end-to-end flow-completeness audit**  
**Purpose:** cold-start handoff for an implementation agent with zero prior context  
**Target:** a functional vertical slice that can start from durable ECS data and end with a manifested Unity runtime representation, while preserving the architecture's authority and reconstruction rules

---

## 0. Executive Summary

Carbon is being refactored around a **data-first, ECS-backed durable model**. The old managed `Node` tree is no longer the durable structure. Instead:

- a durable structural occurrence is a **Bone**;
- each durable Bone is represented by an ECS entity carrying Carbon structural components;
- the logical hierarchy formed by those Bones is called the **Spine**;
- the Spine is not a second database and does not require one C# object per Bone;
- canonical parentage is durable; child relationships are derived/rebuildable acceleration data;
- the **Coordinator** is the single normal structural mutation path for Add / Move / Delete;
- the **Watcher** observes settled durable truth and localizes what changed;
- the **Orchestrator** composes current truth, scope/demand, and Reconciler interest into complete desired populations;
- **Reconcilers** converge transient runtime Actual state toward those Desired populations;
- **Representation Markers** declare durable projection intent for one concern;
- **Component Manifests** let a Reconciler deterministically discover and pair Unity presenters inside composite delivered assets;
- presenters bind semantically to a Bone's **BUID**, not to a managed Bone object and not durably to a Unity `Entity` handle;
- Hydrate copies durable ECS state into runtime-only/engine-facing state when needed;
- Dehydrate copies restoration-relevant runtime-owned outcomes back into durable ECS data when needed;
- **authoring/template compilation and runtime clone/materialization are upstream of Coordinator**: they determine what durable multi-Bone structure/data should be created, while Coordinator only validates/commits generic structure;
- **active Context Scope runtime instances are transient**: a scope runtime host creates/rebuilds scoped systems and scratch memory when host/residency policy activates a scope, and disposes them only after safe retirement;
- durable BUID references remain distinct from contextual `SystemHandle<T>` relationships and from ephemeral runtime pointers;
- persisted schema/type identity and migration are validated before old/unknown data is published as coherent current truth;
- all runtime indexes, binding tables, Reconciler inventories, pending operations, and Context-Scope-local caches are disposable and must be rebuildable from durable truth.

The core flow is:

```text
AUTHORING / REUSABLE SOURCE
Prefab / Scene / tool data
        ↓ validate / compile
durable template/source data + Barcode markers + manifest pairing metadata
        ↓

NORMAL LIVE CREATION                         NORMAL LIVE STRUCTURAL CHANGE
domain creation/emission intent              Move / Delete / explicit Add intent
        ↓                                              ↓
creation / clone materialization               Coordinator request
(detached clone, fresh BUIDs,                          │
 BaseId provenance, ref remap)                         │
        ↓                                              │
generic Add/payload proposal ──────────────────────────┘
                             ↓
                  Coordinator validate/collapse/commit

BOOTSTRAP / LOAD / IMPORT
validated privileged integration
        ↓
schema migrate / validate durable records
        └──────────────────────┬────────────────────────────┘
                               ↓
                    integrated durable ECS state
                    + synchronized Spine indexes
                               ↓
                     coherent publication
                               ↓
                      settled Spine/ECS truth
                               ↓
                            Watcher
                   localization / pruning hints
                               ↓

Driver / observer demand ──→ Residency Solver ──→ eligible population
                                                     ↓
                                      Context Scope runtime host
                              create/rebuild/retire transient scope state
                                                     +
                                      current Spine/ECS durable truth
                                                     ↓
                                      concern Filter / Orchestrator
                                                     ↓
                                      exact complete Desired
                                                     ↓
                                               Reconciler
                                                     ↓
                              Warehouse lease / delivery / adoption
                                                     ↓
                                      manifest → pairing → Bind
                                                     ↓
                                      Hydrate → link/stitch → Ready
                                                     ↓
                                           Unity projection

RUNTIME FEEDBACK
ECS/domain writes ───────────────→ payload write or Coordinator structural intent
Unity/runtime structural facts ─→ domain interpretation ─→ Coordinator intent
Unity-owned durable outcomes ───→ dirty participant ─→ sanctioned writeback
```

Watcher output is an accelerator, not a required event stream: initial/restarted consumers baseline from current coherent truth, and demand/provider changes may force Desired rederivation without a new durable revision.

The important inversion from the previous architecture is:

```text
OLD
"spawn this object now and manually register it everywhere"

NEW
"add/move/change this durable thing here"
        ↓
all contextual/runtime consequences are derived downstream
```

This makes runtime realization indirect, batched, reconstructible, and concern-local.

---

## 0.1 Post-compilation audit corrections

This revision includes a deliberate conformance pass over the first compiled handoff. The following corrections are important:

- **Barcode is the canonical reusable delivery-content lookup identity.** Do not introduce `DeliveryKey` or `PackageId` as a competing architectural name. A Representation Marker carries/resolves a Barcode.
- **BaseId is immediate-source/provenance BUID.** It is not generically an asset-local presenter slot ID. Current `CarbonBehaviour.AssetId` is useful authoring evidence, but exact stable presenter-to-durable-part pairing remains an implementation contract.
- **Actual is not Ready.** A Reconciler occurrence becomes Actual as soon as the Reconciler materially acquires/instantiates/adopts it; binding, Hydrate, readiness, and activation may follow afterward.
- **Generation stamps are rebuildable acceleration metadata, not authoritative meaning.** Durable state must remain correct if they are regenerated.
- **Drivers and the Residency Solver are explicit in the manifestation timeline.** For current Marrow, Chunk is the default practical entity residency unit, but that rule is Marrow-specific and must not be hard-coded into generic Carbon.
- **World/Chunk are established natural Context Scope examples; Region is not automatically a Context Scope merely because it exists in the hierarchy.** Application/game composition decides which scope kinds install scoped systems.
- **Cross-coherence persistence is not one forced global revision.** A general save may bundle independently coherent scope snapshots.
- **The first-slice AssetId/BaseId pairing shortcut is constrained.** It is acceptable for a direct authored-template clone proof, but clone-of-clone and general composite authoring require a stable mapping contract rather than pretending BaseId is a universal slot ID.
- **`Unity.Entities.World` and a durable Carbon World are different abstractions.** The first slice may colocate one of each, but the architecture does not require a 1:1 mapping.
- **A Reconciler cleanup/target partition is not automatically a Context Scope.** They often coincide at Chunk; a Region projection partition may exist even when Region is not configured as a Context Scope.
- **Cross-coherence hierarchy is legal when explicitly modeled.** Ordinary Move remains within one coherence scope, but the generic Spine validator must not ban all parent/boundary relationships across independently coherent domains.
- **New consumers baseline from current truth.** They do not wait for a Watcher delta to discover already-existing durable state.
- **Dehydrate/writeback is write-side integration.** Normal post-publication Reconciler provisioning/Hydrate does not gain permission to mutate durable payload; targeted writeback runs inside the sanctioned mutation/integration interval.

These corrections do not change the central Spine/Coordinator/Watcher/Orchestrator/Reconciler architecture. They tighten identity, sequencing, and implementation boundaries.

## 0.2 Flow-completeness audit additions

A second end-to-end simulation of creation, streaming, mutation, persistence, and teardown exposed several contracts that must be explicit for a zero-context implementation agent:

1. **Composite creation is not Coordinator logic.** A domain/Marrow creation responsibility selects a trusted durable template/source set, clones/stamps it detached, mints fresh BUIDs, records immediate BaseId provenance, remaps internal durable references, preserves external references, and then submits the resulting generic structural/data proposal for sanctioned commit.
2. **Residency does not itself equal an active Context Scope runtime instance.** A transient scope runtime host/registry creates/rebuilds configured scoped systems and scratch state for newly active scopes and owns safe disposal when they retire.
3. **Becoming undesired is not always permission to release immediately.** A Reconciler may need a concern-local pending-retirement barrier while restoration-relevant dirty outcomes are written back. This is especially important for residency loss, provider replacement, and other non-durable Desired changes.
4. **Runtime simulation closes the loop through intent.** Unity triggers/physics/runtime logic may originate domain facts that lead to Add/Move/Delete requests, but they do not mutate Spine or runtime representation as a competing authority path.
5. **Durable BUID links need an explicit resolution seam.** Local resolution, cold/unloaded targets, Persistence Catalog lookup, broken references, and runtime pointer caching are separate from `SystemHandle<T>` contextual service resolution.
6. **Load correctness includes schema migration.** `TypeKey`, schema version, unknown optional data preservation, and required migration failure must be handled before coherent publication.
7. **Shutdown and scope teardown need ordered quiescence.** Stop new work, invalidate/cancel async work, integrate required provisional outcomes, release projection, dispose scope scratch, and detach stale handles/registrations.
8. **Warehouse lifetime is part of Reconciler convergence.** A Reconciler owns the acquired lease/handle for an Actual/Pending delivery occurrence; provider/content invalidation can change Desired target state without a Carbon durable revision.

These additions complete handoffs around the existing architecture rather than introducing new durable authorities.

# 1. Architectural Authority Model

## 1.1 Durable truth

The durable ECS/Carbon dataset is authoritative.

It contains the complete reconstructable facts needed to recover Carbon state, including as applicable:

- BUID identity;
- structural parentage;
- durable metadata;
- gameplay/domain payload components;
- durable references;
- provenance/template identity;
- Representation Markers and other durable representation declarations where present.

Generation/change stamps may also be stored in ECS, but they are **rebuildable acceleration metadata rather than authoritative meaning**.

A runtime GameObject, MonoBehaviour, Scene, Reconciler journal, binding registry, native index, or callback history is never required to recover authoritative world state.

If deleting all runtime caches makes the world unrecoverable, those caches have accidentally become a second authority.

## 1.2 Logical hierarchy

The Spine is the **logical hierarchical interpretation and query surface** over durable structural ECS records.

It exists to answer structural questions efficiently:

- Who is my parent?
- What are my children?
- What is beneath this Bone?
- What are my ancestors?
- What Context Scope contains this Bone?
- Can this whole subtree be pruned?
- Which durable population lies beneath this scope?

The Spine is useful because hierarchy and flat ECS component selection are different access patterns:

```text
Spine / tree
    hierarchy, ancestry, containment, scope, pruning

ECS queries
    component/archetype selection and dense hot processing
```

The intended hot-processing pattern is:

```text
Spine/context selection
        ↓
selected ECS population
        ↓
component/archetype filtering
        ↓
IJobEntity / IJobChunk / SystemAPI.Query
```

## 1.3 Runtime representation

Runtime Unity state is derived projection state.

Examples:

- GameObjects;
- MonoBehaviours;
- Prefab instances;
- loaded Scenes;
- Rigidbody state;
- Animator state;
- pooled runtime objects;
- Reconciler Actual/Pending inventories.

These may be expensive, asynchronous, stateful, and useful, but they do not become durable authority.

---

# 2. Core Vocabulary

## Bone

**Bone** is the current working name in this implementation discussion for one durable Carbon structural occurrence. The semantic role is the existing durable node/occurrence role; adopting the Bone name does not create a second kind of identity or state.

It is not necessarily a C# object. In the intended implementation it is fundamentally an ECS entity carrying the required Carbon structural components.

## Spine

**Spine** is the current working name for Carbon's logical durable hierarchy over Bones. The underlying logical-tree contract is architectural; the `Spine` code/terminology name may still be renamed without changing that contract.

Recommended definition for this handoff:

> **Spine is Carbon's logical hierarchy and query contract over authoritative ECS-backed Bones. Durable BUID identity and parentage define structure, rebuildable indexes provide efficient traversal, and normal structural mutation is committed through the Coordinator.**

## Unity Entities World vs Carbon World

Do **not** equate a durable Carbon `World` Bone/coherence domain with `Unity.Entities.World`. They solve different problems:

```text
Unity.Entities.World
    ECS container + entity/system execution context

Carbon World Bone / coherence scope
    durable game-state hierarchy/coherence concept
```

The first vertical slice may host one Carbon World inside one Unity ECS World because that is simple. That is not a 1:1 architectural invariant. A Unity ECS World-level Spine runtime service may index/serve multiple Carbon logical Worlds/coherence scopes if the host architecture chooses to colocate them. ECS `Entity` handles remain local to their owning Unity ECS World, while BUID remains Carbon durable identity.

## BUID

Canonical durable occurrence identity.

Rules:

- BUID identifies the durable occurrence;
- Move preserves BUID;
- Delete terminates BUID;
- runtime unload does not terminate BUID;
- ECS `Entity` is not a substitute for BUID;
- a runtime ECS entity handle may be cached as an acceleration handle but is not durable identity.

## BaseId / provenance identity

`BaseId` is the **immediate-source / provenance BUID** for a durable occurrence. It answers which durable source occurrence this occurrence derived from. It is distinct from:

```text
BUID    = this durable occurrence
BaseId  = immediate durable source/provenance occurrence
Barcode = reusable delivery-content lookup identity
```

Do **not** redefine BaseId as a generic asset-local presenter slot ID.

Current Carbon source provides `CarbonBehaviour.AssetId` as stable identity within an authored asset and uses it in delivered-part pairing. That is useful evidence for the first implementation, but the final general authoring-slot mapping remains an implementation contract.

For a deliberately constrained first vertical slice, it is acceptable to prove composite pairing with assets cloned **directly from an authored template** where presenter `AssetId` maps to the corresponding authored/template source BUID and the live Bone's `BaseId` points directly to that source. Do not assume that shortcut handles clone-of-clone lineage or every future authoring source.

## Context Scope

A meaningful hierarchy location that owns contextual runtime lifetime and working state.

Established Marrow examples include **World** and **Chunk**; Chunk is explicitly a natural Context Scope. A Region may also be configured as a Context Scope when application/game composition needs region-local systems or working memory, but hierarchy level alone does not automatically make every Region a Context Scope.

For a functional first slice, use an explicit transient/runtime-readable scope marker or equivalent schema signal, for example:

```csharp
public struct ContextScopeTag : IComponentData {}
```

The exact encoding may later become game-specific role metadata rather than one universal tag.

A Context Scope may own/rebuild:

- scoped systems;
- scoped working memory;
- local indexes;
- event/change aggregation;
- Reconciler binding buckets;
- dirty participant sets;
- pending projection operations;
- cached service resolution.

Context Scope is separate from:

- durable identity;
- persistence-file boundary;
- Representation Concern;
- residency/demand;
- coherence scope.

Normal Marrow scoped-system installation is **composition-driven**: application/game composition declares which transient system types exist at each applicable Context Scope kind; instances are created/disposed with that scope; durable Carbon data stores any persistent configuration/state those systems require. Do not invent a durable plugin registry merely to install runtime scope systems.

## Representation Marker

Durable concern-specific projection/delivery intent on a durable root.

It says roughly:

> "For this representation concern, this durable root/group wants this logical delivery package."

It does **not** define identity, Context Scope, residency, coherence, or persistence.

## Representation Concern

The category of derived runtime representation managed by one Reconciler concern.

Examples:

- prefab/gameplay representation;
- scene representation;
- editor visualization;
- map icon;
- debug representation.

One durable BUID may have multiple concern-specific representations.

The conceptual global projection key is therefore approximately:

```text
(BUID, Concern)
```

Within one specific Reconciler, Concern is usually implicit and need not be repeated in every local record.

## Barcode and Delivery Package

**Barcode** is the canonical stable logical lookup identity carried/resolved by a Representation Marker for reusable delivery content. The Asset Warehouse resolves that Barcode to the required Delivery Package/product.

A Barcode may resolve to products/delivery forms such as:

- a Prefab;
- a Scene;
- another future delivery container.

## Component Manifest

A generated/validated index on a structured delivery container that gives a Reconciler deterministic references to Carbon-managed presenters and their authored binding metadata.

It is not durable authority.

## Desired

The complete current target population for one Reconciler concern and one explicit partition.

## Actual

The runtime occurrences the Reconciler actually owns/adopts right now.

Actual is not necessarily Ready.

## Hydrate

Targeted synchronization from coherent durable ECS state into runtime/engine-facing state.

## Dehydrate

Targeted synchronization of a restoration-relevant outcome that currently lives only in runtime/engine state back into authorized durable ECS data.

---

# 3. The Minimal Spine Data Model

The Spine should begin with the smallest possible structural ECS schema.

A functional starting point is:

```csharp
public struct BoneTag : IComponentData
{
}

public struct BoneIdentity : IComponentData
{
    public BUID Buid;
}

public struct BoneParent : IComponentData
{
    public BUID Parent;
}
```

`BoneTag` is optional from a semantic perspective, but is attractive as a cheap explicit query marker. Unity Entities tag components contain no data.

A root can use a defined empty parent convention:

```text
BoneParent.Parent = BUID.EMPTY
```

A non-root must point at an existing **legal** parent according to the hierarchy/relationship/coherence rules. Most ordinary Marrow parentage and all ordinary runtime `Move` operations stay within one coherence scope, but the logical hierarchy may contain explicit boundary relationships between independently coherent scopes (for example composition above/between World scopes). Do not reject such a relationship merely because the two nodes publish independently; do reject an ordinary Move that attempts to cross a coherence boundary without the required higher-level semantics.

## 3.1 Recommended supporting structural metadata

A practical prototype should also include:

```csharp
public struct BoneGenerations : IComponentData
{
    public ulong Structure;
    public ulong Data;
    public ulong Subtree;
}
```

`uint64`/`ulong` is the preferred default because these are equality stamps and false equality after wrap must be operationally irrelevant. Exact stamping/propagation remains implementation. The stamps are rebuildable acceleration metadata and need not be treated as durable semantic truth.

Semantics:

- `Structure`: this Bone's own structural state changed;
- `Data`: this Bone's durable payload changed;
- `Subtree`: something authoritative beneath this Bone changed.

These are equality/change stamps, not ordered history counters.

An ordered **coherence revision** is a separate concept.

## 3.2 Optional provenance/template metadata

For authored/cloned graphs:

```csharp
public struct BoneProvenance : IComponentData
{
    public BUID BaseId;
}
```

`BaseId` preserves immediate-source provenance. It may participate in a constrained direct-template pairing implementation, but it is not the general presenter-slot identity contract.

## 3.3 What is NOT Spine core data

These may live on Bone entities but do not define the hierarchy itself:

```text
Representation Markers
Health
Inventory
AI state
physics configuration
asset/delivery metadata
save-specific metadata
simulation participation metadata
```

The structural tree exists with only identity + parentage.

## 3.4 Coherence-boundary parentage

Hierarchy and coherence are separate axes. The first functional slice can deliberately keep all mutable test parentage inside one coherence scope, but the generic Spine contract must not encode "every parent is in my coherence scope" as a universal invariant. A coherence-scope root may participate in a larger logical hierarchy whose parent belongs to another independently published scope. Such boundary relationships require explicit higher-level coordination/ownership and are not ordinary `Move` targets. Exact physical storage of those boundary links remains implementation.

---

# 4. Canonical Parentage and Derived Children

The architecture should have exactly one authoritative direction for hierarchy.

Recommended rule:

> **Parentage is authoritative. Child membership is derived.**

Durably:

```text
Bone B: Parent = Bone A BUID
Bone C: Parent = Bone A BUID
Bone D: Parent = Bone B BUID
```

This alone defines:

```text
A
├── B
│   └── D
└── C
```

Do not persist a second authoritative child list that can disagree with parentage.

## 4.1 Child acceleration choices

Downward traversal needs an efficient reverse index. Three credible implementations are:

### Option A: Native parallel multimap

```text
BUID -> Entity
ParentBUID -> child Entity(s)
```

Example:

```csharp
NativeParallelHashMap<BUID, Entity> _byBuid;
NativeParallelMultiHashMap<BUID, Entity> _children;
```

### Option B: ECS DynamicBuffer child index

A derived `DynamicBuffer<BoneChild>` on parent entities, analogous to Unity's transform hierarchy pattern.

The buffer is still derived and rebuildable from `BoneParent`.

### Option C: packed adjacency arrays

Scope-local or World-local packed structures optimized for traversal:

```text
parent record
child start
child count
packed child entity array
```

This may eventually be faster for large stable trees but is more complex to maintain incrementally.

## 4.2 MVP recommendation

Use:

```text
NativeParallelHashMap<BUID, Entity>
NativeParallelMultiHashMap<BUID, Entity>
```

first.

Reasons:

- simple;
- obviously rebuildable;
- no second durable component relationship;
- easy to inspect and fuzz-test;
- easy to replace after profiling.

Then benchmark it against a derived ECS child buffer before locking physical storage.

---

# 5. Unity Transform Hierarchy as a Useful Reference

Unity Entities has to solve a related problem for transform trees.

The relevant architectural pattern is:

```text
authoritative parent relationship
        ↓
system-maintained reverse child adjacency
        ↓
fast downward hierarchy traversal
```

In Unity Entities' transform stack, `Parent` expresses the upward relationship and the transform hierarchy maintains derived `Child` buffer data for efficient downward traversal. That is especially relevant to Spine because it demonstrates that an ECS hierarchy can keep one canonical direction while deriving the reverse direction for runtime traversal. If Carbon ever chooses ECS `DynamicBuffer<BoneChild>` as its derived accelerator, that buffer must remain rebuildable and should be excluded/rebuilt rather than treated as persisted structural authority.

Carbon should copy that **pattern**, not reuse Unity Transform hierarchy semantics.

Important differences:

- Unity transform hierarchy is spatial;
- Carbon Spine hierarchy is semantic;
- Unity can use runtime `Entity` references as transform-parent identity;
- Carbon durable hierarchy needs BUID identity;
- Unity often propagates transforms continuously;
- Carbon structural hierarchy should usually update only when structure changes or when an explicit hierarchical query requires work.

This means Carbon can potentially use similar adjacency techniques with much lower recurring work than transform propagation.

The key lesson is:

> ECS does not eliminate the cost of hierarchy. It gives us better control over storage, allocation, parallelism, and derived indexes. The winning design is still authoritative parentage plus efficient derived downward adjacency.

---

# 6. Spine Materialization / Rebuild from an ECS World

The Spine must be able to appear from already-existing ECS data.

This is essential for:

- startup;
- load;
- import;
- reload;
- migration;
- repair;
- tests;
- external/server-provided state.

The Coordinator is **not required for the Spine to be reconstructible**.

The Coordinator is the normal mutation path. The Spine is the interpretation/indexing layer over structural truth that already exists.

## 6.1 Rebuild pass

A `SpineTopologySystem` should be able to do:

```text
query all entities with required Bone structural components
        ↓
clear/rebuild BUID -> Entity index
        ↓
validate unique BUIDs
        ↓
validate parent references
        ↓
identify legal roots
        ↓
validate no structural cycles
        ↓
build Parent -> Children index
        ↓
optionally build scope/root accelerators
        ↓
Spine becomes queryable
```

## 6.2 Orphan handling

Do not confuse these cases:

```text
Parent == EMPTY
    = intentional root under the applicable root contract

Parent == X, X is required to be materialized/in-scope, but X does not exist
    = invalid/orphan structural record

Parent/boundary reference == X, X is legally outside the currently materialized coherence scope
    = potentially valid unresolved/cold boundary relationship, according to its resolver semantics
```

An invalid orphan must not silently become a root. Likewise, the validator must not misclassify an explicitly legal cross-coherence/cold boundary reference as an orphan merely because the target is not in the current local BUID index.

For the first single-coherence vertical slice, keep this simple: every non-root `BoneParent` is expected to resolve locally, so missing parents are errors. When cross-coherence hierarchy composition is introduced, give the validator/resolver enough boundary metadata/context to distinguish local structural corruption from a legal external boundary relationship.

The materialization/rebuild layer should:

- report invalid local orphans;
- refuse coherent publication if the structural state is invalid, unless an explicit repair mode is active;
- optionally expose privileged repair primitives;
- preserve legal unresolved boundary relationships according to their dedicated resolver contract.

## 6.3 Hard architecture test

The defining Spine test is:

> Delete every transient Spine cache/index/view. Given only the durable ECS-backed Bone records, reconstruct exactly the same logical hierarchy.

If this cannot be done, some supposedly transient state has become hidden authority.

## 6.4 Shared access to Spine indexes

A practical ECS implementation needs an explicit answer to a non-architectural but critical question:

> How do Coordinator, Watcher, Orchestrator, and Reconcilers access the same rebuildable Spine indexes without each rebuilding a private copy?

For the first functional implementation, use a **Unity-Entities-World-local Spine runtime owner**. The simplest shape is a managed ECS `SystemBase` that owns native containers and can hand trusted Carbon systems lightweight read-only views of those containers.

Conceptually:

```csharp
public sealed partial class SpineRuntimeSystem : SystemBase
{
    NativeParallelHashMap<BUID, Entity> _byBuid;
    NativeParallelMultiHashMap<BUID, Entity> _children;

    internal SpineReadOnly GetReadOnlyView() => ...;
    internal SpineMutable GetPrivilegedMutableView() => ...;
}
```

`SpineReadOnly` should contain native-container handles/views, not copied hierarchy data. Jobs may receive those native views as job inputs under normal Entities safety/dependency rules.

The runtime owner must also define **one dependency/ordering boundary** for index mutation. Coordinator/topology maintenance must not mutate `_byBuid` or `_children` concurrently with jobs reading them. For the first slice, keep topology commits/rebuilds on the main-thread phase before read-side jobs, complete/chain outstanding reader dependencies before mutation, then expose read-only views for the settled phase. This avoids a hidden race in the otherwise-correct shared-index design.

This is **one runtime service per chosen Unity ECS World/container**, not one managed object per Bone. It therefore does not reintroduce the allocation pattern that motivated removal of the managed Node tree.

Later, if profiling or Burst constraints justify it, the physical owner may become an `ISystem`, ECS-resident child buffers, a dedicated unmanaged world service, or another layout. Keep the consumer-facing Spine contract independent of that choice.

For a first implementation, prefer the simplest access path that is obviously correct over forcing every core role into `ISystem` prematurely. `SystemBase` can still schedule Burst jobs over native containers.

---

# 7. Spine Query Surface

Ordinary consumers should not need to manually perform raw `EntityManager` parent scans for hierarchy semantics.

The Spine should expose a read-only structural/query surface.

Possible API shape:

```csharp
public interface ISpineRead
{
    bool Exists(BUID buid);
    bool TryResolve(BUID buid, out Entity entity);

    BUID GetParent(BUID buid);

    ChildEnumerable GetChildren(BUID buid);
    AncestorEnumerable GetAncestors(BUID buid);
    SubtreeEnumerable GetSubtree(BUID root);

    bool IsAncestorOf(BUID ancestor, BUID descendant);
    bool IsDescendantOf(BUID descendant, BUID ancestor);

    bool TryFindNearestContextScope(BUID start, out BUID scope);
}
```

Exact return types should be allocation-free or close to it in runtime hot paths.

No managed `Bone` wrapper is required.

A lightweight value-type `BoneRef` or `BoneView` may be useful later, but it must remain a transient convenience, not the durable record.

---

# 8. Coordinator: Structural Mutation Authority

The Coordinator and Spine are tightly related but deliberately separate.

```text
Spine
    reads/interprets/indexes structure

Coordinator
    changes structure
```

The Coordinator is the single normal sanctioned generic structural commit responsibility.

It owns Carbon's structural verbs:

```text
Add
Move
Delete
```

It does not own gameplay meaning.

A domain/system decides **what structural result it wants**. Coordinator decides whether that result is structurally legal and commits it coherently.

## 8.1 Structural request model

A functional request representation might be:

```csharp
public enum StructuralOp : byte
{
    Add,
    Move,
    Delete,
    // optional internal normalization-only intent; not public identity termination
    InternalRemove
}

public struct StructuralRequest : IBufferElementData
{
    public StructuralOp Op;
    public BUID Subject;
    public BUID Parent;
    public ulong Sequence;
}
```

For Add, the exact payload may reference a creation recipe/archetype/template rather than fitting in this minimal struct.

A singleton `DynamicBuffer<StructuralRequest>` is a reasonable first intake mechanism.

Parallel jobs may record requests through an `EntityCommandBuffer.ParallelWriter` if required.

## 8.2 Coordinator pass

```text
collect structural requests
        ↓
normalize
        ↓
collapse redundant/conflicting intent
        ↓
validate proposed final structure
        ↓
host/cadence opens sanctioned mutation interval
        ↓
commit Add / Move / Delete
        ↓
update/rebuild affected Spine indexes
        ↓
advance structural generation stamps
        ↓
record structural change summary
        ↓
coherent publication
```

## 8.3 Collapse examples

The current semantic intent is to collapse to the minimal final valid result rather than replaying every intermediate request as architecture history.

Canonical examples:

```text
Add -> internal Remove before publication
    => no durable result

internal Remove -> Add at same place, identity never terminated
    => no-op

internal Remove -> Add at different place with valid continuity
    => Move

Add -> Move
    => Add at final parent

Move -> Delete
    => Delete

true Delete -> Add
    => a new durable occurrence / new BUID
```

Here `InternalRemove` means non-terminal queued detach/removal intent used during normalization. It is not true Delete and should not be exposed ambiguously as the public identity-termination operation.

Exact conflict diagnostics and caller result reporting are implementation details, but no observer should see an invalid intermediate state.

## 8.4 Add

Add:

- creates a new durable occurrence;
- mints/assigns its BUID according to Carbon identity rules;
- creates the ECS entity with its required initial archetype/components;
- sets legal parentage;
- updates affected hierarchy/index/generation state.

For efficiency, creation should prefer a complete initial archetype instead of repeatedly adding components after creation where practical.

## 8.5 Move

Carbon Move is semantically structural but may be physically cheap in ECS.

If parentage is ordinary component data:

```csharp
BoneParent.Parent = newParentBuid;
```

then Move does **not** necessarily cause an ECS archetype migration.

It still requires Carbon structural work:

- cycle validation;
- old parent child-index removal;
- new parent child-index insertion;
- old/new ancestry generation propagation;
- structural change summary;
- Context Scope reevaluation downstream.

Move preserves BUID.

Move means **reevaluate**, not automatically reprovision.

## 8.6 Delete

Delete:

- terminates durable identity;
- captures the deleted BUID and relevant former context before reclamation;
- updates surviving parent/ancestor generations and indexes;
- destroys/removes the durable ECS record;
- never means runtime unload or pool release.

Deletion of a subtree must have an explicit contract. Do not leave child disposition implicit.

## 8.7 Privileged direct structural integration

Bootstrap/import/reload/migration/repair/tests may need narrow privileged structural primitives.

Those are engine infrastructure, not a second ordinary public mutation model.

Their output must still satisfy the same final Spine invariants before coherent publication.

## 8.8 Composite creation / clone preparation is upstream of Coordinator

The phrase `Add durable Zombie` hides a critical responsibility boundary. Coordinator owns **generic structural legality and commit**, not the semantic recipe for constructing a Zombie's Body, Weapon, Inventory, markers, payload, or durable references.

For reusable authored/template creation, use a distinct **creation/clone materialization responsibility**. The exact class/system name is implementation freedom.

Canonical clone preparation:

```text
domain/Marrow requests creation from a trusted source/template
        ↓
select explicit source set/subtree
        ↓
clone detached from live Spine
        ↓
mint fresh BUID for every cloned durable occurrence
        ↓
build source-BUID -> clone-BUID map
        ↓
record each clone's immediate-source BaseId provenance
        ↓
copy durable payload + Representation Markers + relevant metadata
        ↓
remap durable references whose targets are inside cloned set
preserve durable references whose targets are outside cloned set
        ↓
produce proposed parentage / payload / initial archetype data
        ↓
Coordinator performs cheap current checks and sanctioned atomic attach/commit
```

Trusted source/template validity belongs primarily to authoring/ingestion/migration/repair validation. The live commit still checks current facts such as destination existence, coherence compatibility, cycle legality, stale preconditions, and BUID collision/insert validity.

For a multi-Bone creation, the proposal may contain several Add operations plus initial payload writes that must publish as one coherent semantic result. Intermediate detached clone records are staging data, not live durable truth.

This responsibility may resolve a durable template/source product through the Asset Warehouse, a dedicated template store, or another validated source mechanism. **Resolving a Prefab delivery product is not the same operation as creating durable Carbon state**, even when both products are associated with the same Barcode.

---

# 9. Two Mutation Channels

Do not turn Coordinator into a universal data god-system.

Carbon has two materially different write paths:

## Structural

```text
Add / Move / Delete
    → Coordinator
```

## Payload

```text
Health / Inventory / AI / ordinary durable component data
    → sanctioned direct ECS writes during the permitted mutation interval
```

Both must be visible correctly by the next coherent publication. If multiple accepted payload writes affect the same fact in one publication, their result-affecting processing order must be deterministic; do not let accidental parallel ECS iteration order become semantic authority. Disjoint writes may remain parallel.

This distinction matters for performance and conceptual ownership.

---

# 10. Coherence, Generations, and Publication

Carbon should expose settled coherent truth rather than making downstream systems infer consistency from arbitrary Unity callback timing.

A useful abstract epoch is:

```text
collect intent / completed async integration
        ↓
open sanctioned mutation/integration interval
        ↓
direct payload writes + structural commit preparation/application
(stage destructive work when required runtime outcomes must survive)
        ↓
targeted prepare-for-publication work when required
        ↓
finalize any staged destructive structural work under the selected success policy
        ↓
close mutation interval
        ↓
establish coherent publication + ordered coherence revision when a new publication is produced
        ↓
Watcher observes settled truth
        ↓
Orchestrator / downstream derivation
```

## 10.1 Coherence revision

Maintain an ordered revision per coherence domain, for example current Marrow World.

Conceptual singleton:

```csharp
public struct CarbonCoherence : IComponentData
{
    public ulong Revision;
}
```

Generation stamps and coherence revision are different:

```text
Generation
    did this thing/branch change since my watermark?

Revision
    which coherent published state is this?
```

## 10.2 Data dirty integration

A practical first implementation for direct durable ECS writes is an enableable dirty marker:

```csharp
public struct BoneDataDirty : IComponentData, IEnableableComponent
{
}
```

Sanctioned writers enable it when a meaningful durable payload write occurs.

Publication then:

```text
collect dirty Bones
advance DataGen
propagate SubtreeGen to affected ancestors
disable BoneDataDirty
```

Important limitation:

A dirty marker only catches writers that participate in the contract. ECS chunk/component change versions can be used as a conservative broad-phase/recovery mechanism, but are not exact per-entity semantic change truth.

## 10.3 Structural index recovery / out-of-band change backstop

Normal structural writes go through Coordinator, but the runtime must not permanently corrupt itself if structural ECS records are replaced or changed by a privileged load/import/repair path.

The primary rule for privileged replacement/reload/import/repair is simple: **force a Spine index rebuild before coherent publication**. That is the safest first implementation.

An optional diagnostic/recovery backstop may retain derived shadow information such as:

```text
BUID -> last indexed ParentBUID
```

and compare it against current `BoneParent` when verification is requested. ECS change versions or query-count/index-count checks may act as conservative signals. Do not make the shadow comparison the normal mutation authority.

If a current `BoneParent` differs from the shadow without a matching Coordinator commit:

```text
remove child from old derived parent bucket
add child to new derived parent bucket
update shadow
record/diagnose out-of-band structural change
advance the appropriate structural invalidation/publication state
```

The shadow/index remains disposable. Durable `BoneParent` remains authority.

This is conceptually similar to Unity transform hierarchy machinery retaining derived parent/child state so it can maintain downward traversal efficiently, while Carbon keeps BUID parentage as its durable semantic source.

---

# 11. Watcher

The Watcher's job is simple conceptually:

> **Observe settled durable truth and identify/localize what changed, regardless of where that change came from.**

It must not depend exclusively on having personally seen every Coordinator request.

Why:

- load/reload may replace durable data;
- server/import/repair paths may update data;
- direct payload writes exist;
- correctness must derive from current truth.

## 11.1 Watcher inputs

Possible inputs/accelerators:

- coherence revision;
- Structure/Data/Subtree generation stamps;
- trusted structural commit summaries;
- BUID/parent indexes;
- conservative ECS change-version broad phase.

## 11.2 Watcher output

A functional `PublishedChangeSet` should localize enough information for downstream selection without becoming a replay log.

Example conceptual records:

```csharp
public struct ChangedBone
{
    public BUID Buid;
    public ChangeKinds Kinds;
}

public struct StructuralMove
{
    public BUID Buid;
    public BUID OldParent;
    public BUID NewParent;
}

public struct StructuralDelete
{
    public BUID Buid;
    public BUID FormerParent;
}
```

The output is an accelerator for current-state rederivation, not authoritative history. A downstream consumer must also be able to baseline/requery from current coherent durable truth; correctness must not require receiving every Watcher change summary in sequence.

---

# 12. Context Scope and Scope-Owned Scratch Memory

This is one of the strongest consequences of the architecture.

Recommended rule:

> **Transient working state should be owned by the Context Scope that gives that state meaning.**

Examples:

```text
World Context
├── World-scoped systems
├── World projection bucket
├── World scratch indexes
└── descendant runtime scopes

Optional configured Region Context
├── Region-scoped systems
├── Region projection bucket
├── Region scratch
└── descendant runtime scopes

Chunk Context
├── Chunk-scoped systems
├── Chunk projection bucket
├── participant bindings
├── dirty participants
├── pending projection work
└── local caches/indexes
```

## 12.1 Why this matters

Without scope ownership, teardown becomes search-driven:

```text
find every presenter belonging to Chunk A
find every binding for Chunk A
find every dirty callback for Chunk A
find every pending load for Chunk A
find every cache entry for Chunk A
...
```

With scope-owned scratch state:

```text
tear down Chunk A runtime scope
        ↓
all Chunk A transient ownership is already known
```

The scope bucket is not authoritative membership. Durable ancestry remains authoritative.

The bucket means:

> "This runtime working state currently exists because this Context Scope is active."

Delete the bucket and it must be rebuildable.

## 12.2 Scoped-system composition and Reconciler partitioning

Application/game composition decides which hierarchy kinds install scoped runtime systems. For the first Marrow implementation, World and Chunk are established useful Context Scope cases; Region becomes a Context Scope only if composition explicitly needs region-local systems/working memory. Runtime scoped-system instances are transient, and any state that must survive their disposal belongs in durable Carbon data.

When a consumer needs a context-dependent service, use the established `SystemHandle<T>`-style relationship (or equivalent implementation): resolve the applicable provider on bind/context transition, cache the provider for the hot path, and re-resolve after a Move that changes relevant context. Static same-lifetime dependencies can remain direct references.

For Marrow, per-Chunk Reconciler buckets are especially attractive for entity-level runtime projections because Chunk is already a natural Context Scope and unload unit.

However, the representation system must also support higher layers:

```text
World Representation Marker -> World Scene
Region Representation Marker -> Region Scene
Chunk Representation Marker -> Chunk Scene / local projections
```

A **Reconciler target/cleanup partition is not automatically a Context Scope**. If Region is configured as a Context Scope, its Reconciler scratch can naturally live with that scope. If Region is not a Context Scope, a Region Scene Reconciler may still use the Region BUID/marker root as a concern-local partition key for Desired/Actual cleanup without redefining Region as a Context Scope.

Therefore prefer Context-Scope-owned buckets where the lifetime semantics genuinely align, with Chunk as the normal fine-grained entity/runtime partition, while allowing explicit concern-local partition keys for representation cases that do not coincide with Context Scope.

## 12.3 Active runtime Context Scope lifecycle

A durable Context Scope location and an **active runtime scope instance** are different things.

For example:

```text
durable Chunk Bone exists
        ≠
Chunk runtime scope/system instances currently exist
```

Application/game composition declares which scope kinds install which transient runtime systems. A small **Context Scope runtime host/registry** should own the active instances.

When a scope becomes runtime-active:

```text
Residency / host policy selects durable scope
        ↓
ensure coherent durable scope state exists
        ↓
create/register configured runtime scope instance + scoped systems
        ↓
rebuild/baseline disposable scope working state from Spine/ECS
        ↓
enable scope-local work
        ↓
allow concern Desired/realization that depends on that runtime context
```

When a scope is leaving:

```text
mark runtime scope retiring
        ↓
stop accepting new scope-local work
        ↓
invalidate/cancel pending work that cannot survive
        ↓
allow Reconcilers to enter safe pending-retirement/writeback paths
        ↓
wait until required dirty outcomes and owned runtime occurrences are safely resolved
        ↓
dispose scoped systems/caches/handles/registrations
```

The runtime scope host does not become durable membership authority. Durable ancestry still answers what belongs to the scope. The host only owns the transient runtime lifetime for the currently active context.

For the first Marrow slice, Chunk is the most valuable dynamic runtime scope. World may be activated by broader host policy and can remain active for the session. Region remains optional according to composition.

---

# 13. Drivers, Residency Solver, and Concern Filters

These are distinct from Spine and Context Scope and must appear explicitly in the runtime timeline.

## 13.1 Driver demand

Drivers/observers express **current runtime demand**, not durable identity. Examples include player/camera demand, server simulation demand, editor viewport demand, spectator/tool demand, and other host policy.

For one representation concern, multiple demand reasons normally union and deduplicate rather than creating duplicate projection occurrences.

## 13.2 Residency Solver

The Residency Solver converts Driver demand into an **eligible durable population**. Residency is transient and separate from durable existence.

For current Marrow specifically:

> **Chunk is the default practical residency/streaming selection unit for entity residency.**

Therefore a simple first implementation can maintain a transient resident-Chunk set and select the durable populations beneath those Chunks. Do not hard-code this as a generic Carbon rule.

A minimal transient ECS representation could use an enableable/non-persisted marker such as:

```csharp
public struct RuntimeResident : IComponentData, IEnableableComponent {}
```

Alternatively the resident set may live entirely in a host/coherence-partitioned native container owned by the host/Residency Solver. The semantic contract matters more than the storage.

Residency selection also drives **runtime Context Scope activation/retirement** where the selected durable scope kind installs transient scoped systems. That scope-runtime transition is a parallel integration prerequisite, not durable membership truth. Orchestrator/Marrow should not start concern work that requires a Chunk runtime context until that context has been baselined and enabled.

## 13.3 Concern Filter/query

After residency/eligibility selection, the concern-specific Filter/query selects durable occurrences relevant to one Reconciler concern, including Representation Marker/data requirements.

Canonical semantic pipeline:

```text
Driver / observer demand
        ↓
Residency Solver
        ↓
eligible durable population
        ↓
concern-specific marker/data Filter or query
        ↓
one complete unioned/deduplicated Desired set
        ↓
Reconciler
```

The Orchestrator coordinates/composes this pipeline and cross-concern sequencing; it does not need to own every residency algorithm internally.

---

# 14. Orchestrator

Calling the Orchestrator "the router" is useful, but incomplete.

It is not merely forwarding events.

Its responsibility is:

> **Compose settled durable truth, changed subsets, operating context, scope/demand, residency/provider state, and Reconciler interest into the current complete Desired population for each Reconciler concern/partition.**

It is not:

- gameplay authority;
- structural mutation authority;
- durable authority;
- the Reconciler's Actual inventory owner;
- a hardcoded switch over every possible representation type.

## 14.1 Conceptual selection pipeline

```text
coherent durable Spine/ECS state
        +
Watcher changed subset / generation pruning when available
        +
current Context Scope / operating mode
        +
residency / observer demand
        +
Reconciler interest contract
        ↓
selected hierarchy population
        ↓
concern-specific ECS marker/component filter
        ↓
exact complete Desired set
        ↓
Reconciler
```

## 14.2 Complete Desired means replacement semantics

A Reconciler should not depend on receiving every historical add/remove event.

A newly installed Orchestrator/Reconciler concern, a reloaded scope, or a consumer that lost its incremental watermark must perform a **baseline derivation from current coherent truth**. It must not wait for a Watcher delta to "discover" state that already exists. Watcher/change summaries only accelerate later localization. Likewise, Driver/residency demand or Warehouse/provider state can change Desired projection without any new durable Carbon coherence revision, so target derivation must also react to those non-durable inputs.

For an explicit partition:

```text
World X / Chunk A / Prefab concern / Revision 41
```

the Desired set is the complete current target for that partition.

Missing prior updates therefore converge naturally on the next target set.

## 14.3 Target-set transport: functional MVP

A concrete ECS-friendly implementation can use target-partition entities:

```csharp
public struct ReconcilerTargetPartition : IComponentData
{
    public BUID PartitionRoot;
    public ulong Revision;
    public ulong TargetToken;
}

public struct DesiredProjectionRecord : IBufferElementData
{
    public BUID MarkerRoot;
    public Barcode DeliveryBarcode;
}
```

Use one partition entity per concern/scope partition, or another equivalent structure with unambiguous replacement semantics.

The exact transport can later become native containers, chunked arrays, or direct system handoff.

## 14.4 Concern installation / interest registration

The Orchestrator needs an explicit way to know which Reconciler concerns exist and what durable data each concern selects.

Application/game composition should install the concern systems and their **interest/filter contract**. The exact registry/API is implementation freedom.

Minimum information per installed concern may include:

- concern identity/type;
- required Representation Marker/component roles;
- operating-mode compatibility;
- partitioning policy;
- prerequisite/dependency declarations where needed;
- Reconciler endpoint/system handle.

A newly installed concern performs a baseline derivation from current coherent truth. Concern installation does not create durable state and does not require a global closed enum such as Prefab/Scene/System.

---

# 15. Representation Markers and Delivery Groups

A Representation Marker is durable metadata on a root for one concern.

Example conceptual components:

```csharp
public struct PrefabRepresentation : IComponentData
{
    public Barcode DeliveryBarcode;
}

public struct SceneRepresentation : IComponentData
{
    public Barcode DeliveryBarcode;
}
```

Exact naming/encoding is implementation-specific.

## 15.1 Delivery group

A marked root may define one composite delivery group spanning selected descendants.

Example:

```text
ZombieRoot [PrefabRepresentation: ZombieMale]
├── Body
├── Weapon
├── Inventory
└── Brain
```

One prefab may contain presenters for several of those durable Bones.

A nested marker for the same concern starts a nested/child delivery group and prevents accidental arbitrary hierarchy search beyond the group.

## 15.2 Many-to-many delivery

Do not assume one Bone equals one prefab.

The architecture permits:

```text
one delivery package -> many durable BUIDs
one durable BUID -> several concern-specific packages
```

This is why the Reconciler needs both **delivery-instance records** and **participant-to-Bone bindings**.

---

# 16. Asset Warehouse

The Asset Warehouse resolves a Representation Marker's stable logical delivery intent to immutable/versioned source material.

It owns things like:

- prefab/scene/package lookup;
- immutable source caches;
- provider/version translation;
- detached templates/content references.

It does not own:

- active durable state;
- BUID identity;
- gameplay authority;
- active Reconciler inventory.

A functional first API can be intentionally small:

```csharp
DeliveryHandle Resolve(Barcode key);
```

where `DeliveryHandle` can expose the concern-specific Prefab/Scene acquisition information.

## 16.1 Acquisition lease, provider version, and invalidation

For a functioning async/runtime system, the resolved delivery product needs explicit lifetime ownership even if the first API is simple.

Recommended responsibility:

```text
Reconciler requests/resolves Barcode
        ↓
Warehouse/provider returns delivery handle or lease
        ↓
Reconciler owns that lease while Pending/Actual needs the product
        ↓
release lease when work is stale, retired, cancelled, or replaced
```

Provider/content version is separate from Barcode. A provider update, eviction, invalidation, address change, or compatible replacement may require a new **Desired target token** even when durable Carbon data and coherence revision did not change.

Therefore the Orchestrator/Reconciler derivation inputs include current Warehouse/provider target state. The first slice may use static synchronous assets and no eviction, but the lifetime seam must remain visible so a later async provider does not become a hidden authority or leak resources.

A stale acquisition completion is released unless it still satisfies the newest Desired target.

---

# 17. Reconciler as an ECS System

Yes, a Reconciler can and should be implemented as an ECS system where that improves integration with Carbon's ECS data and scheduling.

Important distinction:

> "A Reconciler is physically implemented as an ECS system" is **not** the retired old idea of a universal architectural "System Reconciler" concern. The Reconciler concern remains concern-specific; ECS system is simply its implementation host.

## 17.1 `ISystem` vs `SystemBase`

Unity Entities 1.4 supports both.

### Use `ISystem` when

- state is unmanaged;
- Native collections are sufficient;
- Burst/job-heavy work dominates;
- no direct managed Unity object inventory is needed.

Good candidates:

```text
SpineTopologySystem
CoordinatorSystem
WatcherSystem
most Orchestrator selection work
```

### Use `SystemBase` when

- the system needs managed object references;
- it owns GameObjects/MonoBehaviours;
- it owns asset/scene handles;
- it handles managed async integration;
- persistent managed dictionaries/lists are useful.

Good initial candidates:

```text
PrefabReconcilerSystem
SceneReconcilerSystem
```

A later optimization can split a Reconciler into:

```text
unmanaged diff/query core
        +
managed Unity effect adapter
```

but that split is not required for the first functional slice.

## 17.2 Persistent scratch memory between updates

An ECS system can retain state between update calls.

A Prefab Reconciler `SystemBase` can own, for example:

```text
partition buckets (Context-Scope-backed where lifetime semantics align)
actual projection entries
participant bindings
pending async operations
dirty participant sets
target tokens
asset handles
pooled Unity object references
```

These remain alive until explicitly cleared or until the system/World is destroyed.

For `ISystem`, persistent unmanaged containers can be allocated in `OnCreate` and disposed in `OnDestroy`.

---

# 18. Reconciler Runtime Data Model

Do not create a managed `BoneBinding` class per bind merely to replace the old managed Node object.

The binding relationship is required. A binding heap object is not.

Recommended two-level Actual model:

```text
Partition Bucket
    ↓
Projection Entries
    ↓
Participant Bindings
```

## 18.1 Projection Entry

Represents one delivered runtime container/group.

Conceptually:

```csharp
struct ProjectionEntry
{
    BUID MarkerRoot;
    Barcode DeliveryBarcode;
    int BindingStart;
    int BindingCount;
    // runtime instance handle lives in managed side if needed
}
```

Managed companion data may contain:

- GameObject root;
- loaded Scene handle;
- asset lease;
- pending operation state.

## 18.2 Participant Binding

Represents one presenter-to-durable-Bone association.

Conceptually:

```csharp
struct ParticipantBinding
{
    BUID Bone;
    int PresenterIndex;
    ulong LastHydratedDataGen;
}
```

On a managed Prefab Reconciler, a parallel managed presenter array can hold actual `CarbonBehaviour` references.

No managed Bone object is required.

## 18.3 Presenter-local state

The presenter already exists as a MonoBehaviour, so it may store the tiny amount of binding state it needs without allocating another object:

```csharp
public abstract class CarbonBehaviour : MonoBehaviour
{
    private BUID _boundBuid;
    private ParticipantHandle _participant;
    private ulong _lastHydratedGen;
}
```

`ParticipantHandle` should be a value type, optionally index + version:

```csharp
public readonly struct ParticipantHandle
{
    public readonly int Index;
    public readonly uint Version;
}
```

The version protects against stale pooled/reused bindings.

A simpler MVP may store BUID + owner reference and perform a dictionary lookup. Introduce the packed handle only if useful.

---

# 19. Component Manifest Pairing

When a Representation Marker causes a composite Prefab/Scene to be delivered, the Reconciler must answer:

> Which presenter inside this asset represents which durable Bone?

The manifest solves **deterministic discovery**. Pairing to durable parts is a separate contract. The architecture must not pretend that BaseId is a universal asset slot ID.

Current source evidence is useful: `CarbonBehaviour.AssetId` provides stable identity within an authored asset and current Component Manifest code uses it for delivered-part pairing. For the first functional proof, constrain the authoring case enough to make that mapping deterministic.

### Functional MVP pairing rule

For a prefab cloned directly from one authored durable/template source set:

```text
presenter AssetId
        ↓ identifies authored/template source part
source/template BUID
        ↓ match live clone whose immediate BaseId == that source BUID
live BUID
        ↓
Bind presenter to live BUID
```

Example:

```text
Authored/template source
Body source BUID      = T_BODY
Weapon source BUID    = T_WEAPON
Inventory source BUID = T_INVENTORY

Prefab manifest
BodyPresenter      AssetId = T_BODY
WeaponPresenter    AssetId = T_WEAPON
InventoryPresenter AssetId = T_INVENTORY

Direct live clone
Body      BUID 101 BaseId T_BODY
Weapon    BUID 102 BaseId T_WEAPON
Inventory BUID 103 BaseId T_INVENTORY
```

Pairing becomes:

```text
BodyPresenter      -> BUID 101
WeaponPresenter    -> BUID 102
InventoryPresenter -> BUID 103
```

This is a **first-slice constraint**, not the final universal cardinality/mapping rule. Clone-of-clone provenance, non-Unity authoring sources, and more complex composite mappings require an explicit stable authoring-slot/mapping contract that remains reconstructible from durable/imported facts.

The Reconciler must search only the declared delivery group, not arbitrarily walk outside it. Explicit durable BUID references may intentionally resolve outside according to their own resolver semantics.

Optional/static presentation-only GameObjects need no fake durable Bone merely because they exist in the delivered asset.

## 19.1 Manifest authoring / validation boundary

The runtime Reconciler should not invent stable pairing metadata by scanning names/paths after instantiation.

For Carbon-managed composite delivery, authoring/build/import should produce or validate the Component Manifest and its stable participant metadata before runtime use:

```text
Prefab / Scene authoring source
        ↓
discover declared Carbon-managed presenters
        ↓
assign/validate stable authored participant identity/mapping metadata
        ↓
emit Component Manifest on delivery container
        ↓
validate mapping against durable template/source expectations
```

If a delivery container has **zero Carbon-managed participants for the concern**, it does not need a fake empty manifest merely for conceptual purity.

The exact stable mapping schema remains implementation freedom beyond the constrained direct-template first proof, but runtime pairing must be deterministic and must not depend on mutable hierarchy names or arbitrary search outside the declared delivery group.

# 20. Reconciler ECS Pass: Step by Step

This is the practical system pass an implementation agent should be able to build.

## 20.1 `OnCreate`

The Reconciler creates/initializes:

- queries or target-partition access;
- Partition Bucket registry;
- Actual projection inventory;
- participant binding storage;
- dirty participant storage;
- pending async-operation storage;
- asset/Warehouse access;
- any pools;
- initial target revision/token watermarks.

No durable data is created here merely because the Reconciler exists.

## 20.2 Receive/observe target partition

The Reconciler sees a target partition such as:

```text
Concern = Prefab
Partition = Chunk A
Revision = 42
TargetToken = 991
Desired = [MarkerRoot 100, MarkerRoot 800, MarkerRoot 900]
```

## 20.3 Diff Desired vs Actual

For the same partition:

```text
Desired - Actual
    = realize

Desired ∩ Actual
    = retain / refresh / verify

Actual - Desired
    = retire
```

The Reconciler is not replaying historical events. It is converging current state.

The diff must compare **desired target state**, not only marker-root membership. A MarkerRoot that remains Desired but changes Barcode, provider/content resolution, required pairing metadata, or another concern-relevant target field may require refresh or replacement even though the occurrence key is unchanged. `TargetToken` exists to distinguish those target generations and to reject stale async work; it is not automatically the same thing as the durable coherence revision.

## 20.4 Realize new projection

For each new Desired marker root:

```text
read Representation Marker / Barcode
        ↓
resolve Delivery Package through Warehouse
        ↓
request load/instantiate/reuse
        ↓
Pending while no owned runtime occurrence exists
        ↓
actual GameObject/Scene occurrence is materially acquired/instantiated/adopted
        ↓
record Actual immediately
        ↓
inspect Component Manifest
        ↓
determine durable delivery group
        ↓
pair manifest participants to durable BUIDs
        ↓
create participant binding records
        ↓
Bind each presenter to BUID/context
        ↓
Hydrate required presenters from coherent ECS data
        ↓
stitch presenter relationships/services
        ↓
establish concern-specific Ready state when prerequisites are satisfied
        ↓
activate when the concern/integration requires it
```

**Actual is not Ready.** Dispatching an async acquisition only creates Pending work. Actual begins when the Reconciler materially owns/adopts the runtime occurrence, even if binding/Hydrate/readiness work is still incomplete.

## 20.5 Retain existing projection

For retained entries:

- verify delivery/package target has not changed;
- inspect target token/revision;
- inspect relevant generation invalidation;
- Hydrate only affected participants where useful;
- reevaluate Context Scope/service bindings after Move;
- repair divergence if runtime object disappeared unexpectedly.

For first-slice correctness, precise changed-BUID routing is optional. When a relevant coherent revision/target update is observed, a retained projection may simply compare each bound participant's current `DataGen` against `LastHydratedDataGen` and Hydrate only mismatches. Watcher/PublicationDelta hints can later narrow this further without changing semantics.

## 20.6 Retire projection

For entries no longer Desired:

```text
ensure required runtime-owned durable outcomes are already synchronized
        ↓
deactivate
        ↓
Unbind participant presenters
        ↓
invalidate participant handles
        ↓
release/pool/unload delivery container
        ↓
remove Actual entry
        ↓
release bucket-local scratch records
```

Cleanup is a downstream effect. Do not rely on teardown itself as the only opportunity to save required durable truth.

## 20.7 Cross-Reconciler prerequisites and readiness

Some concerns have real runtime dependencies, for example a Prefab projection that requires a Scene projection, or a child presenter that cannot become Ready before a parent/runtime service exists. Keep those dependencies explicit without creating one universal Carbon lifecycle FSM:

- each Reconciler owns its own concern-local Pending/Actual/provisioning/Ready state;
- Orchestrator/Marrow integration may sequence or gate cross-concern prerequisites;
- coherent Carbon durable publication remains valid regardless of downstream projection readiness;
- higher-level `SimulationReady`, `PresentationReady`, loading-screen readiness, or similar states belong to Marrow/host/integration policy, not durable Carbon authority;
- reverse teardown should respect real prerequisite relationships where needed.

This matters for the first Scene + Prefab proof: if the Prefab concern genuinely requires the owning Scene to be available, encode that prerequisite and let the Orchestrator/integration layer sequence it rather than relying on incidental Unity callback order.

## 20.8 Undesired does not always mean immediately releasable

A complete Desired set is authoritative for **what should currently exist**, but a Reconciler may temporarily retain an Actual occurrence while it performs required safe retirement work.

This is necessary when Desired changes for a non-durable reason, such as:

- Chunk residency/demand disappears;
- provider/content target changes;
- a projection is being replaced;
- host policy disables a concern;
- a target token supersedes the current delivery.

If the old runtime occurrence owns restoration-relevant dirty state:

```text
Desired no longer contains old target
        ↓
mark occurrence concern-locally PendingRetire / RetireBlocked
        ↓
stop new simulation/effect work that would extend the old target
        ↓
issue targeted runtime-sync/writeback request
        ↓
next sanctioned mutation/integration interval commits required outcomes
        ↓
on success:
    Unbind / release / remove Actual
on failure:
    preserve dirty + Actual ownership and follow retry/block/degrade policy
```

`PendingRetire` is an example concern-local journal state, not a universal Carbon lifecycle enum.

If the newest Desired target becomes valid again before release and the current Actual occurrence still satisfies it, the Reconciler may cancel retirement and retain/adopt the existing occurrence rather than churn it.

This distinction solves a subtle ordering problem: **non-durable residency changes do not need to lie about Desired just to keep an object alive long enough to save required outcomes**. Desired may truthfully become empty while Actual remains temporarily owned until safe release.

---

# 21. Binding Semantics

The old architecture used:

```csharp
Bind(Node context)
```

and the managed Node acted as both hierarchy object and lifecycle rendezvous point.

That object is gone.

The replacement is:

> **Reconciler-owned runtime pairing + presenter-held BUID/value metadata.**

The Reconciler owns the authoritative runtime answer to:

> Which presenter currently represents which durable BUID for this concern?

The presenter does not register itself into the Bone.

The durable Bone does not store a presenter reference.

The ECS entity does not become presenter identity.

## 21.1 Suggested Bind shape

```csharp
internal void Bind(
    BUID buid,
    ParticipantHandle handle)
{
    _boundBuid = buid;
    _participant = handle;
    OnBound(buid);
}
```

The exact protected hook may receive a narrow context/service accessor as well if the presenter genuinely needs contextual dependencies.

## 21.2 Entity resolution

Do not require presenters to persistently store a raw `Entity` handle.

When Hydrate/Dehydrate executes, the Reconciler can resolve:

```text
BUID
    ↓
Spine BUID -> Entity index
    ↓
current ECS Entity
```

and pass the current entity/data access into the operation.

This prevents BUID identity from being confused with World-local ECS handles and makes reload/world replacement easier.

## 21.3 Durable reference resolution and runtime linking

Binding a presenter to its own BUID is not the same thing as resolving all relationships that presenter or simulation may need.

A persisted durable reference is fundamentally a **BUID**. Relationship schema/context defines:

- expected durable type/role where relevant;
- whether local or cross-coherence resolution is legal;
- whether unresolved/cold state is acceptable;
- whether failure blocks a higher Marrow/integration condition.

Resolution layers:

```text
durable BUID reference
        ↓
local Spine/BUID resolver when target is materialized
        ↓
optional Persistence Catalog lookup when target is cold/unloaded
        ↓
queued/deduplicated/cancellable materialization if policy allows
        ↓
ephemeral runtime pointer/handle cache
```

Rules:

- Move preserves the durable BUID reference;
- runtime unload does not invalidate a valid durable reference;
- Delete leaves references to the terminated BUID unresolved/broken;
- Carbon never silently retargets a durable reference to a replacement occurrence;
- runtime resolved pointers are disposable caches and must be invalidated/re-resolved across reload or relevant context changes.

A **Persistence Catalog** is derived storage metadata mapping BUID to a persistence document/shard/location. It is not identity and does not grant permission to resolve an otherwise illegal relationship.

This durable-reference resolver is separate from `SystemHandle<T>`. `SystemHandle<T>` answers "which contextual service should I use here?"; a durable BUID reference answers "which durable occurrence does this relationship target?"

During Reconciler stitching, internal delivery-group links may be satisfied directly from manifest/BUID pairing. Cross-group or cold links use the durable-reference resolver according to the relationship's semantics.

The first one-Prefab vertical slice can defer cold materialization if all required links are local, but the architecture must preserve this seam.

---

# 22. Hydrate

Hydrate is targeted runtime synchronization.

It answers:

> Which coherent durable data must this runtime/engine-facing presenter copy into local state right now?

Examples:

- configure a Rigidbody;
- set Animator state/configuration;
- update mesh/material presentation;
- set audio properties;
- refresh a Unity-only cache.

Do not Hydrate data merely because it exists if the presenter reads it directly from ECS and keeps no separate representation.

## 22.1 Hydrate pass

```text
ParticipantBinding -> BUID
        ↓
resolve current Entity
        ↓
read BoneGenerations.Data
        ↓
if unchanged and no explicit refresh requirement
    skip
else
    read required durable components
    apply to runtime representation
    update participant hydration watermark
```

The Reconciler can perform targeted Hydrate on only the participant/Bone whose data changed, rather than refreshing an entire prefab group.

---

# 23. Dehydrate and Dirty Participation

Most ECS-native simulation data should already be durable and therefore need no copy-back.

Dehydrate exists for cases where Unity/runtime owns a restoration-relevant outcome temporarily.

Examples:

- Rigidbody result that must survive unload/save;
- ConfigurableJoint outcome;
- another engine-owned value not otherwise represented durably.

## 23.1 Dirty registration

Do not create a global universal dirty registry.

The owning Reconciler can maintain concern-local dirty participant sets, ideally partitioned by Context Scope.

A presenter may call:

```csharp
MarkDirty();
```

which identifies its Reconciler participant binding.

Conceptually:

```text
presenter
    ↓ ParticipantHandle
Reconciler
    ↓
Chunk A dirty set += participant 37
```

## 23.2 Dehydrate pass

```text
dirty participant
    ↓
participant binding -> BUID
    ↓
resolve current ECS Entity
    ↓
read runtime-owned result
    ↓
write authorized durable ECS components
    ↓
mark durable Data dirty / publish generation visibility
    ↓
clear runtime dirty state only after success
```

Failure must preserve pending/dirty state.

## 23.3 Prepare-for-publication handshake

A functional system needs one explicit handshake for destructive/freshness-sensitive transitions. It is not enough to say "Dehydrate happens sometime."

Before a transition would discard the only runtime copy of a required durable outcome, Carbon must provide an ordered **prepare-for-publication** phase. Typical triggers include:

- durable Delete of a represented occurrence;
- save that promises latest runtime outcomes;
- runtime scope unload/residency removal;
- reload/replacement of affected durable state.

A minimum implementation can use an ECS request/result buffer between the epoch driver and concern Reconcilers:

```csharp
public struct RuntimeSyncRequest : IBufferElementData
{
    public ulong RequestId;
    public BUID ScopeOrSubject;
    public RuntimeSyncReason Reason;
}

public struct RuntimeSyncResult : IBufferElementData
{
    public ulong RequestId;
    public RuntimeSyncStatus Status;
}
```

Execution order:

```text
Coordinator/host identifies a transition requiring fresh runtime outcomes
        ↓
enqueue/issue the transient RuntimeSyncRequest inside the sanctioned integration interval before destructive commit/release
        ↓
relevant Reconciler partition/scope buckets flush matching dirty participants
        ↓
write durable ECS outcomes during sanctioned write interval
        ↓
report success/failure
        ↓
only on permitted success policy:
    commit Delete / snapshot / release scope
```

For the earliest manifestation prototype, this machinery may be deferred if the test presenters hold **no unique restoration-relevant runtime state**. It becomes mandatory as soon as the vertical slice claims Dehydrate, save freshness, or destructive unload correctness.

There are two timing cases:

1. **Known durable destructive transition before publication** such as Delete/reload replacement: stage/fence the destructive commit and integrate required outcomes before the publication that would remove/replace the durable target.
2. **Derived runtime retirement after publication** such as residency loss/provider replacement: Desired may become empty immediately, but Reconciler keeps the old Actual occurrence in a concern-local pending-retirement barrier until the next sanctioned writeback succeeds, then releases it.

Do not force both cases into one fake global lifecycle phase.

## 23.4 Physical scheduling of writeback

The normal Reconciler provisioning/Hydrate pass occurs against settled durable truth and must not casually mutate authoritative ECS payload during that read-side reconciliation update. Dehydrate/writeback belongs inside the bounded sanctioned mutation/integration interval.

For the first functional implementation, use an explicit writeback bridge such as:

```text
Prefab/Scene Reconciler systems
    own dirty participant registries + runtime object references
            ↓
CarbonPrepareForPublicationSystem : SystemBase
    runs inside sanctioned mutation/integration interval
    asks only relevant Reconciler partitions to flush dirty participants
            ↓
targeted Dehydrate writes authorized durable ECS payload
            ↓
BoneDataDirty / generation visibility recorded
            ↓
publication may proceed
```

The writeback system is an integration adapter, not a second owner of projection or durable truth. A host-driven callback into the Reconciler systems during the same sanctioned interval is also acceptable if simpler.

For a Delete that would otherwise reclaim an occurrence before required runtime outcomes are secured, the Coordinator may validate/collapse and **stage** the destructive result, the prepare/writeback step integrates any outcomes that genuinely must survive elsewhere, and the destructive commit is finalized before coherent publication. Exact physical sub-system ordering is implementation as long as no reader sees a partial state and required outcomes are not lost.

---

# 24. Reconciler Partitions and Scope-Owned Cleanup

A Reconciler should partition Actual/pending/binding scratch state by the lifetime/selection partition that makes cleanup cheap, preferably the owning Context Scope where those semantics align.

For example:

```text
PrefabReconcilerSystem
├── WorldPartition(World A / scope-backed)
├── RegionProjectionPartition(Region 1 / if needed)
├── ChunkScopeBucket(Chunk 10)
├── ChunkScopeBucket(Chunk 11)
└── ChunkScopeBucket(Chunk 12)
```

Each bucket may own:

```text
ProjectionEntries
ParticipantBindings
DirtyParticipants
PendingOperations
Local target watermark
Local managed runtime references
```

## 24.1 Chunk unload

When Chunk A becomes nonresident:

```text
Driver/residency truth changes
        ↓
Desired for Chunk A becomes empty
        ↓
Context Scope runtime host marks Chunk A retiring
        ↓
stop accepting/starting new Chunk A local work
        ↓
Reconciler:
    cancel/invalidate stale pending target-token work
    mark owned Actual entries for retirement
        ↓
if required dirty outcomes exist:
    keep affected Actual entries owned but quiesced
    request targeted writeback during sanctioned mutation/integration
        ↓
after required writeback succeeds:
    unbind presenters
    release/pool Unity objects and Warehouse leases
    remove Actual/pending/binding records
        ↓
once all scope-owned Reconciler/scoped-system retirement barriers clear:
    clear Chunk A bucket(s)
    dispose Chunk runtime scope instance wholesale
```

Durable Chunk/Bone data remains unless a separate durable Delete occurred.

This is the key power of scope-owned scratch memory: cleanup is ownership-shaped instead of search-shaped. It is also why runtime-scope disposal must wait for concern-local retirement barriers rather than assuming `Desired == empty` means every runtime object can be destroyed immediately.

---

# 25. Structural Move and Cascading Context Reevaluation

Move is the most important operation for proving the architecture.

Example:

```text
Before
Chunk A
└── Zombie X

After
Chunk B
└── Zombie X
```

Durably:

```text
BUID X unchanged
BoneParent changes A -> B
```

Coordinator commits that change and updates structural generations/indexes.

Watcher publishes/localizes:

```text
X moved
old path affected
new path affected
```

Then each concern independently rederives what it owns.

Possible consequences:

```text
navigation cache
    rebind Chunk provider

audio context
    re-resolve provider

AI scoped system
    transfer/remove/add local working record

Prefab Reconciler
    move/adopt binding between relevant partition buckets
    OR reprovision if representation/delivery eligibility changed

Scene Reconciler
    reevaluate if scene ownership/delivery changed
```

Crucially:

> Move does not mean "call every system and unregister/register manually."

The structural change is durable truth. Contextual systems discover the new truth and update their own disposable state.

This intentionally replaces endpoint-managed subscription graphs with scope-owned discovery and rederivation.

---

# 26. "Spawn" Becomes Durable Add + Derived Realization

The architecture should stop treating runtime spawning as the authoritative operation.

Old style:

```text
SpawnZombie()
    instantiate prefab
    register AI
    register navigation
    register audio
    pair entity
    bind
    hydrate
    activate
```

New style:

```text
domain/Marrow requests "create Zombie under Chunk A"
        ↓
creation/clone materializer selects trusted durable source/template
        ↓
detached clone plan:
    fresh BUIDs
    immediate BaseId provenance
    internal durable references remapped
    external durable references preserved
    payload + Representation Markers copied/stamped
        ↓
Coordinator validates/commits generic multi-Bone Add + initial data
        ↓
coherent publication
        ↓
Watcher sees new durable truth
        ↓
Driver/Residency + Orchestrator see relevant Representation Marker / demand
        ↓
Prefab Desired set contains Zombie group
        ↓
Prefab Reconciler manifests the prefab
        ↓
scoped systems discover the durable Zombie from their own concern queries
```

This indirection is intentional.

It enables:

- batching;
- collapse/coalescing;
- concern independence;
- coherent publication;
- easier reload;
- easier multiplayer/server integration;
- removal of event-woven manual registration order.

---

# 27. End-to-End Functional Vertical Slice

This is the minimum complete scenario the implementation should demonstrate.

This section intentionally shows the **bootstrap/test path**, where privileged code may create the initial durable ECS records before Spine indexing. Once runtime operation begins, ordinary structural creation/movement/deletion follows the sanctioned path:

```text
domain/tool structural intent
        ↓
Coordinator validate + collapse + commit
        ↓
coherent publication
        ↓
Watcher localization
        ↓
Driver demand + Residency Solver + concern Filter/query
        ↓
Orchestrator publishes complete Desired
        ↓
Reconciler converges runtime projection
```

## Step 1: create a Unity ECS World

Install Carbon's system groups/systems.

Suggested rough order:

```text
CarbonMutationGroup
    CoordinatorSystem / structural staging
    CarbonPrepareForPublicationSystem (only targeted writeback when required)

CarbonPublicationGroup
    generation/coherence publication

CarbonObservationGroup
    WatcherSystem

CarbonResidencyGroup
    Driver/ResidencySolverSystem

CarbonDerivationGroup
    OrchestratorSystem / concern Filter selection

CarbonReconciliationGroup
    SceneReconcilerSystem
    PrefabReconcilerSystem
```

The host decides when the overall Carbon epoch runs. Exact PlayerLoop mapping is integration detail. During initial bootstrap, systems that depend on coherent Spine state should remain **inert/suspended** until the initial durable records are validated, Spine indexes are built, and the coherent baseline is established. Installing system instances before durable reification is fine; allowing them to act on a half-built hierarchy is not.

## Step 2: create durable Bones

For a raw bootstrap/test, create ECS entities directly through a privileged builder/import path:

```text
World Bone
Region Bone -> parent World
Chunk Bone -> parent Region
Zombie Root -> parent Chunk
Zombie Body -> parent Zombie Root
```

Give every Bone a unique BUID.

Add a Prefab Representation Marker to Zombie Root.

Add authored BaseId/provenance to composite descendants if the manifest needs pairing.

## Step 3: build/materialize Spine indexes

`SpineTopologySystem` scans Bone entities and builds:

```text
BUID -> Entity
ParentBUID -> children
```

Validate:

- unique BUIDs;
- legal parents;
- roots;
- no cycles.

## Step 4: establish coherent baseline

Initialize generation/coherence state.

Watcher records baseline/watermarks. New downstream consumers are now allowed to baseline from the current coherent state even if this initial settlement produces no incremental Watcher delta.

## Step 5: gather Driver demand

Runtime/Marrow determines current demand, for example the player's current/adjacent Chunks or server-simulated Chunks. Demand is transient and may change without a durable Carbon mutation.

## Step 6: Residency Solver selects eligible Chunks/population

For current Marrow entity residency, use Chunk as the default practical selection unit. The solver produces the current resident/eligible Chunk set.

## Step 7: Orchestrator + Prefab Filter derive Desired

Compose:

```text
resident Chunk population
+
Spine population beneath those Chunks
+
Prefab Representation Marker query
+
Prefab Reconciler concern/interest
```

and publish one complete unioned/deduplicated target partition for that concern/scope.

## Step 8: Prefab Reconciler diffs

Desired contains ZombieRoot. Actual does not.

Result: begin realizing the Zombie projection.

## Step 9: resolve delivery by Barcode

The Representation Marker's Barcode goes to Asset Warehouse.

Warehouse resolves the Prefab delivery product/handle.

## Step 10: request/acquire/reuse prefab

Before an owned runtime occurrence exists, the work is Pending.

When the GameObject is materially instantiated/acquired/adopted, the Reconciler records it in **Actual immediately**, even though it is not Ready yet.

## Step 11: read Component Manifest

Manifest exposes CarbonBehaviour presenters and authored pairing metadata/AssetIds.

## Step 12: pair presenters to Bones

For the constrained direct-template-clone MVP:

```text
manifest AssetId -> authored/template source BUID
                 -> live Bone whose BaseId is that source
                 -> live BUID
```

Create participant bindings in the owning Context Scope/Chunk Reconciler bucket.

## Step 13: Bind

Each presenter receives its live durable BUID plus optional participant handle/context access.

No managed Bone object is created.

## Step 14: Hydrate

Resolve BUID -> current Entity and apply required durable components to Unity-facing state.

## Step 15: stitch, establish Ready, and activate

Resolve presenter relationships/services, satisfy concern prerequisites, mark the concern-local occurrence Ready when appropriate, and activate the delivered runtime instance.

At this point the durable Zombie has manifested into the Unity scene.

# 28. Functional Simulation Loop After Manifestation

A runtime frame can now use both data-oriented and Unity-oriented execution.

## ECS-native logic

```text
AI / gameplay ECS systems
    read/write durable components directly
```

No Hydrate/Dehydrate ceremony is needed for data that remains entirely in ECS.

## Presenter/Unity logic

A presenter may:

- use Unity physics;
- animate;
- render;
- play audio;
- maintain derived local state.

If durable ECS data changes externally:

```text
publication
    ↓
Watcher
    ↓
Orchestrator / Reconciler invalidation
    ↓
targeted Hydrate
```

If Unity produces a restoration-relevant durable result:

```text
presenter MarkDirty
    ↓
Reconciler local dirty set
    ↓
Dehydrate during sanctioned synchronization
    ↓
durable ECS write
    ↓
next coherent publication
```

## 28.1 Runtime structural feedback closes the loop through intent

Unity/runtime simulation may also discover a **semantic structural fact**, for example:

- a trigger detects that an entity crossed into another Chunk/Zone;
- gameplay decides an occurrence should be destroyed;
- a runtime interaction requests creation of a new durable occurrence.

The runtime projection must not directly reparent/delete/create durable Bones as a side effect.

Correct loop:

```text
Unity/runtime observation
        ↓
domain/Marrow interprets semantic consequence
        ↓
RequestMove / RequestDelete / creation request
        ↓
Coordinator or creation-materialization + Coordinator
        ↓
next coherent durable publication
        ↓
downstream rederivation/reconciliation
```

This preserves the same architecture whether the initiating fact came from ECS simulation, MonoBehaviour code, physics callbacks, networking, editor tooling, or server input.

The important split is:

```text
engine callback
    may originate intent

durable commit
    establishes truth

Reconciler
    manifests the resulting truth
```

---

# 29. Scene Representations at World / Region / Chunk Layers

The same Representation Marker + Reconciler mechanism should work at multiple hierarchy levels.

Example:

```text
World Bone
[SceneRepresentation: WorldScene]
        ↓
World SceneReconciler bucket

Region Bone
[SceneRepresentation: RegionScene]
        ↓
Region SceneReconciler bucket

Chunk Bone
[SceneRepresentation: ChunkScene]
        ↓
Chunk SceneReconciler bucket
```

This creates layered realization without baking "World means Scene" or "Region means Scene" into Spine semantics.

A Region may exist durably with no loaded Region Scene.

A Chunk may exist durably while its runtime projection is unloaded.

Representation intent, residency, durable existence, and Context Scope remain separate axes.

In particular, putting a `SceneRepresentation` marker on a Region does **not** make every Region a Context Scope, and durable Region presence does **not** itself request the Region Scene. The Scene becomes Desired only when the applicable Driver/Residency/Filter policy for that Scene concern selects it.

## 29.1 Scene adoption

Scene delivery may produce Carbon-managed presenters that already physically exist as part of a loaded Scene rather than requiring prefab-style instantiation.

The Scene Reconciler should:

```text
Scene becomes Desired
        ↓
acquire/load Scene delivery
        ↓
discover Component Manifest / scene participants
        ↓
adopt materially existing runtime occurrence(s) into Actual
        ↓
pair to durable BUIDs
        ↓
Bind / Hydrate / stitch
        ↓
Ready / activate according to concern policy
```

Adoption is still Reconciler ownership. A scene-authored GameObject does not become durable authority merely because it existed before binding, and Actual may precede Ready.

---

# 30. Reload / Rebuild Contract

Reload is the architecture stress test.

Correct sequence conceptually:

```text
stop/suspend affected runtime work
        ↓
cancel/invalidate pending async work that cannot survive reload
        ↓
flush required runtime-owned durable outcomes
        ↓
discard/unbind affected transient projections
        ↓
load candidate durable state into staging
        ↓
resolve TypeKey/schema versions
migrate supported older data
preserve unknown optional data where safe
reject required unknown/migration-failed state
        ↓
validate Spine/coherence invariants
        ↓
install/replace durable ECS state and establish coherent publication
        ↓
rebuild Spine indexes from durable Bone records
        ↓
rebuild Context Scope transient systems/caches
        ↓
rebuild Persistence Catalog / durable-reference runtime caches as applicable
        ↓
Watcher establishes new settled baseline
        ↓
Orchestrator rederives Desired from current truth + current demand/provider state
        ↓
Reconcilers reconstruct runtime projection from scratch
        ↓
higher host/Marrow policy enables simulation when its requirements are met
```

No old managed Bone wrapper or presenter binding is required to survive reload.

## 30.1 Shutdown / restart contract

Shutdown is the reverse side of bootstrap and must not rely on Unity destruction callbacks to preserve truth.

Recommended sequence:

```text
stop accepting new local/scoped/domain work
        ↓
freeze or invalidate new Desired/acquisition work as host policy requires
        ↓
cancel pending async work or advance tokens so late completions are stale
        ↓
integrate restoration-relevant provisional outcomes before their runtime owners disappear
        ↓
establish/persist final coherent durable truth if shutdown policy requires a save
        ↓
let Reconcilers release/cancel runtime projections and Warehouse leases
        ↓
dispose Context Scope runtime instances and scratch memory
        ↓
detach SystemHandles/subscriptions/pools/registrations that could point into old scope state
        ↓
destroy remaining process/ECS runtime infrastructure
```

If shutdown policy intentionally abandons unsaved state, that is explicit host policy. It must not be confused with successful durable synchronization.

Restart follows the normal bootstrap/reload path from durable truth. No stale async completion, runtime pointer, scope registration, or presenter binding from the previous instance may be trusted.

---

# 31. Persistence Minimum Contract

Persistence serializes coherent durable Carbon truth, not the Unity object graph. A single-World vertical slice may snapshot one coherence scope. A general Marrow save should bundle independently coherent scope snapshots/revisions rather than inventing one forced global revision.

A practical ECS-native path for each included scope is:

```text
choose save freshness policy
        ↓
if latest required runtime outcomes are needed:
    request targeted writeback during sanctioned mutation/integration
    establish the resulting coherent publication/revision
else:
    select the already-current coherent durable revision explicitly
        ↓
select durable Carbon entities from that coherent revision
        ↓
copy to isolated snapshot/staging World if needed
        ↓
serialize snapshot World
        ↓
atomic file replacement
```

Do **not** Dehydrate after choosing the revision and then serialize that older revision as if it included the writeback. The saved revision must identify the coherent durable state actually being serialized.

On load:

```text
load staging World
validate Spine invariants
install/replace durable Carbon set
rebuild indexes
publish new coherent state
rederive runtime projections
```

Do not clear an entire live ECS World if it also contains runtime/system infrastructure; replace only the durable Carbon population or use a controlled staging/swap mechanism.

Generation/change stamps are rebuildable acceleration metadata, not durable semantic truth. A persistence format may retain them as an optimization if useful, but load correctness must not depend on preserving their historical numeric values; they may be reinitialized/rebuilt together with observer baselines. The ordered coherence revision used for a saved coherent snapshot is a separate concept.

The snapshot selection must also distinguish **durable ECS state from transient ECS-hosted machinery**. Target-partition entities, pending-operation records, dirty/request buffers, reconciliation state, derived child buffers/indexes, and similar scratch data must not become persisted authority merely because they happen to live in the same Unity ECS World. Either exclude them from the snapshot query, copy only explicitly durable components/entities into the snapshot World, or strip/rebuild them on load. Representation Markers and actual durable Bone payload remain part of durable truth; Reconciler journals and derived acceleration structures do not.

## 31.1 Persisted TypeKey / schema migration contract

Persisted durable component/type identity is separate from BUID occurrence identity.

Conceptually each persisted durable payload/record kind needs:

```text
TypeKey
    stable persisted type/schema identity
SchemaVersion
    version of the encoded durable shape
```

`TypeKey` must not depend architecturally on C# class name, namespace, or assembly-qualified runtime type name.

Load/import flow:

```text
stored TypeKey + SchemaVersion
        ↓
known current type?
    yes -> migrate older supported version deterministically
    no optional -> preserve opaque data where safely possible
    no required -> block coherent publication
migration failure for required data -> block coherent publication
```

Representation Marker data uses the same schema/version architecture rather than inventing a marker-only migration mechanism.

## 31.2 Persistence Catalog and cold materialization

A derived **Persistence Catalog** may map:

```text
BUID -> persistence document / shard / location
```

It is rebuildable storage metadata, not identity and not relationship authority.

It exists so a valid durable reference can remain meaningful when its target is not currently materialized in the active ECS population. Materialization requests may be queued, deduplicated, and cancellable.

The first vertical slice can keep the complete test World materialized and defer this service, but persistence/reference code must not assume every valid BUID target is always loaded.

## 31.3 PublicationDelta vs CarbonPatch

Keep observation acceleration separate from semantic state transport:

```text
PublicationDelta / ChangeSet
    transient/localizes what changed in one publication
    optional accelerator
    loss is recoverable from current truth

CarbonPatch
    semantic durable state transition / transport artifact
    may carry BaseRevision / TargetRevision preconditions
    useful for networking, persistence tooling, merge, or external synchronization
```

A network/server/editor patch therefore enters through validated sanctioned durable integration and then rejoins the ordinary publication -> observation -> Desired -> reconciliation flow. It never becomes a parallel runtime authority path.

---

# 32. Failure Semantics Needed for a Functional System

## Invalid Spine state

Examples:

- duplicate BUID;
- missing parent;
- structural cycle;
- illegal cross-coherence parentage.

Result:

- fail coherent materialization/publication;
- surface diagnostics;
- optionally enter explicit repair tooling.

Do not silently reinterpret invalid records.

## Missing delivery asset

Durable truth remains valid.

Reconciler records projection failure/divergence and may retry/substitute according to concern/integration policy. A projection declared **required** by Marrow/integration may block or degrade the relevant higher-level readiness condition; an optional projection need not. That policy does not retroactively invalidate the already-coherent durable Carbon publication.

Do not delete or rewrite durable Carbon because a Prefab is missing.

## Manifest pairing failure

Projection cannot become Ready.

Keep failure explicit, rollback/release partial runtime acquisition if appropriate, and leave durable truth unchanged.

## Async target changed while load was pending

Every async operation needs a target token/version.

On completion:

```text
completion token == current target token?
    yes -> adopt result
    no  -> release/cancel stale result
```

## Dehydrate failure

Do not clear dirty/pending state.

If unload/delete/save requires the result, follow explicit policy: retry, block, fail, or degrade. Never silently discard the only copy of required durable outcome.

## Durable reference resolution failure

A cold/unresolved durable BUID reference does not become a different identity.

- optional unresolved relation may remain unresolved according to schema/integration policy;
- required relation may block the relevant higher Marrow/integration readiness condition;
- deleted target stays broken/unresolved;
- wrong type/illegal cross-coherence resolution produces structured failure;
- never silently retarget.

## Schema/migration failure

Required unknown data or failed required migration prevents coherent publication of the affected durable scope.

Unknown optional data should be preserved/round-tripped where safely possible rather than silently discarded.

## Runtime divergence

If a Unity object/Scene is externally destroyed or unloaded while durable truth still requires it:

```text
Actual runtime probe/ownership check fails
        ↓
record divergence
        ↓
remove/repair invalid Actual runtime ownership record
        ↓
reconverge from newest Desired truth
```

This is not durable Delete.

If the unexpectedly destroyed runtime object held the only copy of an uncommitted required outcome, that outcome may be unrecoverable; surface a hard diagnostic rather than pretending Carbon reconstructed data it never received.

## Scope retirement failure

A Context Scope runtime host must not dispose its scope-local scratch/state while a required Reconciler retirement/writeback barrier is unresolved. Policy may retry, block teardown, or explicitly degrade/abandon only where the higher integration contract allows it.

## Structured diagnostics minimum

A cold-start implementation should make failures traceable without depending on ad hoc log strings.

Where applicable include:

- BUID / subject identity;
- coherence scope + coherence revision;
- structural request/operation ID;
- Representation Concern;
- marker root;
- Barcode;
- Desired target token / pending operation token;
- Context Scope / partition key;
- Reconciler provisioning stage;
- TypeKey + stored/target schema version for migration failures;
- failure/rejection reason and causal correlation ID.

Logging/UI/export format is implementation. The required property is that structural rejection, publication failure, unresolved references, stale async work, projection divergence, and writeback failure can be correlated back to the durable/current target state that produced them.

---

# 33. Performance Guidance

## 33.1 Avoid one managed object per Bone

The central reason for removing the old managed Node/Bone tree is to avoid scaling managed allocations and pointer-heavy traversal with every durable occurrence.

Prefer:

```text
ECS durable records
+
unmanaged/rebuildable indexes
```

## 33.2 Avoid one managed binding object per presenter

Use existing MonoBehaviour state plus value-type handles/BUIDs and Reconciler-owned tables.

## 33.3 Keep hierarchy work incremental

Do not rebuild the entire child index every frame when only a handful of structural changes occurred.

Support both:

```text
full rebuild
    startup/reload/repair/testing

incremental maintenance
    normal Add/Move/Delete
```

## 33.4 Scope-partition transient work

Configured Context-Scope-backed buckets and explicit concern-local projection partitions improve:

- cleanup;
- locality;
- cancellation;
- parallel planning;
- dirty-set size;
- debugging;
- ownership clarity.

## 33.5 Use tree for hierarchy, ECS for throughput

Do not walk the Spine for work that is naturally a dense component query.

Do not flatten every structural question into global ECS searches.

## 33.6 Distinguish Carbon structural change from ECS structural change

Carbon Move is a structural semantic operation, but changing `BoneParent` data does not necessarily change ECS archetype composition.

Add/Delete and component-type add/remove are actual ECS structural changes and may create sync/chunk-movement costs.

Batch those deliberately.

---

# 34. Recommended Physical System Set for the First Vertical Slice

The following is an **optimization-oriented target shape**, not a requirement to begin with. For the first functioning implementation it is acceptable, and arguably safer, to use `SystemBase` for several core systems so they can share a Unity-ECS-World-local `SpineRuntimeSystem` through straightforward managed system references while still scheduling Burst jobs over native data. Convert pure systems to `ISystem` after the data contracts and dependency boundaries are proven.

```text
SpineRuntimeSystem : SystemBase initially; possible ISystem later
    owns BUID index + child index
    rebuilds/maintains topology
    exposes read-only native Spine views to trusted Carbon systems

CoordinatorSystem : SystemBase or ISystem
    owns structural request intake
    validates/collapses
    commits Add/Move/Delete
    may stage destructive results that require pre-publication runtime integration
    updates topology/generation change summaries

CarbonPrepareForPublicationSystem : SystemBase
    runs only inside sanctioned mutation/integration interval
    bridges to concern Reconciler dirty registries for targeted Dehydrate/writeback
    lets staged destructive work finalize only under the selected success policy

CarbonPublicationSystem : ISystem
    consolidates dirty generations
    advances coherence revision
    finalizes published change metadata

WatcherSystem : ISystem
    observes settled revision/gens/change summaries
    publishes changed working set

MarrowResidencySolverSystem : ISystem or SystemBase
    consumes Driver/observer demand
    selects transient eligible Chunk/population sets for current Marrow policy
    remains Marrow-specific rather than generic Spine/Carbon semantics

ContextScopeRuntimeHost : SystemBase or host service
    creates/registers configured transient runtime scope instances
    rebuilds scope-local scratch from coherent durable state
    marks scopes retiring and waits for retirement/writeback barriers
    disposes scoped systems/caches/handles only when safe

OrchestratorSystem : ISystem
    combines current/changed durable truth + eligible population + concern Filters
    produces exact target partitions per Reconciler concern

PrefabReconcilerSystem : SystemBase
    owns managed Prefab runtime inventory
    owns partition buckets/bindings/dirty/pending
    resolves Warehouse packages
    manifests/pairs/binds/hydrates/releases

SceneReconcilerSystem : SystemBase
    same convergence model for Scene delivery

CreationCloneMaterializer : host/domain service or ECS-integrated subsystem
    resolves trusted durable template/source data
    prepares detached multi-Bone clone plans with fresh BUIDs/BaseIds/ref remap
    submits generic structural/data proposal for Coordinator commit

DurableReferenceResolver / PersistenceCatalog : later service when cold refs are enabled
    resolves BUID relationships locally or through persistence location/materialization
    maintains only rebuildable runtime lookup state
```

This is a recommendation, not a metaphysical requirement. System boundaries may later merge/split after profiling if responsibilities stay intact.

---

# 35. Minimum API Sketch

## Spine

```csharp
bool TryResolve(BUID id, out Entity entity);
BUID GetParent(BUID id);
ChildEnumerable GetChildren(BUID id);
SubtreeEnumerable GetSubtree(BUID id);
AncestorEnumerable GetAncestors(BUID id);
bool TryFindNearestContextScope(BUID id, out BUID scope);
```

## Coordinator

```csharp
AddTicket RequestAdd(AddRequest request);
void RequestMove(BUID subject, BUID newParent);
void RequestDelete(BUID subject, DeleteMode mode);
```

## Presenter

```csharp
internal void Bind(BUID buid, ParticipantHandle handle);
internal void Hydrate(Entity entity, EntityManager em);
internal void Unbind();
```

Only participants that actually need runtime copy-back require a Dehydrate seam.

```csharp
interface IDehydrateParticipant
{
    void Dehydrate(Entity entity, EntityManager em);
}
```

The final public presenter API should probably hide raw `EntityManager` from ordinary third-party code behind typed/narrow component access, but raw access is acceptable for the first proof if it accelerates implementation and is kept behind the Carbon presentation boundary.

---

# 36. Missing Decisions That Must Be Made During Implementation

The architecture is sufficient for a functional prototype, but the following are still implementation choices.

## Spine storage

- exact `BoneTag` necessity;
- exact `BoneIdentity` packing;
- `NativeParallelMultiHashMap` vs dynamic child buffers vs packed adjacency;
- exact root encoding;
- exact scope accelerator layout.

## Generation mechanics

- stamp type/width;
- ancestor propagation strategy;
- direct-write dirty API;
- conservative ECS change-version fallback.

## Coordinator

- exact structural request layout;
- BUID mint timing for Add;
- DeleteLeaf vs DeleteSubtree naming;
- cycle-validation algorithm;
- request result/failure reporting;
- exact ECB vs direct `EntityManager` commit split.

## Creation / clone materialization

Architecture semantics are settled, but implementation still chooses:

- how a domain creation request selects a durable source/template or creation recipe;
- where detached clone staging lives;
- exact representation of source-BUID -> clone-BUID remap table;
- how multi-Bone Add + initial payload staging is handed to Coordinator;
- how trusted template validation results are cached/reused;
- how generic clone machinery composes with Marrow-specific emission/spawn semantics.

## Orchestrator

- exact interest-contract encoding;
- exact target-set transport;
- residency/demand provider interface;
- target partition key.

## Context Scopes

- generic `ContextScopeTag` vs game-specific role components;
- exact runtime scope-host/registry representation;
- exact active/retiring scope state representation;
- higher-scope recursive bucket teardown;
- how scoped-system retirement waits on multiple Reconciler barriers;
- whether partition-bucket allocators/arenas are used.

## Representation / Manifest

- exact Representation Marker component types;
- exact `Barcode` encoding/type;
- exact manifest slot schema;
- exact stable authored presenter-slot -> durable-part mapping beyond the constrained direct-template proof;
- optional participant semantics;
- cross-Chunk composite delivery policy.

## Reconciler

- exact Actual/Pending/Ready state data;
- exact concern-local pending-retirement/release-barrier representation;
- retry/cancellation policy;
- pooling policy;
- divergence repair;
- managed/unmanaged split;
- participant-handle layout;
- target token implementation;
- Warehouse lease/provider version tracking.

## Dehydrate

- exact dirty participant registry;
- exact prepare-for-publication integration before Delete/save/unload;
- failure policy per integration case.

## Persistence

- exact snapshot file format;
- staging World lifecycle;
- atomic replacement implementation;
- `TypeKey` encoding/registry layout;
- schema migration dispatch and opaque unknown-data preservation format;
- Persistence Catalog storage/index layout;
- CarbonPatch serialization/transport details when that feature is implemented.

## Durable references

- exact relationship schema API;
- local vs cold resolver cache layout;
- materialization request queue/deduplication/cancellation;
- runtime pointer invalidation/re-resolution strategy;
- structured unresolved/broken-link diagnostics.

## Diagnostics / shutdown

- structured diagnostic transport and correlation IDs;
- scope/revision/BUID/concern/Barcode/target-token fields;
- exact shutdown fencing/cancellation mechanism;
- timeout/degrade policy for unresolved retirement barriers.

None of these require reintroducing a managed Bone tree or changing the core authority model.

---

# 37. Implementation Order

A cold-start agent should build in this order.

## Phase A: Spine proof

1. Define BUID-compatible Bone structural ECS components.
2. Implement `SpineTopologySystem` full rebuild.
3. Implement BUID -> Entity lookup.
4. Implement Parent -> Children index.
5. Implement roots, ancestry, children, subtree traversal.
6. Implement structural invariant validator.
7. Add randomized hierarchy/fuzz tests.
8. Prove all indexes can be deleted and rebuilt identically.

## Phase B: structural mutation

9. Implement Coordinator request intake.
10. Implement Add.
11. Implement Move.
12. Implement explicit Delete semantics.
13. Implement cycle/legal-parent validation.
14. Implement request collapse, including the distinction between internal non-terminal Remove and true Delete.
15. Implement incremental topology maintenance.
16. Implement StructureGen/SubtreeGen updates.

**Before treating normal runtime creation as solved**, add the detached creation/clone materialization proof: select a trusted source subtree, mint fresh BUIDs, set immediate BaseIds, remap internal references, preserve external references, and atomically submit the resulting multi-Bone structural/data proposal.

## Phase C: coherent observation

17. Implement payload dirty seam/DataGen.
18. Implement coherence revision.
19. Implement structural/payload publication summary.
20. Implement Watcher baseline + changed population.

## Phase D: scope, demand, residency, and desired-state derivation

21. Define Context Scope metadata and application/game scoped-system composition.
22. Implement the transient Context Scope runtime host/registry with active + retiring Chunk scope behavior.
23. Define one concern-specific Representation Marker carrying/resolving a Barcode.
24. Implement Driver demand input.
25. Implement Marrow Chunk-based Residency Solver selection for the first entity-residency proof.
26. Create/rebuild the Chunk runtime scope before enabling scope-dependent work.
27. Implement Orchestrator + concern Filter selection.
28. Publish exact complete unioned/deduplicated target partitions with target tokens.

## Phase E: first manifestation

29. Implement minimal Asset Warehouse Barcode lookup with explicit Reconciler-owned handle/lease lifetime.
30. Implement `PrefabReconcilerSystem : SystemBase`.
31. Implement scope-local Desired/Pending/Actual/provisioning state.
32. Request and materially acquire one Prefab from one Representation Marker.
33. Record the acquired occurrence as Actual before Ready.
34. Implement Component Manifest discovery.
35. Implement the constrained direct-template `AssetId -> source BUID -> live BaseId/BUID` pairing proof; document that general stable authoring-slot mapping remains open.
36. Implement presenter Bind.
37. Implement Hydrate.
38. Stitch prerequisites, establish concern-local Ready, activate, and prove the object appears in the scene.
39. Remove demand and prove the occurrence enters a safe pending-retirement path before release when dirty state exists.

## Phase F: runtime synchronization

40. Add presenter dirty registration.
41. Implement targeted Dehydrate.
42. Implement concern-local pending-retirement/writeback barrier.
43. Close the runtime structural-feedback loop: runtime/domain event -> Coordinator structural intent.
44. Move a represented Bone between Chunks and prove contextual/bucket reevaluation.
45. Unload a Chunk and prove safe scope retirement + bucket teardown without durable Delete.
46. Delete a represented Bone and prove pre-publication runtime-outcome handling, durable identity termination, and downstream release.

## Phase G: resilience

47. Add async target tokens/cancellation and provider/lease invalidation behavior.
48. Add missing-asset/manifest-failure and runtime-divergence repair handling.
49. Add reload from durable ECS data with schema migration + complete projection reconstruction.
50. Add persistence snapshot, including per-coherence-scope composition semantics.
51. Add durable BUID reference resolver seam; if cold refs are in scope, add Persistence Catalog/materialization queue.
52. Add shutdown/restart fencing: stop work, cancel/stale async, flush required outcomes, release projections, dispose scopes, detach handles.
53. Add structured diagnostics for mutation/publication/reconciliation/reference/schema failures.
54. Run architecture-conformance + performance benchmarks.

# 38. Definition of a Functional First Milestone

The architecture is functionally proven when the following demonstration works:

1. Start with an empty Unity ECS World.
2. Install Carbon systems/runtime services.
3. Create a World -> Region -> Chunk -> Zombie durable Bone hierarchy.
4. Rebuild Spine indexes from ECS records.
5. Query that hierarchy correctly.
6. Put a Prefab Representation Marker carrying/resolving a Barcode on Zombie root.
7. Supply Driver demand that makes the Zombie's Chunk required.
8. Residency Solver marks/selects that Chunk as eligible/resident for the current Marrow policy.
9. Orchestrator + Prefab concern Filter publish Zombie in the complete Prefab Desired set.
10. Prefab Reconciler resolves the Barcode and starts acquisition as Pending work.
11. Once the runtime occurrence is materially acquired/instantiated/adopted, it becomes Actual while provisioning may continue.
12. Component Manifest discovers several presenters in that Prefab.
13. The constrained first-slice mapping pairs those presenters deterministically to several live durable Bones.
14. Presenters Bind by live BUID and Hydrate from current ECS data.
15. Required stitching/prerequisites complete, the occurrence becomes concern-locally Ready, and the runtime object activates in the Unity scene.
16. Change durable ECS data and observe targeted Hydrate.
17. Produce one runtime-owned dirty result and successfully Dehydrate it to ECS.
18. Move the Zombie to another Chunk and observe scope/context reevaluation without changing BUID.
19. Unload the destination Chunk and release all its runtime projection/binding scratch state while durable data remains.
20. Reload/re-enable the Chunk and reconstruct the same runtime representation from durable truth.
21. Delete the Zombie and confirm its BUID is terminated and all downstream representation disappears.
22. Delete every transient Spine/Reconciler cache, rebuild from durable ECS data, and recover equivalent logical/runtime state.

If this works, Carbon has crossed the boundary from architecture into a functioning data-to-manifestation system.

## 38.1 Extended flow-completeness gates

The first milestone above intentionally proves one mostly local vertical slice. Before claiming the **general runtime architecture** is complete, also prove:

1. **Normal live composite creation:** a Marrow/domain creation request clones a trusted multi-Bone source set, creates fresh BUIDs/BaseIds, remaps internal refs, preserves external refs, and commits through Coordinator without directly instantiating presentation.
2. **Dynamic Context Scope activation:** entering a resident Chunk creates/rebuilds configured scope-local runtime systems/caches only after coherent durable state exists.
3. **Safe derived retirement:** demand/provider change removes an occurrence from Desired while dirty; Reconciler keeps it quiesced/owned until targeted writeback succeeds, then releases it and scope teardown completes.
4. **Runtime structural feedback:** a Unity/physics/zone event produces domain structural intent and the resulting Move/Delete/Add becomes visible only after sanctioned durable publication.
5. **Provider invalidation:** Barcode stays constant while provider/content target changes; target token changes, stale completion is rejected/released, and Reconciler converges without a Carbon durable revision.
6. **Runtime divergence:** an externally destroyed runtime object is detected and re-realized from current Desired without deleting durable truth.
7. **Schema load:** older supported schema migrates before publication; unknown optional data round-trips; required unknown/migration failure blocks publication.
8. **Durable link behavior:** Move preserves a BUID ref, Delete leaves it broken, and a cold target can remain valid unresolved or materialize through the Persistence Catalog when that feature is enabled.
9. **Shutdown/restart:** outstanding async work cannot leak into the next scope/session, required provisional outcomes are integrated before disposal, and restart reconstructs from durable truth.
10. **External integration ingress:** a validated network/server/editor/CarbonPatch change joins the same sanctioned mutation/publication path rather than mutating runtime projection in parallel.

# 39. Final Recommended Mental Model

The system should be understood as six stacked layers plus explicit feedback.

```text
LAYER 0: SOURCE / CREATION
authoring tools, validated durable templates, creation recipes
clone/materialization produces detached durable proposals
fresh BUIDs, BaseId provenance, reference remap

            ↓ sanctioned commit into

LAYER 1: DURABLE FACTS
ECS entities + durable Carbon components
BUID, parentage, payload, references, markers

            ↓ interpreted as

LAYER 2: SPINE
logical hierarchy + rebuildable indexes
meaning, ancestry, scopes, pruning

            ↓ coherently changed/observed by

LAYER 3: CONTROL / DERIVATION
Coordinator -> Publication -> Watcher
Driver demand -> Residency Solver -> Context Scope runtime host
concern Filter/query -> Orchestrator
mutation, settlement, localization, eligibility, runtime-scope lifetime, complete Desired derivation

            ↓ consumed by

LAYER 4: CONTEXTUAL WORKING STATE
scope-owned systems, caches, target sets, binding buckets,
retirement barriers, transient link/service caches
all disposable/rebuildable

            ↓ realized by

LAYER 5: PROJECTION
Reconcilers, Warehouse leases, delivery packages, manifests, presenters,
GameObjects, Scenes, physics/audio/rendering

            ↘ runtime feedback
              payload outcomes -> targeted sanctioned writeback
              structural facts -> domain intent -> Coordinator
```

The deepest rule is:

> **Durable truth says what exists and where. Everything else discovers, interprets, caches, simulates, or represents that truth.**

The second deepest rule is:

> **Runtime consequences are derived from durable change rather than being manually orchestrated by the endpoint that requested the change.**

That is why "spawn" can collapse toward durable Add, why Move can cause contextual reevaluation and, where required, rebinding, why Chunk teardown can dispose whole buckets of transient state, and why runtime representation can be reconstructed after unload/reload without preserving a managed node graph.

---

# 40. Source and Authority Notes

This document synthesizes the current Carbon/Marrow owner handoffs, NodeTree/Spine implementation reviews, and Unity Entities 1.4 local reference material discussed during the architecture session.

Important authority anchors reflected here include:

- `CARBON-FINAL-OWNER-CLARIFICATION-RESOLUTION-2026-08-11.md`
  - Barcode/BUID/BaseId identity separation;
  - composition-driven Context Scope system installation;
  - Chunk as Marrow default entity residency unit;
  - multi-coherence save composition and final implementation-freedom boundaries.

- `CARBON-CANONICAL-MASTER-HANDOFF-FINAL-AUDITED-2026-08-10.md`
  - logical tree vs durable ECS authority;
  - Coordinator / Watcher / Orchestrator / Reconciler responsibilities;
  - structural Add / Move / Delete;
  - direct payload writes;
  - Representation Marker / delivery-group semantics;
  - Context Scope and scoped transient state.

- `CARBON-PART1-FINAL-CANONICAL-OWNER-HANDOFF-2026-08-10.md`
  - direct logical hierarchy query;
  - dense ECS hot views;
  - disposable indexes and Reconciler inventories;
  - runtime unload distinct from Delete;
  - clone semantics, BUID remapping, and BaseId provenance;
  - durable BUID reference categories and `SystemHandle<T>` separation.

- `CARBON-NODE-TREE-FOCUSED-IMPLEMENTATION-KB-2026-08-11.md`
  - BUID-backed durable hierarchy;
  - canonical parentage;
  - rebuildable child indexes;
  - read/query/traversal API;
  - fuzz/invariant expectations.

- `CARBON-FINAL-ARCHITECTURE-KB-OWNER-HANDOFF.md`
  - Reconciler-owned runtime realization, pairing, binding, Hydrate, stitching, Actual inventory, and safe reversal;
  - targeted Hydrate/Dehydrate semantics.

- `CARBON-CANONICAL-MASTER-HANDOFF-FINAL-AUDITED-2026-08-10.md`
  - durable-reference cold resolution / Persistence Catalog;
  - schema `TypeKey` + migration semantics;
  - authoring/template compilation boundary;
  - bootstrap/reload/shutdown ordering;
  - provider invalidation and scene-adoption/divergence behavior.

- Unity Entities 1.4.8 local docs/source workspace
  - `ISystem` / `SystemBase` distinction;
  - SystemAPI/query/job mechanisms;
  - tag components;
  - structural-change/ECB behavior;
  - transform hierarchy's use of parent/child derived traversal structures as an implementation reference.

Where this document specifies concrete C# structs, Native container choices, target-partition buffers, value-type binding handles, the constrained first-slice AssetId/source-BUID pairing, or exact system-type recommendations, those should be read as **recommended minimum functional implementation choices** unless/until they are separately promoted into canonical KB decisions.
