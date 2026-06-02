# WissensHub Graph — Kritische Funktionen

Diese Datei dokumentiert alle essentiellen Graph-Funktionen.
**NICHT LÖSCHEN** — der Pre-commit-Hook prüft deren Existenz.

## Initialisierung
- `initKnowledgeGraph()` — Entry point, Canvas setup, Partikel, Events
- `_buildHierarchicalLayout()` — Berechnet alle Knoten-Positionen
- `_makeNode(id,type,label,color,r,tx,ty,px,py,revealAt,extra)` — Knoten-Fabrik
- `_initParticles()` / `_drawParticles()` — Hintergrund-Partikel

## Render-Loop
- `_graphLoop()` — requestAnimationFrame Loop
- `_springTick()` — Spring-Animation + Kollisionsvermeidung
- `_draw(ctx)` — Haupt-Render: BG, Edges, Nodes
- `_drawIconNode(ctx, n, isHover)` — Icon-Node (FA + weißer Kreis)
- `_drawDocCard(ctx, n, isHover, z)` — Floating-Text bei tiefem Zoom

## Zoom / Pan
- `_animZoom(targetZ, cx, cy)` — GSAP-animierter Zoom
- `_fitToRoots(setBase)` — Übersicht auf alle Root-Ordner
- `_updateZoomLabel()` / `_updateLevelIndicator()`

## Events
- `_attachGraphEvents(canvas)` — Wheel, Mouse, Touch Events
- `_handleNodeClick(node, e)` — Klick → Zoom / Navigation
- `_showContextPanel(node, sx, sy)` — Hover-Info-Panel
- `_showContextPanelDelayed(node, sx, sy)` — 280ms Delay
- `_hideContextPanel()` / `_hideContextPanelDelayed()` — Panel verstecken

## UI
- `_updateMinimap()` — Minimap-Canvas
- `_setupResize(wrap)` — ResizeObserver
- `_loadDocContent()` — Markdown für Level-4-Zoom laden

## Stop
- `stopGraph()` — Loop + GSAP stoppen, Panel verstecken

## Analyse-Modi (Toggle)
- `window.toggleGraphMode(mode)` — 'hubs'|'gaps'|'semantic'|'timeline'
- `_applyHubMode()` / `_applyGapMode()` / `_applySemanticMode()` / `_applyTimelineMode()`
