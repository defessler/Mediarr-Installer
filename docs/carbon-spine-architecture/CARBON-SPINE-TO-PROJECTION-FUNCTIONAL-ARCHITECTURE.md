# Carbon Spine-to-Projection Functional Architecture Handoff

**Status:** implementation-oriented synthesis of the current Carbon/Marrow architecture discussions and KB decisions  
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
- all runtime indexes, binding tables, Reconciler inventories, pending operations, and Context-Scope-local caches are disposable and must be rebuildable from durable truth.

The core flow is:

```text
semantic intent / loaded durable data
            ↓
       durable ECS state
            ↓
           Spine
      hierarchy + indexes
            ↓
     coherent publication
            ↓
          Watcher
      changed population
            ↓
       Orchestrator
   current truth + demand
            ↓
   exact complete Desired
            ↓
        Reconciler
            ↓
 delivery → manifest → pairing
            ↓
     Bind → Hydrate → stitch
            ↓
        Unity projection
```

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
- Representation Markers;
- generation/change metadata needed by Carbon's observation contract.

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

A **Bone** is one durable Carbon structural occurrence.

It is not necessarily a C# object. In the intended implementation it is fundamentally an ECS entity carrying the required Carbon structural components.

## Spine

The **Spine** is Carbon's logical durable hierarchy over Bones.

Recommended definition:

> **Spine is Carbon's authoritative logical hierarchy over ECS-backed Bones, where durable identity and parentage define structure, rebuildable indexes provide efficient traversal, and normal structural mutation is committed through the Coordinator.**

## BUID

Canonical durable occurrence identity.

Rules:

- BUID identifies the durable occurrence;
- Move preserves BUID;
- Delete terminates BUID;
- runtime unload does not terminate BUID;
- ECS `Entity` is not a substitute for BUID;
- a runtime ECS entity handle may be cached as an acceleration handle but is not durable identity.

## BaseId / authored part identity

A stable template/asset-local identity used to relate a cloned durable occurrence back to an authored/template part.

This is useful for pairing Component Manifest participants to the correct live BUID inside a composite delivery group.

Conceptually:

```text
Asset presenter slot AssetId = WEAPON
        ↓ matches
Durable Bone BaseId = WEAPON
        ↓ resolves to
live BUID = 8F3...
```

The presenter binds to the resulting live BUID, not permanently to the BaseId.

## Context Scope

A meaningful hierarchy location that owns contextual runtime lifetime and working state.

Typical Marrow examples:

```text
World
Region
Chunk
```

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

## Delivery Package

The logical content/package selected by a Representation Marker and resolved through the Asset Warehouse.

A package may produce:

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

A non-root must point at an existing legal parent in the same permitted structural/coherence domain.

## 3.1 Recommended supporting structural metadata

A practical prototype should also include:

```csharp
public struct BoneGenerations : IComponentData
{
    public uint Structure;
    public uint Data;
    public uint Subtree;
}
```

The exact integer width and stamping algorithm remain implementation choices.

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

`BaseId` is particularly valuable for composite asset pairing.

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
    = intentional root

Parent == X but BUID X does not exist
    = invalid/orphan structural record
```

An invalid orphan must not silently become a root.

The materialization/rebuild layer should:

- report it;
- refuse coherent publication if the structural state is invalid, unless an explicit repair mode is active;
- optionally expose privileged repair primitives.

## 6.3 Hard architecture test

The defining Spine test is:

> Delete every transient Spine cache/index/view. Given only the durable ECS-backed Bone records, reconstruct exactly the same logical hierarchy.

If this cannot be done, some supposedly transient state has become hidden authority.

## 6.4 Shared access to Spine indexes

A practical ECS implementation needs an explicit answer to a non-architectural but critical question:

> How do Coordinator, Watcher, Orchestrator, and Reconcilers access the same rebuildable Spine indexes without each rebuilding a private copy?

For the first functional implementation, use a **World-local Spine runtime owner**. The simplest shape is a managed ECS `SystemBase` that owns native containers and can hand trusted Carbon systems lightweight read-only views of those containers.

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

This is **one World-level runtime service**, not one managed object per Bone. It therefore does not reintroduce the allocation pattern that motivated removal of the managed Node tree.

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
    Delete
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
enter sanctioned mutation interval
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

Examples:

```text
Add -> Remove before publication
    => no final durable occurrence

