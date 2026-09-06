# Jiawang Cross-Platform Design System

## Purpose

Jiawang is a high-frequency order workspace. Customer shopping, order follow-up, courier actions, and administrator operations use the same visual language so status, price, quantity, and primary action can be scanned without changing business behavior.

## Visual Direction

Industrial and utilitarian. The product uses warm orange only to direct attention to commercial actions, a cool neutral surface for dense order information, and explicit semantic colors for delivery, warnings, and errors. It does not use marketing hero layouts, decorative gradients, or large floating cards.

## Tokens

| Role | Web token | Value | Mini program equivalent |
| --- | --- | --- | --- |
| Primary action | `--jw-brand` | `#E9681A` | `--jw-brand` |
| Pressed action | `--jw-brand-strong` | `#C95312` | `--jw-brand-strong` |
| Action background | `--jw-brand-soft` | `#FFF3E9` | `--jw-brand-soft` |
| Page background | `--background` | `#F4F6F8` | `--jw-page` |
| Surface | `--jw-surface` | `#FFFFFF` | `--jw-surface` |
| Primary text | `--foreground` | `#1F2933` | `--jw-text` |
| Secondary text | `--jw-muted` | `#66737F` | `--jw-muted` |
| Border | `--jw-border` | `#E3E8EC` | `--jw-border` |
| Success | `--jw-success` | `#16805C` | `--jw-success` |
| Warning | `--jw-warning` | `#B97916` | `--jw-warning` |
| Error | `--jw-danger` | `#C54132` | `--jw-danger` |

Typography is based on the operating system Chinese font stack. Titles are 20/18/16px on Web and 40/32/28rpx on the mini program; supporting text uses 14/12px and 26/24rpx. Monetary and count data use tabular figures when supported.

## Components and States

- Controls use an 8px radius, a 44px minimum Web target, and an 88rpx minimum mini-program primary target.
- Primary actions are orange; secondary actions are white with a neutral border; destructive actions retain explicit red text/background.
- Cards use a white surface, one neutral border, restrained shadow, and 16-24px / 24rpx padding depending on density.
- Loading preserves layout space, empty states use a centered short explanation, and errors combine copy with the error color rather than color alone.
- Selected filters use the orange soft background and brand text. Disabled controls use a gray surface plus `not-allowed` feedback rather than opacity only.
- Web focus rings are always visible for keyboard use. Mini-program controls preserve generous touch targets, safe-area spacing, and fixed bottom navigation/composers.

## Responsive Rules

Desktop administration keeps a navigation rail and independently scrolling list/detail work areas. Narrow Web layouts collapse into one column and use card rows for tables. Mini-program pages reserve a fixed top information region and bottom navigation, with product, order, address, and message content scrolling independently.
