# Future Member Portal And Club Operations

## Why This Matters Now

The project is expanding from a venue runtime into a broader club platform.

Over time the same system should be able to replace the current scattered setup for:

- tournament participation
- player self-service
- personal statistics
- member payments
- grasrotandel follow-up
- bookkeeping support

We do not need to migrate those areas immediately, but we should avoid painting ourselves into a corner.

## Future User Capabilities

### Player / Member Self-Service

- sign in with a personal account
- see upcoming tournaments
- register or unregister for tournaments
- view match history
- view averages, checkout stats, and ELO
- view membership status and payment status

### Club Administration

- manage members and roles
- track membership payments
- follow up grasrotandel and other income sources
- record bookkeeping-related entries or exports
- reconcile tournament fees and member payments

## Recommended Product Surfaces

In the longer term the platform should likely have four surfaces instead of three:

- kiosk
- public screen
- admin
- member portal

The member portal can start as a lightweight web area under the same API before becoming a fuller application.

## Recommended Domain Separation

### Tournament Runtime

- optimized for live venue reliability
- should not depend on accounting or member management

### Member Domain

- account, profile, membership, permissions
- registration workflows
- personal statistics

### Club Operations Domain

- payments
- income tracking
- grasrotandel
- bookkeeping support

Keep these connected through internal IDs and services, but do not collapse them into one large generic table design.

## Recommended Near-Term Preparation

Even before implementation, future work should assume:

- `Player` and `MemberProfile` may become related but are not always identical
- tournament signup should be modeled separately from imported participants
- statistics should be snapshot-driven where useful
- finance records should live in their own tables and services
- authentication and authorization should be designed before the member portal is exposed publicly

## Suggested Roadmap Addition

### Milestone 5 - Member Portal Basics

- login
- member profile
- tournament registration
- personal statistics

### Milestone 6 - Club Operations

- membership payments
- grasrotandel tracking
- bookkeeping support
- operational reports and exports

## Practical Rule

Build the live tournament engine first, but keep naming, schema planning, and app boundaries ready for the larger club platform that follows.