Add -> Move
    => Add at final parent

Move -> Delete
    => Delete

multiple Moves
    => final Move target
```

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

Both must be visible correctly by the next coherent publication.

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
structural commit + direct payload writes
        ↓
targeted prepare-for-publication work when required
        ↓
close mutation interval
        ↓
advance coherent publication revision
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

The Spine runtime owner should therefore retain enough **derived shadow information** to verify that its indexes still match current durable parentage. A simple first implementation is:

```text
BUID -> last indexed ParentBUID
```

On full rebuild, populate that shadow alongside the child index. During normal Coordinator commits, update it incrementally. After a privileged replacement/reload, force a full rebuild. Optionally use ECS change versions or query-count/index-count checks as a broad signal that verification is needed.

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

The output is an accelerator for current-state rederivation, not authoritative history.

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
└── Region contexts

Region Context
├── Region-scoped systems
├── Region projection bucket
├── Region scratch
└── Chunk contexts

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

## 12.2 Chunk partition recommendation

For Marrow, per-Chunk buckets are especially attractive for entity-level runtime projections because Chunk is already a natural Context Scope and unload unit.

However, the system must also support higher layers:

```text
World Representation Marker -> World Scene
Region Representation Marker -> Region Scene
Chunk Representation Marker -> Chunk Scene / local projections
```

Therefore use a **generic Context-Scope-keyed bucket model**, with Chunk as the normal fine-grained partition for entity/runtime realization.

---

# 13. Orchestrator

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

## 13.1 Conceptual selection pipeline

```text
coherent durable Spine/ECS state
        +
Watcher changed subset / generation pruning
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

## 13.2 Complete Desired means replacement semantics

A Reconciler should not depend on receiving every historical add/remove event.

For an explicit partition:

```text
World X / Chunk A / Prefab concern / Revision 41
```

the Desired set is the complete current target for that partition.

Missing prior updates therefore converge naturally on the next target set.

## 13.3 Target-set transport: functional MVP

A concrete ECS-friendly implementation can use target-partition entities:

```csharp
public struct ReconcilerTargetPartition : IComponentData
{
    public BUID Scope;
    public ulong Revision;
    public ulong TargetToken;
}

public struct DesiredProjectionRecord : IBufferElementData
{
    public BUID MarkerRoot;
    public DeliveryKey Package;
}
```

Use one partition entity per concern/scope partition, or another equivalent structure with unambiguous replacement semantics.

The exact transport can later become native containers, chunked arrays, or direct system handoff.

---

# 14. Representation Markers and Delivery Groups

A Representation Marker is durable metadata on a root for one concern.

Example conceptual components:

```csharp
public struct PrefabRepresentation : IComponentData
{
    public DeliveryKey Package;
}

public struct SceneRepresentation : IComponentData
{
    public DeliveryKey Package;
}
```

Exact naming/encoding is implementation-specific.

## 14.1 Delivery group

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

## 14.2 Many-to-many delivery

Do not assume one Bone equals one prefab.

The architecture permits:

```text
one delivery package -> many durable BUIDs
one durable BUID -> several concern-specific packages
```

This is why the Reconciler needs both **delivery-instance records** and **participant-to-Bone bindings**.

---

# 15. Asset Warehouse

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
DeliveryHandle Resolve(DeliveryKey key);
```

where `DeliveryHandle` can expose the concern-specific Prefab/Scene acquisition information.

---

# 16. Reconciler as an ECS System

Yes, a Reconciler can and should be implemented as an ECS system where that improves integration with Carbon's ECS data and scheduling.

Important distinction:

> "A Reconciler is physically implemented as an ECS system" is **not** the retired old idea of a universal architectural "System Reconciler" concern. The Reconciler concern remains concern-specific; ECS system is simply its implementation host.

## 16.1 `ISystem` vs `SystemBase`

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

## 16.2 Persistent scratch memory between updates

An ECS system can retain state between update calls.

A Prefab Reconciler `SystemBase` can own, for example:

```text
scope buckets
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

