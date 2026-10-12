---
name: Deep Current
description: A bilingual black intelligence terminal for comparing strong Hyperliquid traders and configuring a personal workspace.
colors:
  terminal-black: "#000000"
  panel: "#050505"
  panel-raised: "#0a0a0a"
  hairline: "rgba(148, 163, 184, .15)"
  text-primary: "#f3f6fa"
  text-muted: "#8d99aa"
  signal-cyan: "#5ee3dc"
  signal-cyan-deep: "#19bcb8"
  loss-red: "#ff6888"
  warning-amber: "#ffc466"
typography:
  intro:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "48px"
    fontWeight: 550
    lineHeight: 1
    letterSpacing: "-0.035em"
  intro-mobile:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 550
    lineHeight: 1
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "normal"
  body:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.08em"
  data:
    fontFamily: "Geist Mono, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "normal"
rounded:
  badge: "4px"
  compact: "6px"
  control: "7px"
  chart: "8px"
  surface: "10px"
  feature: "12px"
  full: "999px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  surface:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.surface}"
    padding: "16px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.control}"
    size: "34px"
  compact-action:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.compact}"
    padding: "0 9px"
    height: "32px"
  control-field:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "36px"
  nav-selected:
    backgroundColor: "rgba(94, 227, 220, .07)"
    textColor: "{colors.signal-cyan}"
    typography: "{typography.body}"
    rounded: "{rounded.compact}"
    padding: "0 12px"
    height: "36px"
  status-chip:
    backgroundColor: "transparent"
    textColor: "{colors.signal-cyan}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 10px"
    height: "30px"
  side-badge-gain:
    backgroundColor: "rgba(94, 227, 220, .09)"
    textColor: "{colors.signal-cyan}"
    typography: "{typography.label}"
    rounded: "{rounded.badge}"
    height: "21px"
    width: "46px"
  side-badge-loss:
    backgroundColor: "rgba(255, 104, 136, .09)"
    textColor: "{colors.loss-red}"
    typography: "{typography.label}"
    rounded: "{rounded.badge}"
    height: "21px"
    width: "46px"
---

# Design System: Deep Current

## Overview

**Creative North Star: "The Curated Intelligence Terminal"**

Deep Current is a compact intelligence terminal for a curated set of strong traders. It should feel black, flat, dense, restrained, and built for repeated professional use: the interface gets out of the way while evidence, comparisons, live actions, and personal controls remain immediately scannable.

The visual system expresses confidence through disciplined hierarchy rather than decoration. The turquoise ribbon mark is the primary identity asset, while cyan is reserved for positive, live, and selected states. Account/Profile is a first-class destination for every user, gathering identity, language, favorites, 56 personal workspace preferences, and Telegram notifications; Admin is an additional privileged destination, never a replacement for the user profile. Oversized pill controls, inflated card dashboards, excessive gradients, glass effects, and loose spacing are explicit anti-references.

**Key Characteristics:**

- A true-black canvas with near-black terminal surfaces separated by hairline rules.
- Compact controls and dense data rows with clear alignment.
- Cyan for verified positive, live, or selected states; red for loss.
- Geist for interface language and Geist Mono for financial data.
- Complete Russian and English interface language modes.
- A universal Account/Profile area, with Admin revealed only to verified administrators.
- The turquoise ribbon mark remains intact and is never replaced by a letterform.

## Colors

The palette is a true-black field with cold near-black surfaces and scarce, semantic signals rather than decorative color.

### Primary

- **Signal Cyan** (`colors.signal-cyan`): Positive P&L, live status, selected navigation, active chart states, and small moments of confirmed emphasis.
- **Deep Signal Cyan** (`colors.signal-cyan-deep`): A supporting cyan for controlled emphasis and brand-adjacent detail; it must not become a second decorative accent.

### Secondary

- **Loss Red** (`colors.loss-red`): Negative P&L, short or loss states, and the negative half of performance charts.
- **Warning Amber** (`colors.warning-amber`): Warnings and leverage/risk cues that need attention without implying a loss.

### Neutral

- **Terminal Black** (`colors.terminal-black`): The page canvas and Telegram chrome color.
- **Instrument Panel** (`colors.panel`): The standard container surface.
- **Raised Control** (`colors.panel-raised`): Inputs and slightly differentiated controls within a panel.
- **Hairline Slate** (`colors.hairline`): Borders, dividers, table rules, and structural separation.
- **Primary Ink** (`colors.text-primary`): High-priority labels, headings, and values.
- **Muted Slate** (`colors.text-muted`): Supporting copy, timestamps, metadata, and inactive controls.

### Named Rules

**The Signal Color Rule.** Cyan means positive, live, or selected; red means loss. Neither color is general decoration.

**The Black Field Rule.** Keep the canvas and Telegram chrome pure black; build hierarchy with adjacent near-black tones and hairline rules, not bright cards or ornamental color blocks.

## Typography

**Display Font:** Geist (with system-ui fallback)  
**Body Font:** Geist (with system-ui fallback)  
**Label/Mono Font:** Geist Mono (with monospace fallback)

