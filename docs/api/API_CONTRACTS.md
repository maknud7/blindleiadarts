# API Contract Direction

## Rules

- frontends call only the internal API
- responses should be stable and versionable
- connector payloads should be translated before leaving connector boundaries
- match engine endpoints should reflect local domain state, not upstream provider shapes

## Likely API Areas

- kiosk assignment and current-state endpoints
- visit registration endpoints
- match lifecycle endpoints
- rankings endpoints
- screen display endpoints
- admin management endpoints
- connector import and sync endpoints

## Response Design Guidance

- use explicit status fields for match and sync state
- include stable internal IDs
- keep external IDs inside connector/admin workflows only when needed
- prefer additive evolution over breaking response changes