# 17. Reconciler Runtime Data Model

Do not create a managed `BoneBinding` class per bind merely to replace the old managed Node object.

The binding relationship is required. A binding heap object is not.

Recommended two-level Actual model:

```text
Scope Bucket
    ↓
Projection Entries
    ↓
Participant Bindings
```

## 17.1 Projection Entry

Represents one delivered runtime container/group.

Conceptually:

```csharp
struct ProjectionEntry
{
    BUID MarkerRoot;
    DeliveryKey Package;
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

## 17.2 Participant Binding

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

## 17.3 Presenter-local state

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

# 18. Component Manifest Pairing

When a Representation Marker causes a composite Prefab/Scene to be delivered, the Reconciler must answer:

> Which presenter inside this asset represents which durable Bone?

The manifest solves **discovery**. Pairing still must be explicit/deterministic.

Functional MVP pairing rule:

```text
presenter authored AssetId
        ↓
match durable descendant BaseId inside this delivery group
        ↓
resolve that descendant's live BUID
        ↓
bind presenter to live BUID
```

Example:

```text
Zombie prefab
├── BodyPresenter      AssetId BODY
├── WeaponPresenter    AssetId WEAPON
└── InventoryPresenter AssetId INVENTORY

Durable group
ZombieRoot BUID 100 BaseId ROOT
├── Body      BUID 101 BaseId BODY
├── Weapon    BUID 102 BaseId WEAPON
└── Inventory BUID 103 BaseId INVENTORY
```

Pairing becomes:

```text
BodyPresenter      -> BUID 101
WeaponPresenter    -> BUID 102
InventoryPresenter -> BUID 103
```

The Reconciler must search only the declared delivery group, not arbitrarily walk outside it.

Optional/static presentation-only GameObjects need no fake durable Bone merely because they exist in the delivered asset.

---

# 19. Reconciler ECS Pass: Step by Step

This is the practical system pass an implementation agent should be able to build.

## 19.1 `OnCreate`

The Reconciler creates/initializes:

- queries or target-partition access;
- Scope Bucket registry;
- Actual projection inventory;
- participant binding storage;
- dirty participant storage;
- pending async-operation storage;
- asset/Warehouse access;
- any pools;
- initial target revision/token watermarks.

No durable data is created here merely because the Reconciler exists.

## 19.2 Receive/observe target partition

The Reconciler sees a target partition such as:

```text
Concern = Prefab
Scope = Chunk A
Revision = 42
TargetToken = 991
Desired = [MarkerRoot 100, MarkerRoot 800, MarkerRoot 900]
```

## 19.3 Diff Desired vs Actual

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

## 19.4 Realize new projection

For each new Desired marker root:

```text
read Representation Marker
        ↓
resolve Delivery Package through Warehouse
        ↓
load/instantiate/reuse delivery container
        ↓
record Pending until operation actually completes
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
establish readiness
        ↓
activate
        ↓
record Actual from observed successful completion
```

Do not mark something Actual/Ready merely because an async request was dispatched.

## 19.5 Retain existing projection

For retained entries:

- verify delivery/package target has not changed;
- inspect target token/revision;
- inspect relevant generation invalidation;
- Hydrate only affected participants where useful;
- reevaluate Context Scope/service bindings after Move;
- repair divergence if runtime object disappeared unexpectedly.

## 19.6 Retire projection

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

---

# 20. Binding Semantics

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

## 20.1 Suggested Bind shape

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

## 20.2 Entity resolution

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

---

# 21. Hydrate

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

## 21.1 Hydrate pass

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

# 22. Dehydrate and Dirty Participation

Most ECS-native simulation data should already be durable and therefore need no copy-back.

Dehydrate exists for cases where Unity/runtime owns a restoration-relevant outcome temporarily.

Examples:

- Rigidbody result that must survive unload/save;
- ConfigurableJoint outcome;
- another engine-owned value not otherwise represented durably.

## 22.1 Dirty registration

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

## 22.2 Dehydrate pass

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

## 22.3 Prepare-for-publication handshake

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
publish RuntimeSyncRequest before destructive commit/release
        ↓
relevant Reconciler scope buckets flush matching dirty participants
        ↓
write durable ECS outcomes during sanctioned write interval
        ↓
report success/failure
        ↓
only on permitted success policy:
    commit Delete / snapshot / release scope
```

