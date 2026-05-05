---
name: Analytical Data System
colors:
  surface: '#f9f9f9'
  surface-dim: '#dadada'
  surface-bright: '#f9f9f9'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3f3'
  surface-container: '#eeeeee'
  surface-container-high: '#e8e8e8'
  surface-container-highest: '#e2e2e2'
  on-surface: '#1b1b1b'
  on-surface-variant: '#58413e'
  inverse-surface: '#303030'
  inverse-on-surface: '#f1f1f1'
  outline: '#8b716d'
  outline-variant: '#dfbfbb'
  surface-tint: '#a63a25'
  primary: '#350300'
  on-primary: '#ffffff'
  primary-container: '#5a0900'
  on-primary-container: '#e96c53'
  inverse-primary: '#ffb4a5'
  secondary: '#865300'
  on-secondary: '#ffffff'
  secondary-container: '#feb14e'
  on-secondary-container: '#714500'
  tertiary: '#141717'
  on-tertiary: '#ffffff'
  tertiary-container: '#292b2b'
  on-tertiary-container: '#919292'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdad3'
  primary-fixed-dim: '#ffb4a5'
  on-primary-fixed: '#3e0400'
  on-primary-fixed-variant: '#852311'
  secondary-fixed: '#ffddb9'
  secondary-fixed-dim: '#ffb961'
  on-secondary-fixed: '#2b1700'
  on-secondary-fixed-variant: '#663e00'
  tertiary-fixed: '#e2e2e2'
  tertiary-fixed-dim: '#c6c6c7'
  on-tertiary-fixed: '#1a1c1c'
  on-tertiary-fixed-variant: '#454747'
  background: '#f9f9f9'
  on-background: '#1b1b1b'
  surface-variant: '#e2e2e2'
typography:
  display:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  heading:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-base:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
  code-base:
    fontFamily: monospace
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  container-padding: 1.5rem
  cell-padding-x: 0.75rem
  cell-padding-y: 0.5rem
  gutter: 1rem
  sidebar-width: 240px
---

## Brand & Style

This design system is engineered for precision, high-velocity analysis, and technical rigor. It targets data engineers, analysts, and developers who require a low-latency visual experience where information density is prioritized over decorative whitespace. 

The aesthetic has evolved into a **High-Contrast Modern** style. It utilizes a "border-first" architecture to define structure, but now incorporates a more aggressive and authoritative color palette of oxblood and amber. The emotional response is one of intense focus and clinical accuracy, providing users with a "cockpit" feel for their data operations, now softened slightly by rounded geometric touches for a more contemporary finish.

## Colors

The palette is anchored by a **Deep Oxblood** and **Pure Black** foundation to establish a professional, high-stakes institutional feel. **Oxblood** serves as the primary action color, providing a distinct and powerful focal point for interactive elements against the stark neutral tones.

Navigation elements use **Black** to create a clear structural hierarchy, separating the global controls from the content area. For data auditing and SQL versioning, specific semantic tokens use high-contrast variants, ensuring changes are immediately visible against the new warm-toned primary elements. **Amber** is used as a secondary accent to draw attention to warnings or active status indicators.

## Typography

This design system utilizes **Inter** for all UI elements to maximize legibility at small sizes, which is critical for data-heavy applications. The typographic scale is compact, favoring efficiency over large display sizes.

A dedicated monospace stack is reserved for SQL editors, data previews, and diffing views. To maintain a clear hierarchy in dense interfaces, labels should often utilize the `label-caps` style with increased letter spacing to distinguish metadata from user-generated data, standing out clearly against the bold primary color accents.

## Layout & Spacing

The design system employs a **fluid grid** model tailored for expansive dashboard views and wide data tables. The layout is structured around a persistent black sidebar, with a main content area that expands to fill the viewport.

Spacing is based on a strict 4px baseline grid. High-density layouts should prioritize the 4px and 8px units for internal component spacing to maximize the "above the fold" information. Horizontal alignment is critical; elements must align to the grid borders to maintain the analytical feel even with the new rounded shape language.

## Elevation & Depth

This design system utilizes **High-contrast outlines** and **Tonal layering**. Depth is communicated through surface color shifts and subtle shadows that complement the rounded edges.

1.  **Level 0 (Background):** Pure White or high-brightness neutral.
2.  **Level 1 (Card/Surface):** White with a 1px border (Black at 10% opacity).
3.  **Level 2 (Popovers/Modals):** White with a 1px Oxblood border and a tight, defined shadow to separate critical overlays from the data grid.

Borders remain the primary tool for separation. All containers, headers, and section dividers must use 1px solid strokes to define the workspace.

## Shapes

The geometric signature of this design system is **Rounded and Modern**. To balance the bold color palette and high-density information, all containers, cards, input fields, and data cells utilize an **8px (rounded-md)** border radius.

This shift from sharp corners reinforces a more approachable, modern technical aesthetic without sacrificing the professional rigor of the system. Buttons and interactive elements maintain this **8px** radius to stay consistent with the structural elements of the UI.

## Components

### Buttons
Primary buttons use the Oxblood base with white text and an 8px border radius. Secondary buttons should be high-contrast outlines or Amber-filled to distinguish between different action types.

### SQL Diff Viewers
The diff viewer is a high-density component.
- **Added lines:** Background tinted with secondary amber-gold with a left-aligned 2px solid accent.
- **Removed lines:** Background using the error-red tint with a left-aligned 2px solid accent.
- **Text:** Always use the monospace stack at 13px.

### Data Tables
Tables are the core of this design system. 
- **Headers:** Oxblood or Black background, bold 12px white text, 1px bottom border.
- **Rows:** 8px rounded corners on selection/hover, 1px bottom border. 
- **Density:** Cell padding should not exceed 8px vertically.

### Input Fields
Inputs must have an 8px radius with a 1px Black or Dark Gray border. On focus, the border transitions to Oxblood with a clear high-contrast focus indicator.

### Navigation
The sidebar uses a dark neutral background (Black). Active states use an Amber indicator on the far left or an Amber tint on the menu item to provide a high-visibility active state.