**Character:** Neutral, compact, and technical without becoming sterile in either Russian or English. Prose stays quiet; numbers gain precision and column stability through the monospaced face.

### Hierarchy

- **Headline** (600, 24px, 1.25): Page-level trader and wallet headings; use sparingly and never as oversized marketing display type.
- **Title** (600, 14px, 1.25): Panel headings, trader names, and section anchors.
- **Body** (400, 12px, 1.5): Supporting explanations, notes, and compact control text.
- **Label** (600, 10px, 0.08em letter-spacing): Table headings, small state labels, and metadata; uppercase only where scanning benefits.
- **Data** (500, 12px, 1.25): Currency, percentages, addresses, timestamps, and chart values.

### Named Rules

**The Data Has a Different Voice Rule.** Financial values and addresses use Geist Mono; explanatory language stays in Geist.

**The No Hero Type Rule.** This is an operating terminal, so headings establish hierarchy without displacing data from the first viewport. The one exception is the transient 2.5-second brand intro, which uses the dedicated intro scale.

**The Two-Language Rule.** Russian and English use the same hierarchy, density, and component geometry; changing language must not create a visually privileged mode.

## Layout

Use a fluid centered workspace capped at 1500–1540px. Page gutters are compact on phones (12px) and expand only to 20–24px on larger screens. The dashboard uses a dense primary column plus a 340px evidence rail at wide layouts; wallet detail uses a 250px statistics rail beside the performance workspace. Account/Profile uses a focused workspace capped at 896px, with its primary account panel and a 320px language/status rail on large screens. The personal settings surface is a right-hand drawer capped at 430px and becomes full-width on phones. Vertical rhythm is based on 4px increments, with 12–16px as the default panel and row spacing.

Desktop tables prioritize aligned numeric columns and short row heights. On small screens, the same evidence is reorganized into stacked rows, paired metrics, horizontally scrollable tapes, and an equal-width bottom navigation rather than diluted or removed. The five universal destinations are Overview, Traders, Activity, Favorites, and Account/Profile. Admin is appended only for verified administrators, so the mobile bar must accommodate either five or six equal items without hiding a user destination. Settings categories may scroll horizontally, but critical controls and the save action stay reachable.

**The Scan Before Scroll Rule.** The first viewport should reveal identity, market context, the strongest comparison evidence, and live state without oversized controls or decorative whitespace.

**The Access Hierarchy Rule.** Account/Profile belongs to everyone; Admin is an extra authenticated destination and must never occupy or displace the profile slot.

## Elevation & Depth

The system is flat by default. Depth comes from tonal layering and low-contrast hairline borders, not ambient card shadows. Shadows are reserved for chart tooltips, drawers, dialogs, comparison bars, and transient feedback that must separate from dense data; the sticky app header and sticky settings tabs may use restrained background blur for legibility, but ordinary panels never become glass.

### Shadow Vocabulary

- **Chart Marker** (`0 4px 16px rgba(0,0,0,.35)`): Small event-count markers over the graph.
- **Chart Tooltip** (`0 12px 30px rgba(0,0,0,.38)`): Read-only hover detail over plotted data.
- **Chart Detail** (`0 14px 36px rgba(0,0,0,.46)`): The selected event group that must sit clearly above the chart.
- **Settings Drawer** (`-24px 0 70px rgba(0,0,0,.4)`): Separates the personal settings workspace from the terminal without brightening its surface.
- **Modal Panel** (`0 28px 90px rgba(0,0,0,.55)`): Comparison and command surfaces that temporarily sit above the full application.

### Named Rules

**The Flat-by-Default Rule.** Resting surfaces use tone and borders; shadow appears only when a transient chart layer needs functional separation.

## Shapes

Geometry is compact and controlled. Direction badges use tight 4px corners; compact actions and settings tabs use 6px; fields and segmented settings controls use 7px; charts use 8px; standard panels use 10px; feature containers use 12px. Full pills are limited to status, switches, and compact metadata chips. Circular forms are reserved for avatars, live dots, risk indicators, and switch handles.

**The Compact Instrument Rule.** A radius describes component scale and purpose; it never turns every control or container into a large soft pill.

## Components

### Buttons

- **Shape:** Compact actions use restrained corners (`rounded.compact`); icon buttons use a 34px square with `rounded.control`.
- **Primary:** The core terminal does not rely on a large promotional primary button. Inline actions use muted text and transparent backgrounds.
- **Hover / Focus:** Hover adds a faint tonal fill and promotes text to white or semantic cyan. Keyboard focus uses a 2px cyan outline with a 3px offset.
- **Selected tabs:** Active states use cyan text and a very faint cyan wash; mobile navigation uses a 1px cyan top indicator.

### Chips

- **Style:** Status and metadata chips use hairline borders, restrained dark fills, and compact type. Direction badges use tight corners, not pills.
- **State:** Selected, live, and gain states use cyan; loss and short states use red; neutral metadata remains white or muted.