For the earliest manifestation prototype, this machinery may be deferred if the test presenters hold **no unique restoration-relevant runtime state**. It becomes mandatory as soon as the vertical slice claims Dehydrate, save freshness, or destructive unload correctness.

---

# 23. Scope Buckets and Cleanup

A Reconciler should partition Actual/pending/binding scratch state by Context Scope.

For example:

```text
PrefabReconcilerSystem
├── WorldScopeBucket(World A)
├── RegionScopeBucket(Region 1)
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

## 23.1 Chunk unload

When Chunk A becomes nonresident:

```text
stop accepting/starting Chunk A local work
        ↓
flush required dirty runtime outcomes
        ↓
Desired for Chunk A becomes empty / bucket removed
        ↓
retire all Chunk A projections
        ↓
unbind presenters
        ↓
release/pool Unity objects
        ↓
cancel/invalidate pending target-token work
        ↓
clear Chunk A bucket wholesale
```

Durable Chunk/Bone data remains unless a separate durable Delete occurred.

This is the key power of scope-owned scratch memory: cleanup is ownership-shaped instead of search-shaped.

---

# 24. Structural Move and Cascading Context Reevaluation

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
    move binding between scope buckets
    OR reprovision if representation/delivery eligibility changed

Scene Reconciler
    reevaluate if scene ownership/delivery changed
```

Crucially:

> Move does not mean "call every system and unregister/register manually."

The structural change is durable truth. Contextual systems discover the new truth and update their own disposable state.

This intentionally replaces endpoint-managed subscription graphs with scope-owned discovery and rederivation.

---

# 25. "Spawn" Becomes Durable Add + Derived Realization

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
Add durable Zombie under Chunk A
        ↓
Coordinator commits Add
        ↓
Watcher sees new durable truth
        ↓
Orchestrator sees relevant Representation Marker / demand
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

# 26. End-to-End Functional Vertical Slice

This is the minimum complete scenario the implementation should demonstrate.

## Step 1: create a Unity ECS World

Install Carbon's system groups/systems.

Suggested rough order:

```text
CarbonMutationGroup
    CoordinatorSystem

CarbonPublicationGroup
    generation/coherence publication

CarbonObservationGroup
    WatcherSystem

CarbonDerivationGroup
    OrchestratorSystem

CarbonReconciliationGroup
    SceneReconcilerSystem
    PrefabReconcilerSystem
```

The host decides when the overall Carbon epoch runs. Exact PlayerLoop mapping is integration detail.

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

Watcher records baseline/watermarks.

## Step 5: identify active Context Scopes / demand

Runtime/Marrow determines that the World/Region/Chunk is currently active/resident.

This demand is not durable identity and may change independently.

## Step 6: Orchestrator derives Prefab Desired

It combines:

```text
active Chunk
+
Spine population beneath it
+
Prefab Representation Marker query
+
Prefab Reconciler concern
```

and publishes an exact target partition.

## Step 7: Prefab Reconciler diffs

Desired contains ZombieRoot. Actual does not.

Result: realize Zombie projection.

## Step 8: resolve delivery

Representation Marker's DeliveryKey goes to Asset Warehouse.

Warehouse returns the Prefab delivery handle/source.

## Step 9: instantiate/reuse prefab

Acquire a GameObject instance.

The operation remains Pending until actual completion is observed.

## Step 10: read Component Manifest

Manifest exposes CarbonBehaviour presenters and authored slot/AssetIds.

## Step 11: pair presenters to Bones

Within the Zombie delivery group:

