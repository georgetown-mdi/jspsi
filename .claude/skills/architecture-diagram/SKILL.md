---
name: architecture-diagram
description: Create or revise a component-level architecture diagram of psilink -- a hand-laid-out SVG grounded in code, passed through design and fidelity reviews, delivered as the docs image (docs/img/architecture.svg), a shareable page, or a print PNG. Use for requests like "diagram the components", "show how the pieces connect", or "update the architecture diagram".
---

# Architecture Diagram

Produce a component diagram a senior engineer can absorb in one look: the minimum set of components, the open-source libraries they build on, and how they connect. The method is three phases -- ground, compose, verify. Each phase caught real errors the first time this was done (a TURN server that does not exist, an inverted crypto/transport layering, a missing shipping subsystem); do not skip one.

## Altitude rule

One diagram, one altitude. Default altitude: the workspaces, their major components, the seams (interfaces core defines and apps implement), and the external/trust boundary. Name a library on a node only when it is correctness- or security-load-bearing (docs/spec/DEPENDENCY_PINS.md is the roster; @openmined/psi.js, @noble/curves, re2js, ssh2-sftp-client, PeerJS rank; yargs does not). No wire formats, no per-module detail -- that is docs/spec territory. Label everything exactly once: no text repeated between a lane title, a group header, a node, and an edge.

## Phase 1: ground every element in code

- Trust code over docs. Read package.json files for the dependency graph, the module a label names before drawing it, and the Dockerfile before claiming how anything ships. docs/spec on the current integration branch is the cross-check, not the source.
- Keep a per-node file citation list while working; every box and edge must trace to a file. A node you cannot cite is a node you cannot draw.
- Classes of error to re-check every revision: infrastructure the docs promise but the code lacks; deployment groupings (what actually ships together); decorator/wrapper layer order (who wraps whom -- read the constructor, not the prose); library attributions on crypto and parsing nodes; subsystems added since the diagram was last touched.

## Phase 2: compose by hand, never auto-layout

Auto-layout (Mermaid/dagre) cannot hold a designed layout for this topology; the apps are a hub with core on one side and the external world on the other, and one cross-cluster edge wrecks the ranking. Hand-author SVG with fixed coordinates.

- Three lanes: CORE LIBRARY | APPLICATIONS - THIS MACHINE | EXTERNAL. Apps in the middle; call edges go left into core, channel edges go right to the outside. The counterparty is one tall dashed column labeled "same stack, mirrored", never a duplicated stack.
- Visual grammar (keep the legend able to physically show each distinction):
  - stroke color = lane (blue core, teal apps, amber external); edges stay a quiet neutral
  - solid arrow = call / data flow; both apps merge into a single trunk landing on the runExchange node
  - dotted arrow = app implements a core seam
  - dotted line, no arrowhead = connection setup (signaling, NAT traversal), never the data path
  - double-headed = two-party channel; dashed border = external / across the trust boundary
- Section eyebrows inside core (DATA PIPELINE / SECURE CHANNEL / DISCLOSURE) carry grouping; nodes carry a title plus a mono sub-label holding the identifier or library name.
- An arrow means what it touches: land call-flow on the entry-point node, not on box borders or empty header space. Give parallel rails inside a box real separation (10px+ apart, 10px+ from the border).

## Phase 3: verify with independent passes

Run these as separate fresh-context reviews (subagents), not self-checks:

1. Render and screenshot, then a design critique on the image: landing points, orphan stubs, legend/drawing mismatches, cramped rails, anything that reads as a rendering speck.
2. A fresh-eyes engineer read-back: write down what the diagram alone claims, then verify each claim against code, then against docs/spec; report contradictions at this altitude only. Where a spec and the drawing disagree, flag it -- do not silently prefer either.
3. Re-render after every geometry change; SVG edits that look right in source routinely collide in render.

## Outputs

- Repo (source of truth): docs/img/architecture.svg -- self-contained (internal <style>, no external fonts or CSS vars), background rect, embedded legend, ASCII-only labels per repo convention. Referenced from the System architecture section at the end of docs/README.md. Edit this SVG directly on revisions; keep coordinates on the existing grid.
- Shareable page: wrap the same SVG in a theme-aware HTML page (tokens on :root, dark overrides) when an artifact or standalone page is wanted.
- Print PNG: render the page with headless Chrome -- window-size at the target aspect, force-device-scale-factor for resolution (e.g. 1000x1200 at 3x = 3000x3600 for 10x12in at 300ppi) -- then stamp the DPI metadata (System.Drawing SetResolution on Windows, ImageMagick -density elsewhere; Chrome writes none).