### Cards / Containers

- **Corner Style:** Standard dashboard panels use `rounded.surface`; wallet feature containers use `rounded.feature`.
- **Background:** Panels sit one or two tonal steps above Terminal Black.
- **Shadow Strategy:** Flat at rest; see Elevation & Depth for the chart-only exceptions.
- **Border:** One-pixel Hairline Slate borders and dividers provide the structure.
- **Internal Padding:** Dense rows use 12–16px; larger wallet headers may use 20–28px.

### Inputs / Fields

- **Style:** Raised Control background, Hairline Slate border, `rounded.control`, 36px minimum height, and 11px horizontal padding.
- **Focus:** The global cyan outline remains visible; internal inputs do not suppress the field's accessible focus treatment.
- **Error / Disabled:** Use semantic red for invalid or loss-related meaning and muted slate for unavailable controls; do not encode state through opacity alone.
- **Toggles:** Use a compact 30×17px track. The checked state uses a faint cyan track and cyan handle; unchecked stays dark slate.
- **Segmented controls:** Use a dark shared container with compact 32px options; the selected option receives the same faint cyan wash as active navigation.

### Navigation

Desktop navigation is a compact horizontal row within the 64px sticky header. Mobile navigation becomes a fixed equal-width bottom bar with safe-area padding. Overview, Traders, Activity, Favorites, and Account/Profile are always present; Admin is appended only when the verified Telegram session has administrator access. Inactive items are muted, hover promotes them to Primary Ink, and the active item uses Signal Cyan plus the smallest possible positional cue. Labels switch between Russian and English without changing icon order or information architecture.

### Account / Profile

The universal Account/Profile destination is a compact identity and control hub, not a promotional profile page. It combines the Telegram identity or local-device fallback, favorite count, Telegram connection state, notification state, and active language in a bordered summary panel. Rows for personal settings, favorites, Telegram notifications, and—only for administrators—the Admin panel use a 68px minimum height, quiet supporting copy, and a single trailing icon. Language selection sits in the adjacent rail and applies immediately across every screen.

### Personal Settings Drawer

The right-hand drawer groups 56 personal workspace preferences under General, Interface, Ranking, and Feed, with a fifth Telegram section for 10 notification settings. Category tabs remain sticky and horizontally scrollable. Controls reuse existing fields, switches, segmented choices, and market toggles; do not invent a separate settings aesthetic. The full-width save action remains visible at the bottom, and Telegram-backed users receive synchronized preferences while local users retain an explicit device-storage state.

### Telegram Notifications

Notification settings use the same compact form language as the rest of the terminal. They cover enablement, open/close/flip filtering, position additions and reductions, minimum notional, coin allow-list, quiet hours, confluence-only alerts, and notification timezone. Connection state is visible in Account/Profile; unavailable Telegram linkage is explained in neutral copy rather than presented as an error.

### Trader Data Row

The trader row is the signature comparison unit: rank, compact identity, monospaced financial columns, and a small favorite action. Desktop uses a fixed analytical grid; mobile preserves the identity first, then pairs metrics below it. Hover changes only the background tone and trader-name color, keeping the row stable.

### Performance Chart

The chart uses cyan above the zero baseline and red below it, with faint semantic area fills used only to explain the data. Grid lines remain subordinate. Metric, range, and marker-density controls are compact segmented controls; keyboard navigation and readable focus states are part of the component.

## Do's and Don'ts

### Do:

- **Do** keep the first viewport dense with trader identity, comparable evidence, and live state.
- **Do** use cyan only for positive, live, or selected states, and red for losses or negative performance.
- **Do** use hairline borders and neighboring dark tones to organize panels, rows, tables, and charts.
- **Do** keep financial values and wallet addresses in Geist Mono.
- **Do** preserve the turquoise ribbon logo's shape and proportions as the primary brand mark.
- **Do** maintain the same complete workflow on phone and desktop through reflow and scrolling.
- **Do** keep Account/Profile available to every user in both desktop and bottom navigation.
- **Do** reveal Admin only after verified administrator access, as an additional destination.
- **Do** keep all interface, settings, status, empty-state, and error copy complete in both Russian and English.
- **Do** use the shared compact control vocabulary across all 56 personal preferences and Telegram notifications.

### Don't:

- **Don't** create oversized pill buttons, giant controls, or inflated dashboard cards.
- **Don't** use decorative gradients; chart area gradients are allowed only when they encode positive and negative performance.
- **Don't** use glass effects on ordinary surfaces or substitute shadow for structural borders.
- **Don't** loosen spacing until the interface reads like a marketing dashboard instead of an intelligence terminal.
- **Don't** spend cyan on ornamental accents, neutral actions, or arbitrary emphasis.
- **Don't** replace the ribbon mark with initials, a monogram, or a generic crypto symbol.
- **Don't** merge Account/Profile and Admin or hide personal settings behind administrator access.
- **Don't** introduce a light theme, gray page canvas, or language-specific visual hierarchy; the product is black in both RU and EN.