```text
manifest AssetId
    -> durable BaseId
    -> live BUID
```

Create participant bindings in the Chunk's Reconciler bucket.

## Step 12: Bind

Each presenter receives its live durable BUID plus optional participant handle/context access.

No managed Bone object is created.

## Step 13: Hydrate

Resolve BUID -> current Entity and apply required durable components to Unity-facing state.

## Step 14: stitch and activate

Resolve presenter relationships/services, establish readiness, activate the delivered runtime instance.

## Step 15: record Actual

Only now is the realized occurrence recorded as materially Actual/Ready according to concern-specific state.

At this point the durable Zombie has manifested into the Unity scene.

---

# 27. Functional Simulation Loop After Manifestation

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

---

# 28. Scene Representations at World / Region / Chunk Layers

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

---

# 29. Reload / Rebuild Contract

Reload is the architecture stress test.

Correct sequence conceptually:

```text
stop/suspend affected runtime work
        ↓
flush required runtime-owned durable outcomes
        ↓
discard/unbind affected transient projections
        ↓
replace/load coherent durable ECS state through staging/validated path
        ↓
rebuild Spine indexes from durable Bone records
        ↓
rebuild Context Scope transient systems/caches
        ↓
Watcher establishes new settled baseline
        ↓
Orchestrator rederives Desired from current truth
        ↓
Reconcilers reconstruct runtime projection from scratch
```

No old managed Bone wrapper or presenter binding is required to survive reload.

---

# 30. Persistence Minimum Contract

Persistence serializes coherent durable Carbon truth, not the Unity object graph.

A practical ECS-native path is:

```text
reach coherent revision
        ↓
perform required targeted Dehydrate for freshness policy
        ↓
select durable Carbon entities
        ↓
copy to isolated snapshot/staging World if needed
        ↓
serialize snapshot World
        ↓
atomic file replacement
```

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

---

# 31. Failure Semantics Needed for a Functional System

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

Reconciler records projection failure/divergence and may retry/substitute according to concern policy.

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

---

# 32. Performance Guidance

## 32.1 Avoid one managed object per Bone

The central reason for removing the old managed Node/Bone tree is to avoid scaling managed allocations and pointer-heavy traversal with every durable occurrence.

Prefer:

```text
ECS durable records
+
unmanaged/rebuildable indexes
```

## 32.2 Avoid one managed binding object per presenter

Use existing MonoBehaviour state plus value-type handles/BUIDs and Reconciler-owned tables.

## 32.3 Keep hierarchy work incremental

Do not rebuild the entire child index every frame when only a handful of structural changes occurred.

Support both:

```text
full rebuild
    startup/reload/repair/testing

incremental maintenance
    normal Add/Move/Delete
```

## 32.4 Scope-partition transient work

Chunk/Region/World buckets improve:

- cleanup;
- locality;
- cancellation;
- parallel planning;
- dirty-set size;
- debugging;
- ownership clarity.

## 32.5 Use tree for hierarchy, ECS for throughput

Do not walk the Spine for work that is naturally a dense component query.

Do not flatten every structural question into global ECS searches.

## 32.6 Distinguish Carbon structural change from ECS structural change

Carbon Move is a structural semantic operation, but changing `BoneParent` data does not necessarily change ECS archetype composition.

Add/Delete and component-type add/remove are actual ECS structural changes and may create sync/chunk-movement costs.

Batch those deliberately.

---

# 33. Recommended Physical System Set for the First Vertical Slice

The following is an **optimization-oriented target shape**, not a requirement to begin with. For the first functioning implementation it is acceptable, and arguably safer, to use `SystemBase` for several core systems so they can share a World-local `SpineRuntimeSystem` through straightforward managed system references while still scheduling Burst jobs over native data. Convert pure systems to `ISystem` after the data contracts and dependency boundaries are proven.

