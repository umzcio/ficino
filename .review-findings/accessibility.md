# Accessibility Review Findings (WCAG 2.1 AA)

## HIGH (6 blocking)

### 1. Non-semantic Button: User Avatar in ComposeBox
- frontend/src/components/Feed/ComposeBox.tsx:36-40
- `<div onClick>` with no role/tabindex. WCAG 4.1.2

### 2. Non-semantic Button: Persona Panel Clickable Divs
- frontend/src/components/Sidebar/PersonaPanel.tsx:19-22
- WCAG 4.1.2, 2.1.1

### 3. No Focus Trap/Return in Figure Lightbox
- frontend/src/components/Feed/PostCard.tsx:31-62 (FigureLightbox)
- Only handles Escape; no focus trap. WCAG 2.4.3, 2.4.8

### 4. @mention Dropdown Lacks Combobox Semantics
- frontend/src/components/Feed/PostCard.tsx:1031-1055
- Missing role="combobox", aria-expanded, aria-activedescendant. WCAG 1.3.1, 4.1.3

### 5. No aria-live for Typing Indicator / Optimistic Sends
- PostCard.tsx:949-965 — typing indicator + ComposeBox optimistic post. WCAG 4.1.3

### 6. Gold Color Contrast Failure on Dark Background
- frontend/src/index.css:7 (#c8a96e on #080a0f ≈ 3.8:1)
- Light-mode gold ~4.2:1 borderline. WCAG 1.4.3

## MEDIUM-HIGH (4)

### 7. Three-Dots Menu Missing aria-haspopup/role="menu"
- PostCard.tsx:401-496

### 8. Placeholder Text Contrast at 50% Opacity
- ComposeBox.tsx:58, PostCard.tsx:1019 — `placeholder:text-text-muted/50` ≈ 2.8:1. WCAG 1.4.3

### 9. Muted Metadata Color Fails AA
- index.css:10 (#7a8194 on #080a0f ≈ 3.1:1)

### 10. Tab Inactive Color Contrast
- index.css:24 (#555d6e on #080a0f ≈ 2.8:1)

## MEDIUM (11)

### 11. Feed Posts Not in Semantic List
- frontend/src/components/Feed/Feed.tsx:110-138 — no `<ol role="feed">` wrapper.

### 12. No Skip Link
- App.tsx — no "Skip to main content"

### 13. Heading Hierarchy Inconsistent
- Multiple <h1> in SettingsView, Inbox, AlertsView

### 14. FeedTabs No Arrow-Key Handler
- App.tsx:238-260 — role="tab" present but no left/right keyboard nav.

### 15. Mobile Drawer/Bottom Sheet No Focus Trap
- components/Nav/MobileDrawer.tsx:41, WorkspaceBottomSheet.tsx:28

### 16. Avatar Alt Text Inconsistent
- PostCard.tsx:75-80, 847

### 17. Focus Indicator May Be Faint in Light Mode
- index.css:70-78 — outline uses gold, light-mode gold may be low-contrast on white.

### 18. Form Inputs Lack Labels (placeholder-only)
- ComposeBox.tsx:47-60, PostCard.tsx:980-1019. WCAG 3.3.2

### 19. Toggle Component Lacks aria-label
- components/Settings/primitives.tsx:47-62

### 20. Mobile Bottom Nav Touch Targets May Be <44px
- App.tsx:108-133 — `py-2.5` may not meet 2.5.5

### 21. Reduced-Motion Doesn't Cover animate-spin
- index.css:81-87 — Lucide Loader2 icons still spin.

## LOW-MEDIUM (4)

### 22. Three-Dots Menu Container Missing role="menu"
- PostCard.tsx:411

### 23. Icon-only Buttons Inconsistent aria-label
- components/Nav/CorpusPanel.tsx:54 (good), others inconsistent.

### 24. Mobile Logo img onClick Not Keyboard-Accessible
- App.tsx:180-185

### 25. Toast Lacks aria-live
- PostCard.tsx:1064-1068
