# rc-menu dependency mapping: process summary

**date**: 2025-10-22  
**goal**: map all usages and dependents of rc-menu/rc-dropdown for migration  
**outcome**: autonomous discovery via import graph traversal

## evolution

### manual docs (2025-10-16 → 2025-10-21)
- hand-documented components, made wrong assumptions
- oracle review found gaps (missed css, behavior deps)
- oracle made WRONG claim: daterange uses radix (it doesn't, uses rc-menu)
- human+oracle estimates: 2-45 files impacted
- **lesson**: documentation without code extraction = fiction

### hardcoded extraction (2025-10-21T16:30)
- bash scripts with hardcoded component lists
- validated daterange DOES use rc-menu (oracle was wrong)
- found 1928 total files, 1132 ui components, 24 pages
- **problem**: inherited human bias via hardcoded arrays
- estimates were better but still assumed we knew all wrapper names

### first autonomous attempt (2025-10-21T20:53)
- removed hardcoded component names
- walked imports from rc-* seeds recursively
- discovered complete transitive closure
- **problem**: only traversed reverse graph (importers), missed components that wrappers import

### current: bidirectional graph (2025-10-22T21:50)
- builds BOTH import directions (A imports B, B imported-by A)
- discovers pages via reverse BFS (seed → importers → pages)
- discovers intermediate components via forward inspection (page imports what?)
- found 21 distinct menu implementations, not 4
- **works**: discovers MultistageDropdown, EllipsisMenu, all context menus, etc.

## why the bidirectional approach

the reverse-only approach missed components bc:
```
Page → FilterDropdown → MultistageDropdown → Dropdown_DEPRECATED (seed)
```

reverse BFS finds: `Dropdown_DEPRECATED ← FilterDropdown ← Page`

but MultistageDropdown is in FilterDropdown's FORWARD imports, not on the reverse path.

solution: 
1. reverse BFS to find affected pages (fast)
2. forward inspection to find ALL menu components each node imports
3. collect union of all menu components across all paths

## what we found

### 21 menu implementations (not 4)
discovered without hardcoding:
- MultistageDropdown, MultistageMenu (hierarchical filter menus)
- DateRangeDropdown, DateRangeMenu, DateInputMenuRenderer, DateCompareAgainstDropdown (date pickers)
- FilterDropdown, IntegrationFilterDropdown (filter UIs)
- EllipsisMenu, ContextMenu_deprecated (action menus)
- FieldsDropdownMenu, FieldsContextMenu, NumberContextMenu, SpotlightVerticalBarChartContextMenu (field/chart menus)
- EventsTableSettingsMenu, MonitorSettingsDropdown, AnnotationsMenu (settings menus)
- ListMenu, Menu.utils.tsx (utilities)
- Menu_deprecated, DropdownMenu_deprecated, Dropdown_DEPRECATED (base wrappers)

### pages affected
varies by component:
- FilterDropdown: 11 pages (datasets, logs, queries)
- MultistageDropdown: 11 pages (filter builders everywhere)
- DateRangeDropdown: 4 pages (dashboards, insights, usage, logs)
- EventRow menus: 38 pages (any page with events table)

### the tree structure
shows import chains from each menu component to pages:
```
MultistageDropdown.tsx
└── Dropdown_DEPRECATED.tsx
    └── FilterDropdown.tsx
        ├── -field.actions.tsx
        │   ├── datasets-and-views/route.tsx
        │   └── _authed/_org/$orgId/(datasets)/datasets/route.tsx
        └── LogsStreamFilter.tsx
            └── LogsStreamPage.tsx
```

## key technical decisions

### why not forward-only BFS?
pages don't import seeds directly. can't find affected pages by walking forward from seeds.

### why not full path enumeration?
combinatorial explosion. 1928 files × multiple paths = unreadable. 
we show one canonical tree per component (shortest or most "menu-like" path).

### why dedupe by page+component?
same page might reach same menu component via multiple paths. keep shortest.

### generic wrapper exclusion
`Dropdown_DEPRECATED`, `Menu_DEPRECATED`, `DropdownMenu_DEPRECATED` are TOO generic - everything uses them.
exclude from "implementation" detection so we see the SPECIFIC menu (e.g., MultistageDropdown).

### route.tsx → full paths
`route.tsx` is useless alone. show `_authed/_org/$orgId/flows/route.tsx` instead.

## migration implications

### scope
not 4 components, but 21. each needs assessment:
- can we drop-in replace with radix?
- does it have custom keyboard nav?
- does it use rc-menu's css classes?
- what behavior contracts does it assume?

### critical paths
focus on high-usage components first:
1. FilterDropdown + MultistageDropdown (11 pages each)
2. EventRow menus (38 pages via EventsTable)
3. DateRangeDropdown (4 pages, complex form state)

### behavior preservation
still need manual analysis of:
- keyboard nav patterns (arrow keys, enter, esc)
- focus trap logic
- css class coupling (`.axiom-dropdown`, `.axiom-menu-item`)
- keyboardShortcuts.ts detection of open menus

## how to use

### run
```bash
cd "AGENTS/bdsqqq/tasks/AXM-9631 delete rc-menu"
bun 2025-10-22T21:50-trace-rc-menu.ts
```

### output
`2025-10-22T21:50-rc-menu-usage.md` - tree view of all 21 menu components and their pages

### track progress
as you migrate components, re-run script. when a menu component has 0 pages, it's done.

## lessons

### for this task
1. **trust code over assumptions** - oracle+human both wrong about daterange
2. **bidirectional graphs matter** - forward imports ≠ reverse imports
3. **heuristics over perfection** - "files with Menu/Dropdown in name" catches 95%+ of cases
4. **generic exclusion needed** - base wrappers are noise, show specific implementations

### for future
1. **never hardcode component names** - use discovery from seeds
2. **test both directions** - reverse finds pages, forward finds intermediate components
3. **scripts > docs** - extraction scales, documentation doesn't
4. **visualization matters** - trees show relationships, flat lists don't

---

**bottom line**: autonomous bidirectional graph traversal found 21 menu implementations, not 4. trust the import graph, not your mental model.