```text
SpineRuntimeSystem : SystemBase initially; possible ISystem later
    owns BUID index + child index
    rebuilds/maintains topology
    exposes read-only native Spine views to trusted Carbon systems

CoordinatorSystem : SystemBase or ISystem
    owns structural request intake
    validates/collapses
    commits Add/Move/Delete
    updates topology/generation change summaries

CarbonPublicationSystem : ISystem
    consolidates dirty generations
    advances coherence revision
    finalizes published change metadata

WatcherSystem : ISystem
    observes settled revision/gens/change summaries
    publishes changed working set

OrchestratorSystem : ISystem
    combines changed/current durable truth + scope/demand
    produces exact target partitions per Reconciler concern

PrefabReconcilerSystem : SystemBase
    owns managed Prefab runtime inventory
    owns scope buckets/bindings/dirty/pending
    resolves Warehouse packages
    manifests/pairs/binds/hydrates/releases

SceneReconcilerSystem : SystemBase
    same convergence model for Scene delivery
```

This is a recommendation, not a metaphysical requirement. System boundaries may later merge/split after profiling if responsibilities stay intact.

---

# 34. Minimum API Sketch

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

# 35. Missing Decisions That Must Be Made During Implementation

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

## Orchestrator

- exact interest-contract encoding;
- exact target-set transport;
- residency/demand provider interface;
- target partition key.

## Context Scopes

- generic `ContextScopeTag` vs game-specific role components;
- exact creation/disposal system;
- higher-scope recursive bucket teardown;
- whether scope bucket allocators/arenas are used.

## Representation / Manifest

- exact Representation Marker component types;
- exact `DeliveryKey` / Barcode type;
- exact manifest slot schema;
- exact BaseId/AssetId pairing algorithm;
- optional participant semantics;
- cross-Chunk composite delivery policy.

## Reconciler

- exact Actual/Pending/Ready state data;
- retry/cancellation policy;
- pooling policy;
- divergence repair;
- managed/unmanaged split;
- participant-handle layout;
- target token implementation.

## Dehydrate

- exact dirty participant registry;
- exact prepare-for-publication integration before Delete/save/unload;
- failure policy per integration case.

## Persistence

- exact snapshot file format;
- staging World lifecycle;
- atomic replacement implementation;
- schema migration details.

None of these require reintroducing a managed Bone tree or changing the core authority model.

---

# 36. Implementation Order

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
14. Implement request collapse.
15. Implement incremental topology maintenance.
16. Implement StructureGen/SubtreeGen updates.

## Phase C: coherent observation

17. Implement payload dirty seam/DataGen.
18. Implement coherence revision.
19. Implement structural/payload publication summary.
20. Implement Watcher baseline + changed population.

## Phase D: scope and desired-state derivation

21. Define Context Scope metadata and runtime scope registry.
22. Define one concern-specific Representation Marker.
23. Implement simple residency/demand input.
24. Implement Orchestrator selection for that concern.
25. Publish exact complete target partitions.

## Phase E: first manifestation

26. Implement minimal Asset Warehouse lookup.
27. Implement `PrefabReconcilerSystem : SystemBase`.
28. Implement scope-local Actual bucket.
29. Instantiate one Prefab from one Representation Marker.
30. Implement Component Manifest discovery.
31. Implement AssetId/BaseId/BUID pairing.
32. Implement presenter Bind.
33. Implement Hydrate.
34. Activate and prove object appears in the scene.
35. Remove demand and prove clean release/unbind.

## Phase F: runtime synchronization

36. Add presenter dirty registration.
37. Implement targeted Dehydrate.
38. Move a represented Bone between Chunks and prove contextual/bucket reevaluation.
39. Unload a Chunk and prove bucket teardown without durable Delete.
40. Delete a represented Bone and prove durable identity termination + downstream release.

## Phase G: resilience

41. Add async target tokens/cancellation.
42. Add missing-asset/manifest-failure handling.
43. Add reload from durable ECS data with complete projection reconstruction.
44. Add persistence snapshot.
45. Run architecture-conformance + performance benchmarks.

---

# 37. Definition of a Functional First Milestone

The architecture is functionally proven when the following demonstration works:

1. Start with an empty Unity ECS World.
2. Install Carbon systems.
3. Create a World -> Region -> Chunk -> Zombie durable Bone hierarchy.
4. Rebuild Spine indexes from ECS records.
5. Query that hierarchy correctly.
6. Put a Prefab Representation Marker on Zombie root.
7. Mark Chunk as runtime-eligible/resident.
8. Orchestrator publishes Zombie in Prefab Desired.
9. Prefab Reconciler resolves a package and instantiates a Prefab.
10. Manifest pairs several presenters in that Prefab to several durable Bones.
11. Presenters Bind by BUID and Hydrate from current ECS data.
12. The runtime object becomes active in the Unity scene.
13. Change durable ECS data and observe targeted Hydrate.
14. Produce one runtime-owned dirty result and successfully Dehydrate it to ECS.
15. Move the Zombie to another Chunk and observe scope/context reevaluation without changing BUID.
16. Unload the destination Chunk and release all its runtime projection/binding scratch state while durable data remains.
17. Reload/re-enable the Chunk and reconstruct the same runtime representation from durable truth.
18. Delete the Zombie and confirm its BUID is terminated and all downstream representation disappears.
19. Delete every transient Spine/Reconciler cache, rebuild from durable ECS data, and recover equivalent logical/runtime state.

If this works, Carbon has crossed the boundary from architecture into a functioning data-to-manifestation system.

---

# 38. Final Recommended Mental Model

The system should be understood as five stacked layers.

```text
LAYER 1: DURABLE FACTS
ECS entities + durable Carbon components
BUID, parentage, payload, markers

            ↓ interpreted as

LAYER 2: SPINE
logical hierarchy + rebuildable indexes
meaning, ancestry, scopes, pruning

            ↓ coherently changed/observed by

LAYER 3: CONTROL
Coordinator -> Publication -> Watcher -> Orchestrator
mutation, settlement, localization, routing/desired derivation

            ↓ consumed by

LAYER 4: CONTEXTUAL WORKING STATE
scope-owned systems, caches, target sets, binding buckets
all disposable/rebuildable

            ↓ realized by

LAYER 5: PROJECTION
Reconcilers, delivery packages, manifests, presenters,
GameObjects, Scenes, physics/audio/rendering
```

The deepest rule is:

> **Durable truth says what exists and where. Everything else discovers, interprets, caches, simulates, or represents that truth.**

The second deepest rule is:

> **Runtime consequences are derived from durable change rather than being manually orchestrated by the endpoint that requested the change.**

That is why "spawn" can collapse toward durable Add, why Move can automatically cause contextual rebinding, why Chunk teardown can dispose whole buckets of transient state, and why runtime representation can be reconstructed after unload/reload without preserving a managed node graph.

---

# 39. Source and Authority Notes

This document synthesizes the current Carbon/Marrow owner handoffs, NodeTree/Spine implementation reviews, and Unity Entities 1.4 local reference material discussed during the architecture session.

Important authority anchors reflected here include:

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
  - runtime unload distinct from Delete.

- `CARBON-NODE-TREE-FOCUSED-IMPLEMENTATION-KB-2026-08-11.md`
  - BUID-backed durable hierarchy;
  - canonical parentage;
  - rebuildable child indexes;
  - read/query/traversal API;
  - fuzz/invariant expectations.

- `CARBON-FINAL-ARCHITECTURE-KB-OWNER-HANDOFF.md`
  - Reconciler-owned runtime realization, pairing, binding, Hydrate, stitching, Actual inventory, and safe reversal;
  - targeted Hydrate/Dehydrate semantics.

- Unity Entities 1.4.8 local docs/source workspace
  - `ISystem` / `SystemBase` distinction;
  - SystemAPI/query/job mechanisms;
  - tag components;
  - structural-change/ECB behavior;
  - transform hierarchy's use of parent/child derived traversal structures as an implementation reference.

Where this document specifies concrete C# structs, Native container choices, target-partition buffers, value-type binding handles, BaseId/AssetId pairing, or exact system-type recommendations, those should be read as **recommended minimum functional implementation choices** unless/until they are separately promoted into canonical KB decisions.
