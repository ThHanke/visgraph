---
name: Layout selector integration
description: Custom layout algorithms (Dagre horizontal/vertical, ELK layered/force/stress) need to be wired into Reactodia's layout system and exposed via hamburger menu
type: project
---

Custom layout selector needs to be added to the Reactodia hamburger menu.

**Why:** The old TopBar had a layout popover with Dagre and ELK layout options (LayoutManager.ts), but after migrating to Reactodia the `handleLayoutChange` just runs Reactodia's `defaultLayout`. The Reactodia bottom toolbar Layout button only re-executes the default layout, it doesn't let users pick an algorithm.

**How to apply:** Wire LayoutManager's algorithms (horizontal/vertical Dagre, ELK layered/force/stress) into Reactodia's layout worker system, then add layout selection items to the DefaultWorkspace hamburger menu. Check `LayoutManager.ts` and `elkLayoutConfig.ts` for the existing algorithm definitions.
