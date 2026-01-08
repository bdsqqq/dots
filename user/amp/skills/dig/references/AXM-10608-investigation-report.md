# AXM-10608: single-dataset assumptions in axiom console

**authors**: investigation conducted via amp agents, answers provided by igor bedesqui  
**date**: 2026-01-07  

---

## summary

this document compiles findings from an investigation into single-dataset assumptions in the axiom console frontend. the investigation was triggered by olly's slack message regarding regions work.

---

## context

from olly's slack message ([link](https://watchlyhq.slack.com/archives/C03F7RUN10T/p1767733184455849)):

> with the new regions work, datasets can belong to different regions, we need to track ALL datasets in a query (like joins) → this will likely impact so much that its actually quite difficult

### apl multi-dataset syntax

apl (axiom processing language) supports two multi-dataset patterns:

- **union**: `['dataset-a'] | union ['dataset-b']`
- **join**: `['dataset-a'] | join (['dataset-b']) on field`

the syntax `['dataset-a', 'dataset-b']` was not found in [axiom apl docs](https://axiom.co/docs/apl/tabular-operators/overview) or manual testing (per [verification thread](https://ampcode.com/threads/T-019b9564-75c6-72ac-be8d-d8f1ed2422ba)). join is in public preview with limitations: inner join only, 50k row limits (per [axiom docs](https://axiom.co/docs/apl/tabular-operators/join-operator)).

---

## findings

### 1. backend returns array, frontend uses first element

igor ran a join query between `plain-support-agent-traces` and `plain-support-agent-feedback`. the response included:

```json
"datasetNames": ["plain-support-agent-feedback", "plain-support-agent-traces"]
```

the frontend extracts only the first element at these locations:

| location | code | effect |
|----------|------|--------|
| [DatasetStore.ts:1514](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/DatasetStore.ts#L1514) | `datasetNames[0]` | sets `selectedDatasetId` after query execution |
| [ElementsDatasetStore.ts:349](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/ElementsDatasetStore.ts#L349) | `datasetNames?.[0]` | determines which dataset's field metadata to use |
| [api.ts:250](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/util/api.ts#L250) | discards `datasetNames` | transforms query results for legacy Result type |

### 2. field types show as "unknown" for join queries

igor observed that join query results display most fields as "unknown" type in the UI. only `_time` retained its type.

the response included `"fieldsMetaMap": {}` (empty object). the cascade:

1. `fieldsMetaMap` is empty
2. [ElementsDatasetStore.ts:349](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/ElementsDatasetStore.ts#L349) sets `fieldsMeta = undefined`
3. [fields.ts:47-68](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/util/fields.ts#L47-L68) returns `{ name, type: undefined }` for each field
4. [EventsTableStore.ts:522](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/EventsTableStore.ts#L522) falls back to `type || 'unknown'`

**hunch** (unverified): the backend may not populate `fieldsMetaMap` for joins because the map is keyed by dataset name, and joined fields don't cleanly belong to a single dataset.

### 3. join queries return 500 in dashboards

igor observed a 500 response when attempting to add a join query to a dashboard.

no frontend validation was found that blocks joins. the frontend type system assumes singular datasets ([DashboardsStore.types.ts:77](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/DashboardsStore.types.ts#L77): `datasetId?: string`), but this would cause incorrect behavior, not HTTP errors. the 500 is likely backend rejection (unverified—no backend code was inspected).

### 4. permissions

igor confirmed: "apex handles permissions, you can only query datasets you have access to."

---

## where single-dataset assumptions exist

### stores (MobX)

a central root is `DatasetStore.selectedDatasetId: string | undefined` at [line 162](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/DatasetStore.ts#L162). query stores inherit from `DatasetStore`:

```
DatasetStore.selectedDatasetId (L162)
       ↓ inheritance
QueryViewStore extends DatasetStore
       ↓ 
ElementsDatasetStore uses QueryResult.datasetId
```

15 store files reference `selectedDatasetId` or `activeDataset` (per `grep -l "selectedDatasetId\|activeDataset" apps/console/src/dash/stores/*.ts`):
- [AnalyticsStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/AnalyticsStore.ts)
- [DashboardsStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/DashboardsStore.ts)
- [DatasetStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/DatasetStore.ts)
- [ElementsDatasetStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/ElementsDatasetStore.ts)
- [EventsTableStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/EventsTableStore.ts)
- [LogStreamChartStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/LogStreamChartStore.ts)
- [LogStreamStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/LogStreamStore.ts)
- [LogStreamViewStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/LogStreamViewStore.ts)
- [PieChartStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/PieChartStore.ts)
- [QueryViewStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/QueryViewStore.ts)
- [SettingsStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/SettingsStore.ts)
- [StatisticChartStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/StatisticChartStore.ts)
- [TableChartStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/TableChartStore.ts)
- [TimeSeriesChartStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/TimeSeriesChartStore.ts)
- [TopkChartStore.ts](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/dash/stores/TopkChartStore.ts)

### url parameters

**path parameters** (3 top-level routes with singular dataset params):
- [`/$orgId/stream/$datasetId`](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/routes/_authed/_org/%24orgId/stream/%24datasetId.tsx)
- [`/$orgId/datasets/$dataset`](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/routes/_authed/_org/%24orgId/%28datasets%29/datasets/%24dataset/route.tsx) (with nested field routes)
- [`/$orgId/settings/datasets/$datasetId`](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/routes/_authed/_org/%24orgId/settings/datasets/%24datasetId/route.tsx) (with nested modal routes)

**search parameters**:
- `did` — defined at [--route.utils.ts:8](file:///Users/bdsqqq/www/AXM-10608-investigate-dataset-tracking/apps/console/src/routes/_authed/_org/%24orgId/--route.utils.ts#L8). consumed by QueryViewStore, DashboardsStore, queryPageMachine.
- `traceDataset` — trace viewer context.

### components

39 component files reference `activeDataset` (see [appendix: component-files-activeDataset.md](./component-files-activeDataset.md) for full list). these span field pickers, filter chips, query form builders, dashboard editors, and the spotlight machine context.

---

## open questions

1. why was `selectedDatasetId` designed as singular? (igor joined march 2023, after these patterns were established—earliest commits referencing `selectedDatasetId` date to 2020 per git blame, see [git history analysis thread](https://ampcode.com/threads/T-019b954b-1d1d-718a-b981-84d477b761fb).)

2. is the dashboard 500 for joins intentional?

3. why does `fieldsMetaMap` return empty for joins?

4. will queries ever span regions?

---

## appendices

- [datasetNames-extraction-points.md](./datasetNames-extraction-points.md) — complete list of extraction points
- [fieldsMetaMap-investigation.md](./fieldsMetaMap-investigation.md) — field metadata flow and fallback logic
- [dashboard-join-limitation.md](./dashboard-join-limitation.md) — dashboard query submission analysis
- [url-params-dataset.md](./url-params-dataset.md) — complete URL parameter mapping
- [knowledge-gaps-resolved.md](./knowledge-gaps-resolved.md) — questions answered by igor
- [component-files-activeDataset.md](./component-files-activeDataset.md) — 39 component files referencing `activeDataset`

---

## acknowledgments

- igor bedesqui (@bdsqqq) — provided domain context, ran verification queries, answered knowledge gap questions
- olly — original slack message identifying the need

---

## related threads

all threads are workspace-visible.

### main threads

| thread | description |
|--------|-------------|
| [T-019b998c-25bf-701c-a493-f688af5bd144](https://ampcode.com/threads/T-019b998c-25bf-701c-a493-f688af5bd144) | multi-dataset tracking for regions work (consolidation) |
| [T-019b9544-b42b-75bf-af3f-c274d150217e](https://ampcode.com/threads/T-019b9544-b42b-75bf-af3f-c274d150217e) | map dataset assumption across codebase (main investigation) |

### initial analysis agents

| thread | description |
|--------|-------------|
| [T-019b954a-9af1-70b8-8d55-4cea02f744cf](https://ampcode.com/threads/T-019b954a-9af1-70b8-8d55-4cea02f744cf) | stores agent single-dataset assumption analysis |
| [T-019b954a-c4e5-76cd-8245-ec786aadbc78](https://ampcode.com/threads/T-019b954a-c4e5-76cd-8245-ec786aadbc78) | routes agent single-dataset assumption analysis |
| [T-019b954a-ee7d-774c-be66-2bdcfff25aaa](https://ampcode.com/threads/T-019b954a-ee7d-774c-be66-2bdcfff25aaa) | single-dataset assumption analysis in react components |
| [T-019b954b-1d1d-718a-b981-84d477b761fb](https://ampcode.com/threads/T-019b954b-1d1d-718a-b981-84d477b761fb) | git history analysis for single-dataset patterns |

### verification agents

| thread | description |
|--------|-------------|
| [T-019b9563-5760-73ef-a031-fc093c35ba7c](https://ampcode.com/threads/T-019b9563-5760-73ef-a031-fc093c35ba7c) | verify stores-analysis claims |
| [T-019b9563-860d-704f-b42a-8d4e1c2b8ec1](https://ampcode.com/threads/T-019b9563-860d-704f-b42a-8d4e1c2b8ec1) | fact-check routes-analysis claims |
| [T-019b9563-b0c9-716f-aa74-dd00a21b7870](https://ampcode.com/threads/T-019b9563-b0c9-716f-aa74-dd00a21b7870) | verify components analysis claims |
| [T-019b9564-5af0-72df-abad-75cff8000730](https://ampcode.com/threads/T-019b9564-5af0-72df-abad-75cff8000730) | verify git history claims |
| [T-019b9564-75c6-72ac-be8d-d8f1ed2422ba](https://ampcode.com/threads/T-019b9564-75c6-72ac-be8d-d8f1ed2422ba) | verify APL syntax and backend claims |
| [T-019b9566-c451-765d-a55c-016b596d481d](https://ampcode.com/threads/T-019b9566-c451-765d-a55c-016b596d481d) | verify components analysis claims |
| [T-019b9566-c47f-75de-9a05-476670f1a9f1](https://ampcode.com/threads/T-019b9566-c47f-75de-9a05-476670f1a9f1) | git history claims verification |
